import { createHash } from "node:crypto";
import { z } from "zod";
import { actionInputSchema, cardSchema, type ActionInput, type CallPayload, type CaptainCall, type DeckCard, type NativeRow, type SourceRef } from "./contract";

/** JSON object ordering is not part of an operation's identity. */
export function canonical(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });
  if (encoded === undefined) throw new Error("Expected a JSON value");
  return encoded;
}

export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function callId(taskId: string, generation: number): string {
  return `call:${hash(`${taskId}:${generation}`).slice(0, 32)}`;
}

const legacyDecisionSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().nullable().default(null) }).strict()),
  recommendedId: z.string().nullable(), context: z.string().nullable(), askedAt: z.string(),
  answeredAt: z.string().nullable(), answerId: z.string().nullable(), answerLabel: z.string().nullable(), answerNote: z.string().nullable(),
}).strict();
const legacyCardSchema = z.object({
  id: cardSchema.shape.id, title: cardSchema.shape.title, brief: z.string().nullable(), kind: cardSchema.shape.kind,
  state: cardSchema.shape.state, threadId: z.string().nullable(), projectId: z.string().nullable(), bot: z.string().nullable(),
  prUrl: z.string().nullable(), note: z.string().nullable(), decision: legacyDecisionSchema.nullable(),
  history: z.array(legacyDecisionSchema).default([]), createdAt: z.string(), updatedAt: z.string(), landedAt: z.string().nullable(),
}).strict();

/** Validate the whole old aggregate before the first SQL write; never truncate old content. */
export function normalizeLegacyCards(value: unknown): DeckCard[] {
  const cards = z.array(legacyCardSchema).parse(value ?? []);
  const ids = new Set<string>();
  return cards.map((old) => {
    if (ids.has(old.id)) throw new Error(`Duplicate legacy task ${old.id}`);
    ids.add(old.id);
    // 0.3.1 treated a decision as waiting only in the decision lane; a card the
    // first mate moved on carries an abandoned question, not a new ask.
    const convert = (decision: z.infer<typeof legacyDecisionSchema>, generation: number, current: boolean): CaptainCall => ({
      id: callId(old.id, generation), generation, kind: "DECIDE", ask: decision.question, recommendation: null,
      options: decision.options, recommendedId: decision.recommendedId, context: decision.context, evidence: [], approvalScope: null,
      status: decision.answeredAt !== null ? "answered" : current && old.state === "decision" ? "open" : "dismissed",
      source: null, replyThreadId: null, replyAfterSeq: 0, provenance: "legacy",
      askedAt: decision.askedAt, answeredAt: decision.answeredAt, answerId: decision.answerId, answerLabel: decision.answerLabel,
      answerNote: decision.answerNote, deferUntil: null,
    });
    const { decision, history, ...fields } = old;
    const generations = history.length + (decision === null ? 0 : 1);
    return cardSchema.parse({ ...fields, call: decision === null ? null : convert(decision, generations, true),
      history: history.map((entry, index) => convert(entry, history.length - index, false)), revision: 1,
      nextGeneration: generations + 1, seenGeneration: 0, pendingCall: null });
  });
}

export function renderCallBlock(taskId: string, generation: number, payload: CallPayload): string {
  const lines = [`[Captain's Deck ${taskId} generation ${generation}]`, `Kind: ${payload.kind}`, `Task: ${taskId}`, `Call generation: ${generation}`, `Ask: ${payload.ask}`];
  if (payload.recommendation !== null) lines.push(`Recommendation: ${payload.recommendation}`);
  for (const option of payload.options) {
    lines.push(`Option ${option.id}${option.id === payload.recommendedId ? " (recommended)" : ""}: ${option.label}`);
    if (option.detail !== null) lines.push(`Detail: ${option.detail}`);
  }
  if (payload.context !== null) lines.push(`Context: ${payload.context}`);
  for (const evidence of payload.evidence) lines.push(`Evidence: ${evidence.label} — ${evidence.url ?? `thread ${evidence.threadId}${evidence.rowId ? ` / row ${evidence.rowId}` : ""}`}`);
  if (payload.approvalScope !== null) {
    lines.push(`Approval action: ${payload.approvalScope.action}`, `Target: ${payload.approvalScope.target}`, `Constraints: ${payload.approvalScope.constraints}`);
    if (payload.approvalScope.expiresAt !== undefined) lines.push(`Expires: ${new Date(payload.approvalScope.expiresAt).toISOString()}`);
    lines.push("Approval records this exact scope; it does not execute it.");
  }
  return lines.join("\n");
}

export function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId && a.rowId === b.rowId &&
    a.sourceSeqStart === b.sourceSeqStart && a.sourceSeqEnd === b.sourceSeqEnd && a.contentSha256 === b.contentSha256;
}

export function sourceRef(row: SourceRef): SourceRef {
  return { threadId: row.threadId, turnId: row.turnId, rowId: row.rowId, sourceSeqStart: row.sourceSeqStart,
    sourceSeqEnd: row.sourceSeqEnd, contentSha256: row.contentSha256 };
}

/** This is evidence classification, not a claim of keyboard-human authority. */
export function validateResponseSource(input: ActionInput, row: NativeRow, threadId: string | null, afterSeq?: number): void {
  if (input.action !== "answer" || !input.source || !sameSource(input.source, row)) throw new Error("Response source identity does not match");
  if (row.role !== "user" || !row.completed || row.initiator !== "user" || row.senderThreadId !== null || row.visibility !== null) {
    throw new Error("Select an original committed user response, not an agent-only or forwarded row");
  }
  if (threadId === null || row.threadId !== threadId || (input.threadId !== undefined && input.threadId !== row.threadId)) throw new Error("Response is from the wrong thread");
  if (!Number.isSafeInteger(row.sourceSeqStart) || !Number.isSafeInteger(row.sourceSeqEnd) || row.sourceSeqEnd < row.sourceSeqStart ||
    (afterSeq !== undefined && row.sourceSeqStart <= afterSeq)) throw new Error("Response precedes the call boundary");
  if (!Number.isFinite(row.createdAt) || row.createdAt < 0 || hash(row.text) !== row.contentSha256 || input.response !== row.text) throw new Error("Response content changed");
}

export function isUnresolved(call: CaptainCall): boolean {
  return call.status === "open" || call.status === "deferred";
}

/** Shared board/panel/chat policy. Reopen copies stored data, not the new-creation schema. */
export function applyCallAction(call: CaptainCall, raw: ActionInput, now: number, sourceCreatedAt: number | null): { call: CaptainCall; terminal: boolean; reopen: boolean } {
  const input = actionInputSchema.parse(raw);
  if (input.source && input.action !== "answer") throw new Error("Only answers accept a response source");
  const option = input.optionId == null ? undefined : call.options.find((candidate) => candidate.id === input.optionId);
  if (input.optionId != null && option === undefined) throw new Error("Unknown answer option");
  if (input.action !== "answer" && (input.optionId != null || input.response !== undefined || input.decision !== undefined)) throw new Error("Answer fields are only valid on answer");
  if (input.action !== "defer" && input.deferUntil !== undefined) throw new Error("Only defer accepts a defer date");
  if (input.action === "reopen") {
    if (isUnresolved(call)) throw new Error("Only closed calls can be reopened");
    return { call: { ...call, status: "open", answeredAt: null, answerId: null, answerLabel: null, answerNote: null, deferUntil: null }, terminal: false, reopen: true };
  }
  if (!isUnresolved(call)) throw new Error("Call is already closed");
  if (input.action === "answer") {
    if (input.response !== undefined && !input.response.trim()) throw new Error("Response must not be blank");
    if (call.kind === "APPROVE") {
      if (!input.decision || !call.approvalScope) throw new Error("APPROVE requires approve or decline and its exact scope");
      if (sourceCreatedAt !== null && /^(?:I\s+)?(approve|decline)[.!]*$/i.exec(input.response?.trim() ?? "")?.[1]?.toLowerCase() !== input.decision) {
        throw new Error("Native approval needs an unqualified approve or decline as the whole response; conditional text stays open");
      }
      if (option && option.id.toLowerCase() !== input.decision && option.label.trim().toLowerCase() !== input.decision) throw new Error("Approval option and decision disagree");
      const expiresAt = call.approvalScope.expiresAt;
      if (input.decision === "approve" && expiresAt !== undefined && (sourceCreatedAt ?? now) >= expiresAt) throw new Error("Approval scope has expired");
    } else {
      if (input.decision !== undefined) throw new Error("Only APPROVE accepts approve or decline");
      if (!option && input.response === undefined) throw new Error("Answer with an option or a nonblank response");
    }
    const terminal = call.kind !== "DO";
    return { call: { ...call, status: terminal ? "answered" : call.status,
      answeredAt: terminal ? new Date(now).toISOString() : null,
      answerId: input.decision ?? option?.id ?? "freeform", answerLabel: input.decision ?? option?.label ?? input.response!.slice(0, 200),
      answerNote: input.response ?? null, deferUntil: terminal ? null : call.deferUntil }, terminal, reopen: false };
  }
  if (input.action === "defer") {
    if (input.deferUntil === undefined || (input.deferUntil !== null && input.deferUntil <= now)) throw new Error("Defer requires an explicit future timestamp or null");
    return { call: { ...call, status: "deferred", deferUntil: input.deferUntil }, terminal: false, reopen: false };
  }
  if (input.action === "complete" && call.kind !== "DO") throw new Error("Complete is only available for DO calls");
  return { call: { ...call, status: input.action === "complete" ? "completed" : "dismissed", answeredAt: new Date(now).toISOString(), deferUntil: null }, terminal: true, reopen: false };
}
