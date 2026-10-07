import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { NativeRow, SourceDetail, SourceRef } from "./contract";

type Sdk = BbPluginApi["sdk"];
// The public SDK exposes these results through sdk, but does not export their names.
type AsyncResult<F> = F extends (...args: never[]) => Promise<infer Result> ? Result : never;
type Event = AsyncResult<Sdk["threads"]["events"]["list"]>[number];
type Timeline = AsyncResult<Sdk["threads"]["timeline"]>;
type Row = Timeline["rows"][number];
type Turn = Extract<Row, { kind: "turn" }>;
type Conversation = Extract<Row, { kind: "conversation" }>;
type Requested = Extract<Event, { type: "client/turn/requested" }>;
type Accepted = Extract<Event, { type: "turn/input/accepted" }>;
export type TurnState = "active" | "completed" | "failed" | "interrupted" | "missing";

const PAGE_SIZE = 100;
const MAX_PAGES = 32;
const MAX_ROWS = 10_000;
const MAX_TEXT = 16_000;
const PROVENANCE_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"] as const;
const TURN_BOUNDARY_TYPES = ["turn/started", "turn/completed"] as const;

function sequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_source_sequence");
}
function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function validRow(row: Conversation): boolean {
  return row.turnId !== null && Number.isSafeInteger(row.sourceSeqStart) && row.sourceSeqStart >= 0
    && Number.isSafeInteger(row.sourceSeqEnd) && row.sourceSeqEnd >= row.sourceSeqStart;
}

function* conversations(rows: readonly Row[]): Generator<Conversation> {
  for (const row of rows) {
    if (row.kind === "conversation") yield row;
    else if (row.kind === "turn" && row.children) yield* conversations(row.children);
    // Never traverse delegation childRows: they belong to another thread.
  }
}

/**
 * Public BB history only. The timeline serves conversation rows directly and
 * collapses older turns into summary rows, so both shapes are read and an
 * unavailable exact source is never replaced by a nearby row.
 */
export class NativeEvidenceReader {
  constructor(private readonly sdk: Sdk) {}

  async nativeThread(threadId: string): Promise<{ threadId: string; projectId: string; title: string; available: boolean }> {
    let projectId = "";
    let title = "";
    try {
      const thread = await this.sdk.threads.get({ threadId });
      projectId = thread.projectId;
      title = thread.title ?? thread.titleFallback ?? thread.id;
      if (thread.id !== threadId || thread.archivedAt !== null || thread.deletedAt !== null || thread.visibility !== "visible") return { threadId, projectId, title, available: false };
      const project = await this.sdk.projects.get({ projectId });
      if (project.id !== projectId || (project.kind !== "personal" && project.kind !== "standard")) return { threadId, projectId, title, available: false };
      if (thread.environmentId !== null) {
        const environment = await this.sdk.environments.get({ environmentId: thread.environmentId });
        if (environment.id !== thread.environmentId || environment.projectId !== projectId || environment.status !== "ready" || environment.lifecycle.phase !== "active" || environment.hostLifecycle !== "active") return { threadId, projectId, title, available: false };
      }
      return { threadId, projectId, title, available: true };
    } catch {
      // Missing/deleted/inaccessible native resources all disable the binding.
      return { threadId, projectId, title, available: false };
    }
  }

  private async requireThread(threadId: string): Promise<void> {
    if (!(await this.nativeThread(threadId)).available) throw new Error("native_thread_unavailable");
  }

  async highWater(threadId: string): Promise<number> {
    await this.requireThread(threadId);
    const events = await this.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    if (!events.length) return 0;
    const event = events[0]!;
    if (event.threadId !== threadId) throw new Error("native_event_thread_mismatch");
    sequence(event.seq);
    return event.seq;
  }

  /** The newest turn boundary; a running turn has no timeline row until its first item. */
  private async turnBoundary(threadId: string, turnId?: string): Promise<{ turnId: string; startSeq: number; state: TurnState } | null> {
    let beforeSeq: number | undefined;
    let completion: Extract<Event, { type: "turn/completed" }> | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const events = await this.sdk.threads.events.list({ threadId, order: "desc", limit: String(PAGE_SIZE), types: TURN_BOUNDARY_TYPES, ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) });
      for (const event of events) {
        sequence(event.seq);
        if (event.threadId !== threadId || (beforeSeq !== undefined && event.seq >= beforeSeq)) throw new Error("native_event_cursor_invalid");
        beforeSeq = event.seq;
        if (event.scope.kind !== "turn" || (turnId !== undefined && event.scope.turnId !== turnId)) continue;
        if (event.type === "turn/completed") {
          if (turnId === undefined && completion === null) completion = event;
          if (turnId !== undefined) completion ??= event;
          continue;
        }
        if (completion !== null && completion.scope.kind === "turn" && completion.scope.turnId !== event.scope.turnId) return null;
        const state: TurnState = completion === null ? "active"
          : completion.data.status === "completed" ? "completed"
          : completion.data.status === "interrupted" ? "interrupted" : "failed";
        return { turnId: event.scope.turnId, startSeq: event.seq, state };
      }
      if (events.length < PAGE_SIZE) break;
    }
    return null;
  }

  async captureTurn(threadId: string): Promise<{ turnId: string; afterSeq: number }> {
    await this.requireThread(threadId);
    const before = await this.turnBoundary(threadId);
    if (!before || before.state !== "active") throw new Error("origin_active_turn_unavailable");
    const afterSeq = await this.highWater(threadId);
    const after = await this.turnBoundary(threadId);
    if (!after || after.state !== "active" || after.turnId !== before.turnId || after.startSeq !== before.startSeq) throw new Error("origin_active_turn_changed");
    return { turnId: after.turnId, afterSeq };
  }

  private async summaryRows(threadId: string, turn: Turn): Promise<Conversation[]> {
    const rows: Conversation[] = [];
    let cursor: string | undefined;
    let snapshot: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const detail = await this.sdk.threads.timelineTurnSummaryDetails({ threadId, turnId: turn.turnId, sourceSeqStart: String(turn.sourceSeqStart), sourceSeqEnd: String(turn.sourceSeqEnd), ...(cursor ? { beforeCursor: cursor } : {}) });
      if (snapshot !== undefined && detail.historySnapshot !== undefined && snapshot !== detail.historySnapshot) throw new Error("native_history_changed");
      snapshot ??= detail.historySnapshot;
      for (const row of conversations(detail.rows)) {
        if (row.threadId !== threadId || row.turnId !== turn.turnId) continue;
        rows.push(row);
        if (rows.length > MAX_ROWS) throw new Error("source_lookup_too_large");
      }
      if (!detail.olderCursor) return rows;
      cursor = detail.olderCursor;
      if (seen.has(cursor)) throw new Error("native_details_cursor_stalled");
      seen.add(cursor);
    }
    throw new Error("source_lookup_too_large");
  }

  /** Every committed conversation row at or after `fromSeq`, oldest first. */
  private async rowsFrom(threadId: string, fromSeq: number): Promise<Conversation[]> {
    sequence(fromSeq);
    const collected = new Map<string, Conversation>();
    let cursor: { anchorId: string; anchorSeq: number } | null = null;
    let snapshot: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const timeline: Timeline = await this.sdk.threads.timeline({ threadId, segmentLimit: String(PAGE_SIZE), includeNestedRows: "false", ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
      const history = timeline.timelinePage.historySnapshot;
      if (snapshot !== undefined && history !== undefined && snapshot !== history) throw new Error("native_history_changed");
      snapshot ??= history;
      let oldest = Number.POSITIVE_INFINITY;
      for (const row of timeline.rows) {
        if (row.kind !== "conversation" && row.kind !== "turn") continue;
        if (row.threadId !== threadId) continue;
        oldest = Math.min(oldest, row.sourceSeqStart);
        // Delegation child rows belong to another conversation and stay excluded.
        const rows = row.kind === "conversation" ? [row] : await this.summaryRows(threadId, row);
        for (const candidate of rows) {
          if (!validRow(candidate) || candidate.sourceSeqEnd < fromSeq) continue;
          const existing = collected.get(candidate.id);
          if (existing && (existing.text !== candidate.text || existing.sourceSeqStart !== candidate.sourceSeqStart || existing.sourceSeqEnd !== candidate.sourceSeqEnd || existing.role !== candidate.role)) throw new Error("native_history_changed");
          collected.set(candidate.id, candidate);
          if (collected.size > MAX_ROWS) throw new Error("source_lookup_too_large");
        }
      }
      if (!timeline.timelinePage.hasOlderRows || oldest <= fromSeq) break;
      cursor = timeline.timelinePage.olderCursor;
      if (!cursor) throw new Error("native_timeline_incomplete");
      const key = `${cursor.anchorSeq}:${cursor.anchorId}`;
      if (seenCursors.has(key)) throw new Error("native_timeline_cursor_stalled");
      seenCursors.add(key);
      if (page + 1 === MAX_PAGES) throw new Error("source_lookup_too_large");
    }
    return [...collected.values()].sort((left, right) => left.sourceSeqStart - right.sourceSeqStart || left.id.localeCompare(right.id));
  }

  private async provenanceEvents(threadId: string, start: number, end: number): Promise<Event[]> {
    let afterSeq = Math.max(0, start - 1);
    const result: Event[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const events = await this.sdk.threads.events.list({ threadId, afterSeq: String(afterSeq), beforeSeq: String(end + 1), order: "asc", limit: String(PAGE_SIZE), types: PROVENANCE_TYPES });
      for (const event of events) {
        sequence(event.seq);
        if (event.threadId !== threadId || event.seq <= afterSeq) throw new Error("native_event_cursor_invalid");
        afterSeq = event.seq;
      }
      result.push(...events);
      if (events.length < PAGE_SIZE) return result;
    }
    throw new Error("source_provenance_too_large");
  }

  /** BB's own classification of a committed row, never proof of a keyboard human. */
  private nativeRow(row: Conversation, completed: boolean, events: Event[]): NativeRow {
    let initiator: string | null = null;
    let senderThreadId: string | null = null;
    let visibility: string | null = null;
    if (row.role === "user") {
      const requests = events.filter((event): event is Requested => event.type === "client/turn/requested" && event.seq >= row.sourceSeqStart && event.seq <= row.sourceSeqEnd);
      if (requests.length !== 1) throw new Error("source_request_provenance_missing");
      const request = requests[0]!;
      const accepted = events.some((event): event is Accepted => event.type === "turn/input/accepted" && event.data.clientRequestId === request.data.requestId && event.seq > request.seq);
      if (!accepted || row.turnRequest?.status !== "accepted") throw new Error("source_input_not_accepted");
      if (request.data.initiator !== row.initiator || request.data.senderThreadId !== row.senderThreadId) throw new Error("source_author_changed");
      initiator = request.data.initiator;
      senderThreadId = request.data.senderThreadId;
      const inputs = request.data.inputGroups?.flat() ?? request.data.input;
      visibility = inputs.some((input) => input.visibility === "agent-only") ? "agent-only" : null;
      if (request.data.systemMessageKind && request.data.systemMessageKind !== "unlabeled") visibility = "system";
      completed = true;
    }
    return { threadId: row.threadId, turnId: row.turnId!, rowId: row.id, sourceSeqStart: row.sourceSeqStart, sourceSeqEnd: row.sourceSeqEnd, contentSha256: hash(row.text), text: row.text, role: row.role, createdAt: row.createdAt, initiator, senderThreadId, completed, visibility };
  }

  async turnRows(threadId: string, turnId: string): Promise<{ rows: NativeRow[]; state: TurnState; complete: boolean }> {
    await this.requireThread(threadId);
    const boundary = await this.turnBoundary(threadId, turnId);
    if (!boundary) return { rows: [], state: "missing", complete: true };
    const rows = (await this.rowsFrom(threadId, boundary.startSeq)).filter((row) => row.turnId === turnId);
    const users = rows.filter((row) => row.role === "user" && row.turnRequest?.status === "accepted");
    const end = boundary.state === "active" ? await this.highWater(threadId) : Math.max(boundary.startSeq, ...rows.map((row) => row.sourceSeqEnd));
    const events = users.length ? await this.provenanceEvents(threadId, Math.min(...users.map((row) => row.sourceSeqStart)), end) : [];
    const nativeRows = rows.filter((row) => row.role === "assistant" || row.turnRequest?.status === "accepted").map((row) => this.nativeRow(row, boundary.state === "completed", events));
    return { rows: nativeRows, state: boundary.state, complete: boundary.state !== "active" };
  }

  async source(ref: SourceRef, offset = 0, limit = MAX_TEXT): Promise<SourceDetail> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TEXT) throw new Error("invalid_source_page");
    sequence(ref.sourceSeqStart);
    sequence(ref.sourceSeqEnd);
    const empty = (status: "missing" | "changed" | "too-large"): SourceDetail => ({ status, ref, text: "", nextOffset: null, totalLength: 0, sourceCreatedAt: null });
    if (ref.sourceSeqEnd < ref.sourceSeqStart || !ref.threadId || !ref.turnId || !ref.rowId || !/^[0-9a-f]{64}$/u.test(ref.contentSha256)) return empty("missing");
    if (!(await this.nativeThread(ref.threadId)).available) return empty("missing");
    let rows: Conversation[];
    try {
      rows = await this.rowsFrom(ref.threadId, ref.sourceSeqStart);
    } catch (error) {
      if (error instanceof Error && error.message === "source_lookup_too_large") return empty("too-large");
      if (error instanceof Error && error.message === "native_history_changed") return empty("changed");
      return empty("missing");
    }
    const matches = rows.filter((row) => row.id === ref.rowId && row.turnId === ref.turnId && row.sourceSeqStart === ref.sourceSeqStart && row.sourceSeqEnd === ref.sourceSeqEnd);
    if (matches.length !== 1) return empty("missing");
    const row = matches[0]!;
    if (hash(row.text) !== ref.contentSha256) return empty("changed");
    const nextOffset = offset + limit < row.text.length ? offset + limit : null;
    return { status: "verified", ref, text: row.text.slice(offset, offset + limit), nextOffset, totalLength: row.text.length, sourceCreatedAt: row.createdAt };
  }

  async forwardRows(threadId: string, afterSeq: number, limit = PAGE_SIZE): Promise<{ rows: NativeRow[]; nextSeq: number; hasMore: boolean }> {
    sequence(afterSeq);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new Error("invalid_evidence_limit");
    await this.requireThread(threadId);
    const candidates = (await this.rowsFrom(threadId, afterSeq + 1)).filter((row) => row.role === "user" && row.sourceSeqStart > afterSeq && row.turnRequest?.status === "accepted");
    if (!candidates.length) return { rows: [], nextSeq: afterSeq, hasMore: false };
    // Acceptance is recorded after the row itself, so read through the newest event.
    const events = await this.provenanceEvents(threadId, candidates[0]!.sourceSeqStart, Math.max(candidates[candidates.length - 1]!.sourceSeqEnd, await this.highWater(threadId)));
    const page = candidates.slice(0, limit);
    return { rows: page.map((row) => this.nativeRow(row, true, events)), nextSeq: page[page.length - 1]!.sourceSeqEnd, hasMore: candidates.length > limit };
  }

  async original(ref: SourceRef): Promise<NativeRow> {
    await this.requireThread(ref.threadId);
    sequence(ref.sourceSeqStart);
    sequence(ref.sourceSeqEnd);
    if (ref.sourceSeqEnd < ref.sourceSeqStart) throw new Error("invalid_source_range");
    // The committed user request precedes turn/started. Look up its own exact
    // range, not the later provider-turn boundary used for assistant publication.
    const rows = await this.rowsFrom(ref.threadId, ref.sourceSeqStart);
    const matches = rows.filter((row) => row.id === ref.rowId && row.turnId === ref.turnId && row.sourceSeqStart === ref.sourceSeqStart && row.sourceSeqEnd === ref.sourceSeqEnd);
    if (matches.length !== 1) throw new Error("source_missing_or_ambiguous");
    const row = matches[0]!;
    if (hash(row.text) !== ref.contentSha256) throw new Error("source_changed");
    if (row.role === "user") {
      const events = await this.provenanceEvents(ref.threadId, ref.sourceSeqStart, Math.max(ref.sourceSeqEnd, await this.highWater(ref.threadId)));
      return this.nativeRow(row, true, events);
    }
    const boundary = await this.turnBoundary(ref.threadId, ref.turnId);
    return this.nativeRow(row, boundary?.state === "completed", []);
  }

  /** Reconcile only a receipt's exact notice marker; never infer an answer. */
  async notice(threadId: string, marker: string, since: number): Promise<{ state: "sent" | "queued" | "failed" | "uncertain"; queueId: string | null; error: string | null }> {
    await this.requireThread(threadId);
    const queue = await this.sdk.threads.queuedMessages.list({ threadId });
    const queued = queue.filter((entry) => entry.threadId === threadId && entry.content.some((input) => input.type === "text" && input.visibility === "agent-only" && input.text.startsWith(`${marker}\n`)));
    if (queued.length > 1) return { state: "uncertain", queueId: null, error: "Duplicate notices in the native queue; inspect them before retrying." };
    if (queued.length === 1) return { state: "queued", queueId: queued[0]!.id, error: queued[0]!.failureReason };
    let beforeSeq: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const events = await this.sdk.threads.events.list({ threadId, order: "desc", limit: String(PAGE_SIZE), types: ["client/turn/requested"], ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) });
      if (!events.length) break;
      for (const event of events) {
        sequence(event.seq);
        if (event.threadId !== threadId || (beforeSeq !== undefined && event.seq >= beforeSeq)) throw new Error("native_event_cursor_invalid");
        beforeSeq = event.seq;
        if (event.createdAt < since) return { state: "uncertain", queueId: null, error: "The notice was not found in native history after it was recorded; it may still have been delivered." };
        if (event.type !== "client/turn/requested" || !event.data.input.some((input) => input.type === "text" && input.visibility === "agent-only" && input.text.startsWith(`${marker}\n`))) continue;
        const following = await this.provenanceEvents(threadId, event.seq, await this.highWater(threadId));
        if (following.some((next) => next.type === "turn/input/accepted" && next.data.clientRequestId === event.data.requestId)) return { state: "sent", queueId: null, error: null };
        if (following.some((next) => next.type === "client/turn/rejected" && next.data.requestId === event.data.requestId)) return { state: "failed", queueId: null, error: "Native dispatch rejected the notice." };
        return { state: "uncertain", queueId: null, error: "A native request exists but its acceptance is unconfirmed; a retry may duplicate it." };
      }
      if (events.length < PAGE_SIZE) break;
    }
    return { state: "uncertain", queueId: null, error: "The notice was not found in bounded native history; a retry may duplicate it." };
  }
}
