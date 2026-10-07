import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { actionInputSchema, callPayloadSchema, cancelCommandSchema, cardSchema, callsInputSchema, deliverySchema, idSchema, pageInputSchema, receiptSchema, snapshotSchema, sourceRefSchema, versionSchema,
  type ActionInput, type CallPayload, type CaptainCall, type CardsPage, type CallsInput, type DeckCard, type DeckSnapshot, type Delivery, type NativeRow, type Receipt, type SourceRef } from "./contract";
import { applyCallAction, callId, canonical, hash, normalizeLegacyCards, renderCallBlock, sameSource, sourceRef, validateResponseSource } from "./model";

/** Shipped entries are immutable: append a new statement for subsequent changes. */
export const migrations: string[] = [
  `CREATE TABLE deck_cards (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL,
    call_status TEXT, call_generation INTEGER, defer_until INTEGER, seen_generation INTEGER NOT NULL,
    pending_state TEXT
  );
  CREATE TABLE deck_receipts (
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL,
    source_thread TEXT, source_row TEXT,
    UNIQUE(task_id, source_thread, source_row)
  );
  CREATE INDEX deck_receipts_task ON deck_receipts(task_id, id);
  CREATE INDEX deck_cards_attention ON deck_cards(call_status, defer_until, id);
  CREATE INDEX deck_cards_pending ON deck_cards(pending_state, id);
  CREATE TABLE deck_generations (task_id TEXT PRIMARY KEY, next_generation INTEGER NOT NULL);
  CREATE TABLE deck_commands (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE deck_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE deck_cards ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
  UPDATE deck_cards SET updated_at=json_extract(data,'$.updatedAt');
  CREATE INDEX deck_cards_recent ON deck_cards(updated_at DESC, id DESC);
  ALTER TABLE deck_receipts ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
  UPDATE deck_receipts SET created_at=json_extract(data,'$.createdAt');
  CREATE INDEX deck_receipts_recent ON deck_receipts(task_id, created_at DESC, id DESC);`,
];

export interface ActionContext { provenance: Receipt["provenance"]; sourceRow?: NativeRow; notifyThreadId: string | null }
export interface NewTask { title: string; brief?: string | null; kind?: "ship" | "scout"; projectId?: string | null; bot?: string | null; threadId?: string | null }
export type TaskPatch = Partial<Pick<DeckCard, "title" | "brief" | "state" | "threadId" | "projectId" | "bot" | "prUrl" | "note" | "landedAt">>;
const patchSchema = cardSchema.pick({ title: true, brief: true, state: true, threadId: true, projectId: true, bot: true, prUrl: true, note: true, landedAt: true }).partial().extend({ title: z.string().min(1).optional() }).strict();
const cursorSchema = z.object({ version: z.literal(1), view: z.string(), sortKey: z.string(), after: z.string(), asOf: z.number().int().nonnegative() }).strict();
type JsonRow = { data: string };

export class DeckStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  findTask(id: string): DeckCard | null {
    const row = this.db.prepare("SELECT data FROM deck_cards WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? cardSchema.parse(JSON.parse(row.data)) : null;
  }

  getTask(id: string): DeckCard {
    const task = this.findTask(id);
    if (!task) throw new Error(`No deck task with id ${id}`);
    return task;
  }

  private assertWritable(task: DeckCard, expectedRevision?: number): void {
    if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new Error("Stale card revision; refresh before changing it");
    if (task.pendingCall?.state === "pending") throw new Error("Card has a pending native call publication");
  }

  private saveTask(task: DeckCard): DeckCard {
    const parsed = cardSchema.parse(task);
    this.db.prepare(`INSERT INTO deck_cards(id,data,revision,call_status,call_generation,defer_until,seen_generation,pending_state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,
      call_status=excluded.call_status,call_generation=excluded.call_generation,defer_until=excluded.defer_until,
      seen_generation=excluded.seen_generation,pending_state=excluded.pending_state,updated_at=excluded.updated_at`).run(parsed.id, JSON.stringify(parsed), parsed.revision,
      parsed.call?.status ?? null, parsed.call?.generation ?? null, parsed.call?.deferUntil ?? null, parsed.seenGeneration, parsed.pendingCall?.state ?? null, parsed.updatedAt);
    this.db.prepare("INSERT INTO deck_generations(task_id,next_generation) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET next_generation=MAX(next_generation,excluded.next_generation)").run(parsed.id, parsed.nextGeneration);
    return parsed;
  }

  private allocate(task: DeckCard): number {
    const row = this.db.prepare("SELECT next_generation AS nextGeneration FROM deck_generations WHERE task_id=?").get(task.id) as { nextGeneration: number } | undefined;
    const generation = Math.max(task.nextGeneration, row?.nextGeneration ?? 1);
    if (!Number.isSafeInteger(generation + 1)) throw new Error("Call generation exhausted");
    task.nextGeneration = generation + 1;
    return generation;
  }

  private installCall(task: DeckCard, payload: CallPayload, generation: number, source: SourceRef | null, replyThreadId: string | null, replyAfterSeq: number, provenance: CaptainCall["provenance"]): void {
    if (task.call) task.history.unshift(task.call);
    task.call = { ...payload, id: callId(task.id, generation), generation, status: "open", source, replyThreadId, replyAfterSeq, provenance,
      askedAt: new Date(this.now()).toISOString(), answeredAt: null, answerId: null, answerLabel: null, answerNote: null, deferUntil: null };
    task.pendingCall = null;
  }

  importLegacy(value: unknown): { imported: number; alreadyImported: boolean } {
    if (this.db.prepare("SELECT 1 FROM deck_metadata WHERE key='legacy-imported'").get()) return { imported: 0, alreadyImported: true };
    const tasks = normalizeLegacyCards(value);
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM deck_metadata WHERE key='legacy-imported'").get()) return { imported: 0, alreadyImported: true };
      for (const task of tasks) {
        if (this.db.prepare("SELECT 1 FROM deck_cards WHERE id=?").get(task.id) || this.db.prepare("SELECT 1 FROM deck_generations WHERE task_id=?").get(task.id)) throw new Error(`Legacy import overlaps task ${task.id}`);
        this.saveTask(task);
      }
      this.db.prepare("INSERT INTO deck_metadata(key,value) VALUES('legacy-imported','1')").run();
      return { imported: tasks.length, alreadyImported: false };
    }).immediate();
  }

  createTask(input: NewTask): DeckCard {
    z.string().min(1).parse(input.title);
    return this.db.transaction(() => {
      let id: string;
      do { id = randomUUID().replaceAll("-", "").slice(0, 16); } while (this.db.prepare("SELECT 1 FROM deck_generations WHERE task_id=?").get(id));
      const timestamp = new Date(this.now()).toISOString();
      return this.saveTask({ id, title: input.title, brief: input.brief?.trim() || null, kind: input.kind ?? "ship", state: "charted", threadId: input.threadId ?? null,
        projectId: input.projectId ?? null, bot: input.bot ?? null, prUrl: null, note: null, call: null, history: [], createdAt: timestamp, updatedAt: timestamp,
        landedAt: null, revision: 1, nextGeneration: 1, seenGeneration: 0, pendingCall: null });
    }).immediate();
  }

  updateTask(id: string, raw: TaskPatch, expectedRevision?: number): DeckCard {
    const patch = patchSchema.parse(raw);
    return this.db.transaction(() => {
      const task = this.getTask(id);
      this.assertWritable(task, expectedRevision);
      return this.saveTask({ ...task, ...patch, revision: task.revision + 1, updatedAt: new Date(this.now()).toISOString() });
    }).immediate();
  }

  removeTask(id: string, expectedRevision?: number): void {
    this.db.transaction(() => {
      this.assertWritable(this.getTask(id), expectedRevision);
      this.db.prepare("DELETE FROM deck_cards WHERE id=?").run(id);
    }).immediate();
  }

  openCall(input: { taskId: string; expectedRevision: number; payload: CallPayload; source: SourceRef | null; replyThreadId: string | null; replyAfterSeq: number; provenance: "native-origin" | "local-cli"; threadId?: string | null }): DeckCard {
    const payload = callPayloadSchema.parse(input.payload);
    const source = input.source === null ? null : sourceRefSchema.parse(input.source);
    const threadId = input.replyThreadId === null ? null : idSchema.parse(input.replyThreadId);
    z.number().int().nonnegative().parse(input.replyAfterSeq);
    z.enum(["native-origin", "local-cli"]).parse(input.provenance);
    if (input.threadId !== undefined && input.threadId !== null) idSchema.parse(input.threadId);
    if (input.provenance === "native-origin" && (!source || threadId !== source.threadId || input.replyAfterSeq < source.sourceSeqEnd)) throw new Error("Native call requires its exact bound source boundary");
    if (input.provenance === "local-cli" && source !== null) throw new Error("Local CLI call cannot invent a native source");
    return this.db.transaction(() => {
      const task = this.getTask(input.taskId);
      this.assertWritable(task, input.expectedRevision);
      if (input.threadId !== undefined) task.threadId = input.threadId;
      this.installCall(task, payload, this.allocate(task), source, threadId, input.replyAfterSeq, input.provenance);
      task.revision += 1;
      task.updatedAt = new Date(this.now()).toISOString();
      return this.saveTask(task);
    }).immediate();
  }

  prepareCall(input: { taskId: string; expectedRevision: number; payload: CallPayload; threadId: string; turnId: string; afterSeq: number }): { task: DeckCard; generation: number; block: string } {
    const payload = callPayloadSchema.parse(input.payload);
    idSchema.parse(input.threadId); idSchema.parse(input.turnId); z.number().int().nonnegative().parse(input.afterSeq);
    return this.db.transaction(() => {
      const task = this.getTask(input.taskId);
      const pending = task.pendingCall;
      if (pending?.state === "pending" && task.revision === input.expectedRevision + 1 && pending.threadId === input.threadId &&
        pending.turnId === input.turnId && pending.afterSeq === input.afterSeq && canonical(pending.payload) === canonical(payload)) {
        return { task, generation: pending.generation, block: pending.block };
      }
      this.assertWritable(task, input.expectedRevision);
      const generation = this.allocate(task);
      const block = renderCallBlock(task.id, generation, payload);
      task.pendingCall = { generation, payload, threadId: input.threadId, turnId: input.turnId, afterSeq: input.afterSeq, block, state: "pending", error: null };
      task.revision += 1;
      task.updatedAt = new Date(this.now()).toISOString();
      return { task: this.saveTask(task), generation, block };
    }).immediate();
  }

  publishCall(taskId: string, generation: number, row: NativeRow, expectedRevision?: number): DeckCard {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new Error("Stale publication revision");
      const pending = task.pendingCall;
      if (!pending || pending.generation !== generation || pending.state !== "pending") throw new Error("No matching pending call");
      sourceRefSchema.parse(sourceRef(row));
      if (!row.completed || row.role !== "assistant" || row.turnId !== pending.turnId || row.threadId !== pending.threadId || row.senderThreadId !== null || row.visibility !== null ||
        row.sourceSeqEnd <= pending.afterSeq || row.sourceSeqEnd < row.sourceSeqStart || row.text.split(pending.block).length !== 2 ||
        row.text.split(`[Captain's Deck ${task.id} generation ${generation}]`).length !== 2 || hash(row.text) !== row.contentSha256 ||
        !Number.isFinite(row.createdAt) || row.createdAt < 0) throw new Error("Native publication row does not match its reservation");
      this.installCall(task, pending.payload, generation, sourceRef(row), row.threadId, row.sourceSeqEnd, "native-origin");
      task.call!.askedAt = new Date(row.createdAt).toISOString();
      task.revision += 1;
      task.updatedAt = new Date(this.now()).toISOString();
      return this.saveTask(task);
    }).immediate();
  }

  failCall(taskId: string, generation: number, error: string, expectedRevision?: number): DeckCard {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new Error("Stale publication revision");
      if (!task.pendingCall || task.pendingCall.generation !== generation || task.pendingCall.state !== "pending") throw new Error("No matching pending call");
      task.pendingCall = { ...task.pendingCall, state: "failed", error: error.slice(0, 2000) };
      task.revision += 1;
      task.updatedAt = new Date(this.now()).toISOString();
      return this.saveTask(task);
    }).immediate();
  }

  cancelCall(taskId: string, generation: number, expectedRevision: number, operationId: string): DeckCard {
    idSchema.parse(operationId); versionSchema.parse(generation); versionSchema.parse(expectedRevision);
    return this.db.transaction(() => {
      const old = this.db.prepare("SELECT data FROM deck_commands WHERE id=?").get(operationId) as JsonRow | undefined;
      if (old) {
        const command = cancelCommandSchema.parse(JSON.parse(old.data));
        if (command.taskId !== taskId || command.generation !== generation || command.expectedRevision !== expectedRevision) throw new Error("Operation ID reused with a different cancellation");
        return command.result;
      }
      if (this.db.prepare("SELECT 1 FROM deck_receipts WHERE operation_id=?").get(operationId)) throw new Error("Operation ID already belongs to an action");
      const result = this.failCall(taskId, generation, "Cancelled", expectedRevision);
      this.db.prepare("INSERT INTO deck_commands(id,data) VALUES(?,?)").run(operationId, JSON.stringify({ operationId, taskId, generation, expectedRevision, result }));
      return result;
    }).immediate();
  }

  applyAction(raw: ActionInput, context: ActionContext): Receipt {
    const input = actionInputSchema.parse(raw);
    receiptSchema.shape.provenance.parse(context.provenance);
    if (context.notifyThreadId !== null) idSchema.parse(context.notifyThreadId);
    if (input.threadId !== undefined && input.threadId !== context.notifyThreadId) throw new Error("Action is scoped to the wrong producer thread");
    if (input.source && input.action !== "answer") throw new Error("Only answers accept sources");
    const selected = context.provenance === "chat-selected" || context.provenance === "producer-selected";
    if (selected !== !!input.source || (!selected && context.sourceRow !== undefined)) throw new Error("Action provenance and source disagree");
    const semantic = { ...input, optionId: input.optionId ?? null };
    return this.db.transaction(() => {
      const old = this.findReceiptByOperation(input.operationId);
      if (old) {
        if (canonical({ ...old.input, optionId: old.input.optionId ?? null }) !== canonical(semantic) || old.provenance !== context.provenance ||
          old.delivery.threadId !== context.notifyThreadId || (context.sourceRow !== undefined && old.sourceCreatedAt !== context.sourceRow.createdAt)) throw new Error("Operation ID reused with different action or evidence");
        if (context.sourceRow !== undefined) validateResponseSource(input, context.sourceRow, old.source!.threadId);
        return old;
      }
      if (this.db.prepare("SELECT 1 FROM deck_commands WHERE id=?").get(input.operationId)) throw new Error("Operation ID already belongs to a cancellation");
      if (selected && context.sourceRow === undefined) throw new Error("Action provenance requires an original response source row");
      const task = this.getTask(input.taskId);
      this.assertWritable(task, input.expectedRevision);
      if (!task.call || task.call.generation !== input.generation) throw new Error("Stale call generation");
      if (selected) {
        validateResponseSource(input, context.sourceRow!, task.call.replyThreadId, task.call.replyAfterSeq);
        if (this.db.prepare("SELECT 1 FROM deck_receipts WHERE task_id=? AND source_thread=? AND source_row=?").get(task.id, input.source!.threadId, input.source!.rowId)) throw new Error("This response row has already been used for this card");
      }
      const timestamp = this.now();
      const result = applyCallAction(task.call, input, timestamp, context.sourceRow?.createdAt ?? null);
      if (result.reopen) {
        task.history.unshift(task.call);
        result.call.generation = this.allocate(task);
        result.call.id = callId(task.id, result.call.generation);
        result.call.askedAt = new Date(timestamp).toISOString();
        // Reopen retains the exact origin but advances past every previously used response.
        const boundary = this.db.prepare("SELECT MAX(json_extract(data,'$.source.sourceSeqEnd')) AS seq FROM deck_receipts WHERE task_id=? AND source_thread IS NOT NULL").get(task.id) as { seq: number | null };
        result.call.replyAfterSeq = Math.max(result.call.replyAfterSeq, boundary.seq ?? 0);
      }
      task.call = result.call;
      if (result.terminal && task.state === "decision" && task.call.provenance === "legacy") task.state = "underway";
      task.revision += 1;
      task.updatedAt = new Date(timestamp).toISOString();
      this.saveTask(task);
      const receipt: Receipt = { id: input.operationId, taskId: task.id, generation: input.generation, fromRevision: input.expectedRevision, toRevision: task.revision,
        input, source: input.source ?? null, sourceCreatedAt: context.sourceRow?.createdAt ?? null, provenance: context.provenance, createdAt: task.updatedAt,
        delivery: { state: context.notifyThreadId === null ? "disabled" : "pending", threadId: context.notifyThreadId, queueId: null, error: null, attempts: 0 } };
      this.db.prepare("INSERT INTO deck_receipts(id,operation_id,task_id,generation,data,source_thread,source_row,created_at) VALUES(?,?,?,?,?,?,?,?)").run(receipt.id, input.operationId, receipt.taskId, receipt.generation, JSON.stringify(receipt), receipt.source?.threadId ?? null, receipt.source?.rowId ?? null, receipt.createdAt);
      return receipt;
    }).immediate();
  }

  findReceiptByOperation(operationId: string): Receipt | null {
    const row = this.db.prepare("SELECT data FROM deck_receipts WHERE operation_id=?").get(operationId) as JsonRow | undefined;
    return row ? receiptSchema.parse(JSON.parse(row.data)) : null;
  }

  getReceipt(id: string): Receipt {
    const row = this.db.prepare("SELECT data FROM deck_receipts WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new Error(`No action receipt with id ${id}`);
    return receiptSchema.parse(JSON.parse(row.data));
  }

  updateDelivery(id: string, patch: Partial<Delivery>): Receipt {
    const parsed = deliverySchema.partial().strict().parse(patch);
    return this.db.transaction(() => {
      const receipt = this.getReceipt(id);
      if (parsed.threadId !== undefined && parsed.threadId !== receipt.delivery.threadId) throw new Error("Receipt notification target is immutable");
      if (parsed.attempts !== undefined && parsed.attempts < receipt.delivery.attempts) throw new Error("Delivery attempts cannot decrease");
      receipt.delivery = deliverySchema.parse({ ...receipt.delivery, ...parsed });
      this.db.prepare("UPDATE deck_receipts SET data=? WHERE id=?").run(JSON.stringify(receipt), id);
      return receipt;
    }).immediate();
  }

  markSeen(taskId: string, generation: number): DeckCard {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task.call || task.call.generation !== generation) throw new Error("Stale call generation");
      task.seenGeneration = Math.max(task.seenGeneration, generation);
      return this.saveTask(task);
    }).immediate();
  }

  /** Keyset pages walk newest first, so an active card never hides behind a later page. */
  private page(input: { cursor?: string; limit?: number }, view: string): { sortKey: string; id: string; asOf: number; limit: number } {
    const parsed = pageInputSchema.parse(input);
    if (!parsed.cursor) return { sortKey: "", id: "", asOf: this.now(), limit: parsed.limit };
    let cursor: z.infer<typeof cursorSchema>;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString("utf8"))); } catch { throw new Error("Invalid page cursor"); }
    if (cursor.view !== view) throw new Error("Cursor belongs to another view");
    return { sortKey: cursor.sortKey, id: cursor.after, asOf: cursor.asOf, limit: parsed.limit };
  }

  private cursor(view: string, asOf: number, sortKey: string, id: string): string {
    return Buffer.from(JSON.stringify({ version: 1, view, sortKey, after: id, asOf })).toString("base64url");
  }

  private cardsPage(input: { cursor?: string; limit?: number }, view: string, filter: string): CardsPage {
    const page = this.page(input, view);
    const rows = this.db.prepare(`SELECT data,updated_at AS sortKey,id FROM deck_cards
      WHERE (@sortKey='' OR updated_at<@sortKey OR (updated_at=@sortKey AND id<@id)) AND (${filter})
      ORDER BY updated_at DESC, id DESC LIMIT @limit`).all({ sortKey: page.sortKey, id: page.id, asOf: page.asOf, limit: page.limit + 1 }) as Array<JsonRow & { sortKey: string; id: string }>;
    const more = rows.length > page.limit;
    const visible = rows.slice(0, page.limit);
    const tasks = visible.map((row) => cardSchema.parse(JSON.parse(row.data)));
    const counts = this.db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(call_status='open' OR (call_status='deferred' AND defer_until IS NOT NULL AND defer_until<=@asOf)),0) attention,
      COALESCE(SUM(call_status IN ('open','deferred')),0) unresolved,
      COALESCE(SUM(call_status IN ('open','deferred') AND seen_generation<call_generation),0) unseen,
      COALESCE(SUM(call_status='deferred'),0) deferred,
      COALESCE(SUM(call_status IN ('answered','dismissed','completed')),0) closed,
      MIN(CASE WHEN call_status='deferred' AND defer_until>@asOf THEN defer_until END) nextDueAt FROM deck_cards`).get({ asOf: page.asOf }) as CardsPage["counts"] & { nextDueAt: number | null };
    const last = visible[visible.length - 1];
    return { tasks, nextCursor: more && last ? this.cursor(view, page.asOf, last.sortKey, last.id) : null,
      serverNow: page.asOf, counts: { total: counts.total, attention: counts.attention, unresolved: counts.unresolved, unseen: counts.unseen, deferred: counts.deferred, closed: counts.closed }, nextDueAt: counts.nextDueAt };
  }

  listBoard(input: { cursor?: string; limit?: number } = {}): CardsPage {
    return this.cardsPage(input, "board", "1");
  }

  listCalls(raw: CallsInput): CardsPage {
    const input = callsInputSchema.parse(raw);
    const filters: Record<CallsInput["view"], string> = { attention: "call_status='open' OR (call_status='deferred' AND defer_until IS NOT NULL AND defer_until<=@asOf)", deferred: "call_status='deferred'", closed: "call_status IN ('answered','dismissed','completed')" };
    return this.cardsPage({ cursor: input.cursor, limit: input.limit }, `calls:${input.threadId}:${input.view}`, filters[input.view]);
  }

  pendingCalls(input: { cursor?: string; limit?: number } = {}): { tasks: DeckCard[]; nextCursor: string | null } {
    const view = "pending";
    const page = this.page(input, view);
    const rows = this.db.prepare(`SELECT data,id FROM deck_cards WHERE pending_state='pending' AND (@after='' OR id>@after) ORDER BY id LIMIT @limit`)
      .all({ after: page.id, limit: page.limit + 1 }) as Array<JsonRow & { id: string }>;
    const visible = rows.slice(0, page.limit);
    const tasks = visible.map((row) => cardSchema.parse(JSON.parse(row.data)));
    const lastPending = visible[visible.length - 1];
    return { tasks, nextCursor: rows.length > page.limit && lastPending ? this.cursor(view, page.asOf, "", lastPending.id) : null };
  }

  listReceipts(taskId: string, input: { cursor?: string; limit?: number } = {}): { receipts: Receipt[]; nextCursor: string | null } {
    const view = `receipts:${taskId}`;
    const page = this.page(input, view);
    const rows = this.db.prepare(`SELECT data,created_at AS sortKey,id FROM deck_receipts
      WHERE task_id=@taskId AND (@sortKey='' OR created_at<@sortKey OR (created_at=@sortKey AND id<@id))
      ORDER BY created_at DESC, id DESC LIMIT @limit`).all({ taskId, sortKey: page.sortKey, id: page.id, limit: page.limit + 1 }) as Array<JsonRow & { sortKey: string; id: string }>;
    const visible = rows.slice(0, page.limit);
    const receipts = visible.map((row) => receiptSchema.parse(JSON.parse(row.data)));
    const lastReceipt = visible[visible.length - 1];
    return { receipts, nextCursor: rows.length > page.limit && lastReceipt ? this.cursor(view, page.asOf, lastReceipt.sortKey, lastReceipt.id) : null };
  }

  exportSnapshot(): DeckSnapshot {
    return this.db.transaction(() => ({ format: "captains-deck" as const, version: 1 as const,
      tasks: (this.db.prepare("SELECT data FROM deck_cards ORDER BY id").all() as JsonRow[]).map((row) => cardSchema.parse(JSON.parse(row.data))),
      receipts: (this.db.prepare("SELECT data FROM deck_receipts ORDER BY id").all() as JsonRow[]).map((row) => receiptSchema.parse(JSON.parse(row.data))),
      generations: this.db.prepare("SELECT task_id AS taskId,next_generation AS nextGeneration FROM deck_generations ORDER BY task_id").all() as { taskId: string; nextGeneration: number }[],
      commands: (this.db.prepare("SELECT data FROM deck_commands ORDER BY id").all() as JsonRow[]).map((row) => cancelCommandSchema.parse(JSON.parse(row.data))) })).deferred();
  }

  importSnapshot(raw: unknown): { imported: number } {
    const snapshot = snapshotSchema.parse(raw);
    const cards = new Map<string, DeckCard>();
    const generations = new Map<string, number>();
    const operations = new Set<string>();
    const receiptIds = new Set<string>();
    const sources = new Set<string>();
    for (const task of snapshot.tasks) {
      if (cards.has(task.id)) throw new Error("Duplicate snapshot task");
      cards.set(task.id, task);
    }
    // Cancellation replay snapshots obey the same stored-card invariants as live cards.
    for (const task of [...snapshot.tasks, ...snapshot.commands.map((command) => command.result)]) {
      const calls = [...task.history, ...(task.call ? [task.call] : [])];
      const used = new Set<number>();
      for (const call of calls) {
        if (used.has(call.generation)) throw new Error("Duplicate call generation");
        used.add(call.generation);
        if ((call.provenance === "legacy" || call.provenance === "local-cli") && call.source !== null) throw new Error("Snapshot invented a call source");
        if (call.provenance === "native-origin" && (!call.source || call.replyThreadId !== call.source.threadId || call.source.sourceSeqEnd < call.source.sourceSeqStart || call.replyAfterSeq < call.source.sourceSeqEnd)) throw new Error("Invalid native call boundary");
        if (call.provenance !== "legacy") {
          callPayloadSchema.parse({ kind: call.kind, ask: call.ask, recommendation: call.recommendation, options: call.options,
            recommendedId: call.recommendedId, context: call.context, evidence: call.evidence, approvalScope: call.approvalScope });
        } else if (call.replyThreadId !== null) throw new Error("Legacy source boundary must remain unavailable");
      }
      const pending = task.pendingCall;
      if (pending && (used.has(pending.generation) || pending.block !== renderCallBlock(task.id, pending.generation, pending.payload))) throw new Error("Invalid pending reservation");
      const high = Math.max(0, ...used, pending?.generation ?? 0);
      if (task.nextGeneration <= high || task.seenGeneration >= task.nextGeneration) throw new Error("Invalid generation highwater");
      generations.set(task.id, Math.max(generations.get(task.id) ?? 1, task.nextGeneration));
    }
    for (const receipt of snapshot.receipts) {
      if (receiptIds.has(receipt.id) || operations.has(receipt.input.operationId) || receipt.taskId !== receipt.input.taskId || receipt.generation !== receipt.input.generation || receipt.fromRevision !== receipt.input.expectedRevision || receipt.toRevision !== receipt.fromRevision + 1) throw new Error("Invalid or duplicate action receipt");
      receiptIds.add(receipt.id);
      operations.add(receipt.input.operationId);
      const selected = receipt.provenance === "chat-selected" || receipt.provenance === "producer-selected";
      if (selected !== !!receipt.source || canonical(receipt.source) !== canonical(receipt.input.source ?? null) || selected !== (receipt.sourceCreatedAt !== null) || (receipt.source && receipt.input.action !== "answer")) throw new Error("Invalid receipt evidence");
      if (receipt.sourceCreatedAt !== null && (!Number.isFinite(receipt.sourceCreatedAt) || receipt.sourceCreatedAt < 0)) throw new Error("Invalid source-created timestamp");
      if (receipt.input.threadId !== undefined && receipt.input.threadId !== receipt.delivery.threadId) throw new Error("Invalid scoped receipt target");
      if (receipt.source) {
        if (receipt.input.response === undefined || receipt.source.sourceSeqEnd < receipt.source.sourceSeqStart) throw new Error("Invalid receipt response source");
        if (hash(receipt.input.response ?? "") !== receipt.source.contentSha256) throw new Error("Receipt source content changed");
        const key = canonical([receipt.taskId, receipt.source.threadId, receipt.source.rowId]);
        if (sources.has(key)) throw new Error("Snapshot reuses a response row");
        sources.add(key);
      }
      const task = cards.get(receipt.taskId);
      if (task && receipt.toRevision > task.revision) throw new Error("Receipt is newer than its card");
      generations.set(receipt.taskId, Math.max(generations.get(receipt.taskId) ?? 1, receipt.generation + 1 + (receipt.input.action === "reopen" ? 1 : 0)));
    }
    for (const command of snapshot.commands) {
      if (operations.has(command.operationId) || command.taskId !== command.result.id || command.result.revision !== command.expectedRevision + 1 || command.result.pendingCall?.generation !== command.generation || command.result.pendingCall.state !== "failed" || command.result.pendingCall.error !== "Cancelled") throw new Error("Invalid cancellation replay");
      operations.add(command.operationId);
      generations.set(command.taskId, Math.max(generations.get(command.taskId) ?? 1, command.result.nextGeneration));
    }
    const explicit = new Set<string>();
    for (const item of snapshot.generations) {
      if (explicit.has(item.taskId) || item.nextGeneration < (generations.get(item.taskId) ?? 1)) throw new Error("Invalid generation tombstone");
      explicit.add(item.taskId);
      generations.set(item.taskId, item.nextGeneration);
    }
    for (const task of snapshot.tasks) if (task.nextGeneration !== generations.get(task.id)) throw new Error("Card and generation metadata disagree");
    const normalized = { ...snapshot, tasks: [...snapshot.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), receipts: [...snapshot.receipts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      generations: [...generations].map(([taskId, nextGeneration]) => ({ taskId, nextGeneration })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
      commands: [...snapshot.commands].sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0) };
    return this.db.transaction(() => {
      const existing = this.exportSnapshot();
      if (existing.tasks.length || existing.receipts.length || existing.generations.length || existing.commands.length) {
        if (canonical(existing) !== canonical(normalized)) throw new Error("Snapshot conflicts with existing Deck state; restore into an empty store");
        return { imported: 0 };
      }
      for (const task of normalized.tasks) this.saveTask(task);
      for (const receipt of normalized.receipts) this.db.prepare("INSERT INTO deck_receipts(id,operation_id,task_id,generation,data,source_thread,source_row,created_at) VALUES(?,?,?,?,?,?,?,?)").run(receipt.id, receipt.input.operationId, receipt.taskId, receipt.generation, JSON.stringify(receipt), receipt.source?.threadId ?? null, receipt.source?.rowId ?? null, receipt.createdAt);
      for (const generation of normalized.generations) this.db.prepare("INSERT INTO deck_generations(task_id,next_generation) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET next_generation=excluded.next_generation").run(generation.taskId, generation.nextGeneration);
      for (const command of normalized.commands) this.db.prepare("INSERT INTO deck_commands(id,data) VALUES(?,?)").run(command.operationId, JSON.stringify(command));
      this.db.prepare("INSERT INTO deck_metadata(key,value) VALUES('legacy-imported','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      return { imported: normalized.tasks.length };
    }).immediate();
  }
}
