import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { callPayloadSchema, type ActionInput, type CallPayload, type DeckCard, type NativeRow } from "../contract";
import { hash, sourceRef } from "../model";
import { DeckStore, migrations, type ActionContext } from "../store";

const initialTime = 1_800_000_000_000;
let time: number;
let host: FakePluginHost;
let store: DeckStore;
const otherHosts: FakePluginHost[] = [];
const local: ActionContext = { provenance: "panel-local", notifyThreadId: "producer" };

function payload(kind: CallPayload["kind"] = "DECIDE", patch: Partial<CallPayload> = {}): CallPayload {
  return callPayloadSchema.parse({ kind, ask: "Original ask", recommendation: "Recommendation", options: [{ id: "o1", label: "Option one", detail: "Detail" }],
    recommendedId: "o1", context: "Context", evidence: [], approvalScope: kind === "APPROVE" ? { action: "Deploy build", target: "staging", constraints: "No prod", expiresAt: initialTime + 1000 } : null, ...patch });
}
function oldTask(id = "old", patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Old ${id}`, brief: "Old brief", kind: "ship", state: "decision", threadId: "worker", projectId: "project", bot: "crew", prUrl: "https://example.test/pull/1", note: "old note",
    decision: { question: "Original question", options: [{ id: "o1", label: "Original option" }], recommendedId: "o1", context: "Old context", askedAt: "2022-02-02T00:00:00.000Z",
      answeredAt: null, answerId: null, answerLabel: null, answerNote: null }, createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2022-02-02T00:00:00.000Z", landedAt: null, ...patch };
}
function open(kind: CallPayload["kind"] = "DECIDE", patch: Partial<CallPayload> = {}): DeckCard {
  const task = store.createTask({ title: "Synthetic task", threadId: "worker" });
  return store.openCall({ taskId: task.id, expectedRevision: task.revision, payload: payload(kind, patch), source: null, replyThreadId: "producer", replyAfterSeq: 10, provenance: "local-cli" });
}
function action(task: DeckCard, type: ActionInput["action"], operationId: string, patch: Partial<ActionInput> = {}): ActionInput {
  return { taskId: task.id, expectedRevision: task.revision, generation: task.call!.generation, operationId, action: type, ...patch };
}
function nativeRow(text: string, patch: Partial<NativeRow> = {}): NativeRow {
  return { threadId: "producer", turnId: "turn", rowId: "row", sourceSeqStart: 11, sourceSeqEnd: 12, contentSha256: hash(text), text, role: "user", createdAt: time,
    initiator: "user", senderThreadId: null, completed: true, visibility: null, ...patch };
}
function freshStore(): DeckStore {
  const next = createFakePluginHost({ pluginId: "captains-deck" });
  otherHosts.push(next);
  const db = next.bb.storage.database();
  next.bb.storage.migrate(db, migrations);
  return new DeckStore(db, () => time);
}

beforeEach(() => {
  time = initialTime;
  host = createFakePluginHost({ pluginId: "captains-deck" });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrations);
  store = new DeckStore(db, () => time);
});
afterEach(async () => {
  await host.harness.lifecycle.dispose();
  for (const other of otherHosts.splice(0)) await other.harness.lifecycle.dispose();
});

describe("one-time legacy migration", () => {
  it("preserves every field, oversized asks/options/context, original history order and answer timestamps", async () => {
    const decision = { question: "q".repeat(9000), options: Array.from({ length: 25 }, (_, index) => ({ id: `o${index}`, label: "L".repeat(3000), detail: "D".repeat(6000) })), recommendedId: "o24", context: "C".repeat(32000),
      askedAt: "original-asked", answeredAt: null, answerId: null, answerLabel: null, answerNote: null };
    const history = Array.from({ length: 10 }, (_, index) => ({ ...decision, question: `history-${index}`, answeredAt: `answered-${index}`, answerId: "o24", answerLabel: "Old choice", answerNote: ` note ${index} ` }));
    const legacy = [oldTask("big", { decision, history }), oldTask("older")];
    // This fixture exceeds the old aggregate cap: SQLite must not inherit that limit.
    expect(JSON.stringify(legacy).length).toBeGreaterThan(256 * 1024);
    expect(store.importLegacy(legacy)).toEqual({ imported: 2, alreadyImported: false });
    const migrated = store.getTask("big");
    expect(migrated.call).toMatchObject({ ask: decision.question, options: decision.options, context: decision.context, recommendedId: decision.recommendedId, askedAt: decision.askedAt,
      source: null, replyThreadId: null, provenance: "legacy", generation: 11 });
    expect(migrated.history.map((entry) => entry.ask)).toEqual(history.map((entry) => entry.question));
    expect(migrated.history.map((entry) => entry.answeredAt)).toEqual(history.map((entry) => entry.answeredAt));
    expect(migrated.history[0]!.answerNote).toBe(" note 0 ");
    expect(migrated).toMatchObject({ title: "Old big", state: "decision", kind: "ship", brief: "Old brief", threadId: "worker", projectId: "project", bot: "crew", prUrl: "https://example.test/pull/1", note: "old note",
      createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2022-02-02T00:00:00.000Z", nextGeneration: 12, revision: 1 });
    expect(store.getTask("older").history).toEqual([]);
    expect(store.getTask("older").call!.options[0]!.detail).toBeNull();
    expect(store.importLegacy([{ invalid: true }])).toEqual({ imported: 0, alreadyImported: true });
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.getTask("big")).toEqual(migrated);
    expect(restored.importLegacy(legacy)).toEqual({ imported: 0, alreadyImported: true });
  });

  it("does not write any card or marker until all input has parsed, and rollback leaves a retryable import", () => {
    expect(() => store.importLegacy([oldTask("first"), oldTask("bad", { decision: { question: 3 } })])).toThrow();
    expect(store.listBoard().tasks).toEqual([]);
    host.bb.storage.database().exec("CREATE TRIGGER reject_second BEFORE INSERT ON deck_cards WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    expect(() => store.importLegacy([oldTask("first"), oldTask("second")])).toThrow(/synthetic failure/);
    expect(store.exportSnapshot().tasks).toEqual([]);
    expect(store.exportSnapshot().generations).toEqual([]);
    host.bb.storage.database().exec("DROP TRIGGER reject_second;");
    expect(store.importLegacy([oldTask("first"), oldTask("second")])).toEqual({ imported: 2, alreadyImported: false });
  });

  it("records empty imports atomically and never imports stale KV afterwards", async () => {
    await host.bb.storage.kv.set("tasks", [oldTask("kv")]);
    const original = await host.bb.storage.kv.get("tasks");
    expect(store.importLegacy(original).imported).toBe(1);
    expect(await host.bb.storage.kv.get("tasks")).toEqual(original);
    const empty = freshStore();
    expect(empty.importLegacy(undefined)).toEqual({ imported: 0, alreadyImported: false });
    expect(empty.importLegacy([oldTask("stale")])).toEqual({ imported: 0, alreadyImported: true });
    expect(empty.listBoard().tasks).toEqual([]);
  });


});

describe("transactional card writers and call generations", () => {
  it("applies CAS to old CLI writers and never changes a lane for a new CLI ask", () => {
    let task = store.createTask({ title: "Chart", brief: "  brief  ", kind: "scout", projectId: "p", bot: "b" });
    expect(task).toMatchObject({ state: "charted", brief: "brief", revision: 1, nextGeneration: 1 });
    task = store.updateTask(task.id, { state: "merge", prUrl: "https://example.test/pull/2", note: "progress" }, task.revision);
    expect(() => store.updateTask(task.id, { note: "stale" }, 1)).toThrow(/Stale/);
    expect(() => store.removeTask(task.id, 1)).toThrow(/Stale/);
    task = store.openCall({ taskId: task.id, expectedRevision: task.revision, payload: payload(), source: null, replyThreadId: null, replyAfterSeq: 0, provenance: "local-cli", threadId: "linked-worker" });
    expect(task).toMatchObject({ state: "merge", threadId: "linked-worker", revision: 3, nextGeneration: 2 });
    expect(task.call).toMatchObject({ provenance: "local-cli", source: null, generation: 1 });
    store.applyAction(action(task, "answer", "answer", { optionId: "o1" }), local);
    expect(store.getTask(task.id).state).toBe("merge");
  });

  it("resumes the legacy decision lane only on terminal legacy resolution and preserves all archived calls", () => {
    store.importLegacy([oldTask("legacy")]);
    let legacy = store.getTask("legacy");
    store.applyAction(action(legacy, "defer", "defer", { deferUntil: null }), local);
    legacy = store.getTask(legacy.id);
    expect(legacy.state).toBe("decision");
    store.markSeen(legacy.id, legacy.call!.generation);
    store.applyAction(action(legacy, "dismiss", "dismiss"), local);
    expect(store.getTask(legacy.id).state).toBe("underway");
    let task = open("DO");
    task = store.updateTask(task.id, { state: "decision" }, task.revision);
    store.applyAction(action(task, "complete", "complete-new"), local);
    expect(store.getTask(task.id).state).toBe("decision");
    const original = store.getTask(task.id).call!;
    task = store.openCall({ taskId: task.id, expectedRevision: store.getTask(task.id).revision, payload: payload(), source: null, replyThreadId: null, replyAfterSeq: 0, provenance: "local-cli" });
    expect(task.history[0]).toEqual(original);
    expect(task.call!.generation).toBe(2);
  });

  it("rolls back card/revision and receipt together if receipt insertion fails", () => {
    const task = open();
    host.bb.storage.database().exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON deck_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");
    expect(() => store.applyAction(action(task, "answer", "atomic", { response: "Answer" }), local)).toThrow(/receipt failure/);
    expect(store.getTask(task.id)).toEqual(task);
    expect(store.listReceipts(task.id).receipts).toEqual([]);
    host.bb.storage.database().exec("DROP TRIGGER reject_receipt;");
    expect(store.applyAction(action(task, "answer", "atomic", { response: "Answer" }), local).toRevision).toBe(task.revision + 1);
  });
});

describe("native call reservations", () => {
  it("keeps the current call until one exact completed assistant row publishes and locks every semantic writer", () => {
    const previous = open();
    const request = { taskId: previous.id, expectedRevision: previous.revision, payload: payload("DO"), threadId: "producer", turnId: "active-turn", afterSeq: 20 };
    const pending = store.prepareCall(request);
    expect(pending.task.call).toEqual(previous.call);
    expect(pending.generation).toBe(2);
    expect(pending.task.nextGeneration).toBe(3);
    expect(store.prepareCall(request)).toEqual(pending);
    expect(() => store.prepareCall({ ...request, payload: payload("DO", { ask: "Changed retry" }) })).toThrow();
    expect(() => store.updateTask(previous.id, { note: "race" }, pending.task.revision)).toThrow(/pending/);
    expect(() => store.removeTask(previous.id, pending.task.revision)).toThrow(/pending/);
    expect(() => store.openCall({ taskId: previous.id, expectedRevision: pending.task.revision, payload: payload(), source: null, replyThreadId: null, replyAfterSeq: 0, provenance: "local-cli" })).toThrow(/pending/);
    expect(() => store.applyAction(action(pending.task, "dismiss", "blocked"), local)).toThrow(/pending/);
    expect(store.markSeen(previous.id, previous.call!.generation).revision).toBe(pending.task.revision);
    const assistant = nativeRow(pending.block, { role: "assistant", turnId: "active-turn", sourceSeqStart: 21, sourceSeqEnd: 22, initiator: "agent" });
    for (const patch of [{ role: "user" }, { completed: false }, { threadId: "other" }, { turnId: "wrong" },
      { sourceSeqEnd: 20 }, { text: `${pending.block}\n` }, { contentSha256: "0".repeat(64) }, { visibility: "agent-only" }, { visibility: "system" }, { senderThreadId: "forwarder" }]) {
      expect(() => store.publishCall(previous.id, pending.generation, { ...assistant, ...patch } as NativeRow, pending.task.revision)).toThrow(/match/);
    }
    expect(() => store.publishCall(previous.id, pending.generation, assistant, previous.revision)).toThrow(/Stale/);
    const originalText = `Producer preamble\n${pending.block}\nProducer explanation`;
    const completeRow = { ...assistant, sourceSeqStart: 19, text: originalText, contentSha256: hash(originalText) };
    const published = store.publishCall(previous.id, pending.generation, completeRow, pending.task.revision);
    expect(published.pendingCall).toBeNull();
    expect(published.call).toMatchObject({ generation: 2, source: sourceRef(completeRow), replyThreadId: "producer", replyAfterSeq: 22, askedAt: new Date(assistant.createdAt).toISOString(), provenance: "native-origin" });
    expect(published.history[0]).toEqual(previous.call);
    expect(published.state).toBe(previous.state);
    expect(() => store.publishCall(previous.id, pending.generation, assistant, published.revision)).toThrow(/No matching/);
  });

  it("failure/cancel keep visible failed metadata, consume generations, and cancellation replays before stale checks", () => {
    const current = open();
    let pending = store.prepareCall({ taskId: current.id, expectedRevision: current.revision, payload: payload(), threadId: "producer", turnId: "t1", afterSeq: 10 });
    let failed = store.failCall(current.id, pending.generation, "publication unavailable", pending.task.revision);
    expect(failed.call).toEqual(current.call);
    expect(failed.pendingCall).toMatchObject({ state: "failed", error: "publication unavailable", generation: 2 });
    expect(store.pendingCalls().tasks).toEqual([]);
    pending = store.prepareCall({ taskId: current.id, expectedRevision: failed.revision, payload: payload(), threadId: "producer", turnId: "t2", afterSeq: 30 });
    expect(pending.generation).toBe(3);
    failed = store.cancelCall(current.id, pending.generation, pending.task.revision, "cancel");
    expect(failed.pendingCall).toMatchObject({ state: "failed", error: "Cancelled" });
    expect(failed.call).toEqual(current.call);
    store.updateTask(current.id, { note: "after cancel" }, failed.revision);
    expect(store.cancelCall(current.id, pending.generation, pending.task.revision, "cancel")).toEqual(failed);
    expect(() => store.cancelCall(current.id, pending.generation + 1, pending.task.revision, "cancel")).toThrow(/different/);
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.cancelCall(current.id, pending.generation, pending.task.revision, "cancel")).toEqual(failed);
    const updated = restored.getTask(current.id);
    expect(() => restored.applyAction(action(updated, "dismiss", "cancel"), local)).toThrow(/cancellation/);
    const next = restored.prepareCall({ taskId: current.id, expectedRevision: updated.revision, payload: payload(), threadId: "producer", turnId: "t3", afterSeq: 40 });
    expect(next.generation).toBe(4);
  });

  it("restores an active reservation with its exact thread/turn/block and pending lock intact", () => {
    const task = open();
    const pending = store.prepareCall({ taskId: task.id, expectedRevision: task.revision, payload: payload("DO"), threadId: "producer", turnId: "active", afterSeq: 20 });
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.pendingCalls().tasks).toEqual([pending.task]);
    expect(() => restored.updateTask(task.id, { state: "failed" }, pending.task.revision)).toThrow(/pending/);
    const row = nativeRow(pending.block, { role: "assistant", turnId: "active", sourceSeqStart: 21, sourceSeqEnd: 25 });
    expect(restored.publishCall(task.id, pending.generation, row, pending.task.revision).call!.source).toEqual(sourceRef(row));
  });
  it("bounds and isolates pending-call pages and retains cancellation replay after deletion", () => {
    const pendingTasks: DeckCard[] = [];
    for (let index = 0; index < 101; index += 1) {
      const task = store.createTask({ title: `Pending ${index}` });
      pendingTasks.push(store.prepareCall({ taskId: task.id, expectedRevision: task.revision, payload: payload(), threadId: "producer", turnId: `turn-${index}`, afterSeq: index }).task);
    }
    const first = store.pendingCalls({ limit: 100 });
    expect(first.tasks).toHaveLength(100);
    const second = store.pendingCalls({ limit: 100, cursor: first.nextCursor! });
    expect(second.tasks).toHaveLength(1);
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(101);
    expect(() => store.listBoard({ cursor: first.nextCursor! })).toThrow(/another view/);
    expect(() => store.pendingCalls({ limit: 101 })).toThrow();
    const task = pendingTasks[0]!;
    const cancelled = store.cancelCall(task.id, task.pendingCall!.generation, task.revision, "deleted-cancel");
    store.removeTask(task.id, cancelled.revision);
    expect(store.cancelCall(task.id, task.pendingCall!.generation, task.revision, "deleted-cancel")).toEqual(cancelled);
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.cancelCall(task.id, task.pendingCall!.generation, task.revision, "deleted-cancel")).toEqual(cancelled);
  });

});

describe("shared action receipts and source replay", () => {
  it("replays before stale revision/generation checks, rejects changed semantic context, and seen never bumps revision", () => {
    const task = open();
    const input = action(task, "answer", "replay", { response: "  Original answer\n" });
    const seen = store.markSeen(task.id, task.call!.generation);
    expect(seen.revision).toBe(task.revision);
    const receipt = store.applyAction(input, local);
    const answered = store.getTask(task.id);
    expect(answered.call).toMatchObject({ status: "answered", answerNote: input.response });
    const replaced = store.openCall({ taskId: task.id, expectedRevision: answered.revision, payload: payload(), source: null, replyThreadId: "producer", replyAfterSeq: 30, provenance: "local-cli" });
    expect(store.applyAction(input, local)).toEqual(receipt);
    for (const patch of [{ response: "changed" }, { expectedRevision: task.revision + 1 }, { generation: 2 }, { action: "dismiss" }]) {
      expect(() => store.applyAction({ ...input, ...patch } as ActionInput, local)).toThrow(/different/);
    }
    expect(() => store.applyAction(input, { ...local, provenance: "local-cli" })).toThrow(/different/);
    expect(() => store.applyAction(input, { ...local, notifyThreadId: "other" })).toThrow(/different/);
    expect(() => store.applyAction(action(replaced, "dismiss", "stale-revision", { expectedRevision: task.revision }), local)).toThrow(/Stale/);
    expect(() => store.applyAction(action(replaced, "dismiss", "stale-generation", { generation: 1 }), local)).toThrow(/generation/);
    expect(() => store.markSeen(task.id, 1)).toThrow(/generation/);
    expect(store.getTask(task.id)).toEqual(replaced);
  });

  it("keeps notification state distinct, target immutable, attempts monotonic, and replay survives restart/restore", async () => {
    const task = open();
    const input = action(task, "dismiss", "notice");
    const receipt = store.applyAction(input, local);
    expect(receipt.delivery).toMatchObject({ state: "pending", attempts: 0 });
    const uncertain = store.updateDelivery(receipt.id, { state: "uncertain", attempts: 1, error: "timeout" });
    expect(uncertain.input).toEqual(input);
    expect(store.getTask(task.id).revision).toBe(receipt.toRevision);
    expect(() => store.updateDelivery(receipt.id, { attempts: 0 })).toThrow(/decrease/);
    expect(() => store.updateDelivery(receipt.id, { threadId: "other" })).toThrow(/immutable/);
    let restarted: DeckStore | undefined;
    host = await host.harness.lifecycle.reload((bb) => {
      const db = bb.storage.database(); bb.storage.migrate(db, migrations); restarted = new DeckStore(db, () => time);
    });
    store = restarted!;
    expect(store.applyAction(input, local)).toEqual(uncertain);
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.applyAction(input, local)).toEqual(uncertain);
    expect(restored.updateDelivery(receipt.id, { state: "sent", attempts: 2, error: null }).delivery.state).toBe("sent");
    const disabledTask = open("DO");
    expect(store.applyAction(action(disabledTask, "complete", "disabled"), { provenance: "local-cli", notifyThreadId: null }).delivery.state).toBe("disabled");
  });

  it("validates exact native user source and provenance and never lets an unbound legacy call claim chat evidence", () => {
    const task = open("DO");
    const row = nativeRow("  exact selected\n");
    const input = action(task, "answer", "chat", { response: row.text, source: sourceRef(row), threadId: "producer" });
    const chat: ActionContext = { provenance: "chat-selected", sourceRow: row, notifyThreadId: "producer" };
    for (const patch of [{ role: "assistant" }, { initiator: "agent" }, { senderThreadId: "forwarder" }, { visibility: "agent-only" }, { visibility: "system" }, { completed: false }, { text: "changed" }]) {
      expect(() => store.applyAction(input, { ...chat, sourceRow: { ...row, ...patch } as NativeRow })).toThrow();
    }
    expect(() => store.applyAction({ ...input, response: row.text.trim() }, chat)).toThrow(/changed/);
    expect(() => store.applyAction(input, local)).toThrow(/provenance/);
    expect(() => store.applyAction(action(task, "answer", "no-source", { response: row.text }), chat)).toThrow(/provenance/);
    expect(() => store.applyAction({ ...input, action: "defer", deferUntil: null }, chat)).toThrow(/Only answers/);
    expect(() => store.applyAction({ ...input, threadId: "wrong" }, chat)).toThrow(/wrong/);
    const receipt = store.applyAction(input, chat);
    expect(receipt).toMatchObject({ provenance: "chat-selected", source: sourceRef(row), sourceCreatedAt: row.createdAt });
    expect(store.getTask(task.id).call!.answerNote).toBe(row.text);
    expect(store.applyAction(input, chat)).toEqual(receipt);
    expect(() => store.applyAction(input, { ...chat, sourceRow: { ...row, createdAt: row.createdAt + 1 } })).toThrow(/different/);
    store.importLegacy([oldTask("unbound")]);
    const unbound = store.getTask("unbound");
    expect(() => store.applyAction(action(unbound, "answer", "legacy-chat", { response: row.text, source: sourceRef(row) }), chat)).toThrow(/wrong thread/);
  });

  it("permits multiple DO clarification receipts but one original response row per card across generations", () => {
    let task = open("DO");
    const first = nativeRow("Clarification one");
    const firstInput = action(task, "answer", "clarification-1", { response: first.text, source: sourceRef(first) });
    const chat: ActionContext = { provenance: "producer-selected", sourceRow: first, notifyThreadId: "producer" };
    store.applyAction(firstInput, chat);
    task = store.getTask(task.id);
    expect(task.call!.status).toBe("open");
    expect(() => store.applyAction(action(task, "answer", "reuse-same-generation", { response: first.text, source: sourceRef(first) }), chat)).toThrow(/already been used/);
    const second = nativeRow("Clarification two", { rowId: "second-row", sourceSeqStart: 13, sourceSeqEnd: 14 });
    store.applyAction(action(task, "answer", "clarification-2", { response: second.text, source: sourceRef(second) }), { ...chat, sourceRow: second });
    task = store.getTask(task.id);
    store.applyAction(action(task, "complete", "complete"), local);
    task = store.getTask(task.id);
    const closed = task.call!;
    store.applyAction(action(task, "reopen", "reopen"), local);
    task = store.getTask(task.id);
    expect(task.call).toMatchObject({ generation: 2, status: "open", answerNote: null });
    expect(task.history[0]).toEqual(closed);
    expect(() => store.applyAction(action(task, "answer", "reuse-next-generation", { response: first.text, source: sourceRef(first) }), chat)).toThrow(/boundary|used/);
    const restored = freshStore();
    restored.importSnapshot(store.exportSnapshot());
    expect(restored.applyAction(firstInput, chat).id).toBe("clarification-1");
    expect(() => restored.applyAction(action(restored.getTask(task.id), "answer", "reuse-restored", { response: first.text, source: sourceRef(first) }), chat)).toThrow(/boundary|used/);
    expect(restored.listReceipts(task.id).receipts).toHaveLength(4);
  });

  it("uses source-created time for native approval, current time for local, and never lands work", () => {
    let task = open("APPROVE", { options: [{ id: "approve", label: "Approve", detail: null }, { id: "decline", label: "Decline", detail: null }], recommendedId: "approve" });
    task = store.updateTask(task.id, { state: "merge" }, task.revision);
    time = initialTime + 2000;
    expect(() => store.applyAction(action(task, "answer", "expired", { decision: "approve" }), local)).toThrow(/expired/);
    const original = nativeRow("I approve", { createdAt: initialTime + 999 });
    const qualified = nativeRow("approve, but only the staging step", { rowId: "qualified", sourceSeqStart: 13, sourceSeqEnd: 14, createdAt: initialTime + 999 });
    expect(() => store.applyAction(action(task, "answer", "qualified-approval", { decision: "approve", response: qualified.text, source: sourceRef(qualified) }), { provenance: "chat-selected", sourceRow: qualified, notifyThreadId: "producer" })).toThrow(/unqualified/);
    store.applyAction(action(task, "answer", "source-approval", { decision: "approve", response: original.text, source: sourceRef(original) }), { provenance: "chat-selected", sourceRow: original, notifyThreadId: "producer" });
    expect(store.getTask(task.id)).toMatchObject({ state: "merge", landedAt: null });
    expect(store.getTask(task.id).call).toMatchObject({ status: "answered", answerId: "approve", answerNote: original.text });
    const declined = open("APPROVE");
    store.applyAction(action(declined, "answer", "decline", { decision: "decline" }), local);
    expect(store.getTask(declined.id).call!.answerId).toBe("decline");
  });

  it("reopens oversized legacy content without applying new-ask limits or losing answer history", () => {
    const old = oldTask("oversized");
    const decision = old.decision as Record<string, unknown>;
    decision.question = "q".repeat(10000); decision.context = "c".repeat(40000);
    decision.options = [{ id: "o1", label: "L".repeat(5000), detail: "D".repeat(6000) }];
    store.importLegacy([old]);
    let task = store.getTask("oversized");
    store.applyAction(action(task, "answer", "legacy-answer", { optionId: "o1", response: " Exact answer " }), local);
    task = store.getTask(task.id);
    const answered = task.call!;
    expect(task.state).toBe("underway");
    store.applyAction(action(task, "reopen", "legacy-reopen"), local);
    task = store.getTask(task.id);
    expect(task.call!.ask).toBe(answered.ask);
    expect(task.call!.options).toEqual(answered.options);
    expect(task.call!.context).toBe(answered.context);
    expect(task.history[0]).toEqual(answered);
    expect(task.call!.generation).toBe(2);
    expect(task.state).toBe("underway");
  });
  it("replays selected-native evidence without refetching a deleted row after generation changes or card deletion", () => {
    let task = open("DO");
    const row = nativeRow("  Original native answer\n");
    const input = action(task, "answer", "native-replay", { response: row.text, source: sourceRef(row), threadId: "producer" });
    const context: ActionContext = { provenance: "chat-selected", sourceRow: row, notifyThreadId: "producer" };
    expect(store.findReceiptByOperation(input.operationId)).toBeNull();
    expect(() => store.applyAction(input, { provenance: "chat-selected", notifyThreadId: "producer" })).toThrow(/source row/);
    const receipt = store.applyAction(input, context);
    expect(store.findReceiptByOperation(input.operationId)).toEqual(receipt);
    task = store.getTask(task.id);
    store.applyAction(action(task, "complete", "close-native-call"), local);
    task = store.getTask(task.id);
    store.applyAction(action(task, "reopen", "reopen-native-call"), local);
    task = store.getTask(task.id);
    expect(task.call!.generation).toBe(2);
    // A source reader reports the original row deleted: no sourceRow is supplied.
    const replayContext: ActionContext = { provenance: "chat-selected", notifyThreadId: receipt.delivery.threadId };
    expect(store.applyAction(input, replayContext)).toEqual(receipt);
    expect(store.getTask(task.id)).toEqual(task);
    expect(() => store.applyAction({ ...input, response: "changed" }, replayContext)).toThrow(/different/);
    expect(() => store.applyAction({ ...input, source: { ...input.source!, rowId: "changed-row" } }, replayContext)).toThrow(/different/);
    expect(() => store.applyAction(input, { ...replayContext, notifyThreadId: "changed-producer" })).toThrow();
    expect(() => store.applyAction(input, { ...replayContext, provenance: "producer-selected" })).toThrow(/different/);
    expect(() => store.applyAction(input, { ...context, sourceRow: { ...row, createdAt: row.createdAt + 1 } })).toThrow(/different/);
    store.removeTask(task.id, task.revision);
    expect(store.applyAction(input, replayContext)).toEqual(receipt);
    const snapshot = store.exportSnapshot();
    snapshot.receipts.find((item) => item.input.operationId === input.operationId)!.id = "independent-native-receipt";
    const restored = freshStore();
    restored.importSnapshot(snapshot);
    const replayed = restored.applyAction(input, replayContext);
    expect(replayed.id).toBe("independent-native-receipt");
    expect(restored.findReceiptByOperation(input.operationId)).toEqual(replayed);
    expect(restored.getReceipt(replayed.id)).toEqual(replayed);
    expect(restored.findReceiptByOperation("independent-native-receipt")).toBeNull();
  });

});

describe("SQL bounded keyset views and aggregate counts", () => {
  it("returns all 301 cards beyond 256 without repeats, page-limits at 100, and counts the entire authority", () => {
    store.importLegacy(Array.from({ length: 301 }, (_, index) => oldTask(`task-${String(index).padStart(3, "0")}`, { decision: { question: "x".repeat(1400), options: [], recommendedId: null,
      context: null, askedAt: "2020-01-01T00:00:00.000Z", answeredAt: null, answerId: null, answerLabel: null, answerNote: null } })));
    let page = store.listBoard({ limit: 100 });
    const ids = page.tasks.map((task) => task.id);
    expect(page.counts).toEqual({ total: 301, attention: 301, unresolved: 301, unseen: 301, deferred: 0, closed: 0 });
    while (page.nextCursor) {
      page = store.listBoard({ limit: 100, cursor: page.nextCursor });
      expect(page.tasks.length).toBeLessThanOrEqual(100);
      expect(page.counts.unresolved).toBe(301);
      ids.push(...page.tasks.map((task) => task.id));
    }
    expect(ids).toHaveLength(301);
    expect(new Set(ids).size).toBe(301);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(() => store.listBoard({ limit: 101 })).toThrow();
    expect(() => store.listBoard({ cursor: "garbage" })).toThrow(/cursor/);
    let attention = store.listCalls({ threadId: "producer", view: "attention", limit: 100 });
    const attentionIds = attention.tasks.map((task) => task.id);
    while (attention.nextCursor) {
      attention = store.listCalls({ threadId: "producer", view: "attention", limit: 100, cursor: attention.nextCursor });
      attentionIds.push(...attention.tasks.map((task) => task.id));
    }
    expect(attentionIds).toEqual(ids);
    const stale = store.getTask("task-000");
    store.updateTask(stale.id, { note: "touched last" }, stale.revision);
    // An active card must never hide behind a later page.
    expect(store.listBoard({ limit: 100 }).tasks[0]!.id).toBe("task-000");
  });

  it("separates unresolved/unseen from attention, excludes work-only cards, and freezes due eligibility asOf", () => {
    store.importLegacy([oldTask("a"), oldTask("b"), oldTask("c"), oldTask("d"), oldTask("e"), oldTask("work", { decision: null, state: "failed" })]);
    const b = store.getTask("b"); store.applyAction(action(b, "defer", "b-future", { deferUntil: time + 100 }), local);
    const c = store.getTask("c"); store.applyAction(action(c, "defer", "c-indefinite", { deferUntil: null }), local);
    const d = store.getTask("d"); store.applyAction(action(d, "dismiss", "d-dismiss"), local);
    const e = store.getTask("e"); store.applyAction(action(e, "answer", "e-answer", { optionId: "o1" }), local);
    store.markSeen("a", 1);
    const first = store.listCalls({ threadId: "producer", view: "attention", limit: 1 });
    expect(first.tasks.map((task) => task.id)).toEqual(["a"]);
    expect(first.counts).toEqual({ total: 6, attention: 1, unresolved: 3, unseen: 2, deferred: 2, closed: 2 });
    expect(first.nextDueAt).toBe(initialTime + 100);
    expect(store.listCalls({ threadId: "producer", view: "deferred", limit: 100 }).tasks.map((task) => task.id)).toEqual(["c", "b"]);
    expect(store.listCalls({ threadId: "producer", view: "closed", limit: 100 }).tasks.map((task) => task.id)).toEqual(["e", "d"]);
    const board = store.listBoard({ limit: 1 });
    time += 101;
    const frozen = store.listBoard({ limit: 100, cursor: board.nextCursor! });
    expect(frozen.serverNow).toBe(initialTime);
    expect(frozen.counts.attention).toBe(1);
    const due = store.listCalls({ threadId: "producer", view: "attention", limit: 100 });
    expect(due.tasks.map((task) => task.id)).toEqual(["b", "a"]);
    expect(due.counts.attention).toBe(2);
    expect(due.nextDueAt).toBeNull();
    expect(() => store.listCalls({ threadId: "producer", view: "attention", limit: 100, cursor: board.nextCursor! })).toThrow(/another view/);
    const deferred = store.listCalls({ threadId: "producer", view: "deferred", limit: 1 });
    expect(() => store.listCalls({ threadId: "other", view: "deferred", limit: 1, cursor: deferred.nextCursor! })).toThrow(/another view/);
    expect(() => store.listCalls({ threadId: "producer", view: "closed", limit: 1, cursor: deferred.nextCursor! })).toThrow(/another view/);
  });

  it("paginates attention with the same frozen due boundary as pages cross a deadline", () => {
    store.importLegacy([oldTask("a"), oldTask("b"), oldTask("c")]);
    const b = store.getTask("b"); store.applyAction(action(b, "defer", "future", { deferUntil: time + 1 }), local);
    const first = store.listCalls({ threadId: "producer", view: "attention", limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    time += 2;
    const next = store.listCalls({ threadId: "producer", view: "attention", limit: 1, cursor: first.nextCursor! });
    expect(next.tasks.map((task) => task.id)).toEqual(["a"]);
    expect(next.serverNow).toBe(first.serverNow);
    expect(next.counts.attention).toBe(2);
    expect(store.listCalls({ threadId: "producer", view: "attention", limit: 100 }).counts.attention).toBe(3);
  });

  it("paginates 301 immutable receipts, preserves deleted-card history and isolates receipt cursors", () => {
    let task = open("DO");
    for (let index = 0; index < 301; index += 1) {
      store.applyAction(action(task, "answer", `receipt-${String(index).padStart(3, "0")}`, { response: `clarification ${index}` }), local);
      task = store.getTask(task.id);
    }
    let page = store.listReceipts(task.id, { limit: 100 });
    const ids = page.receipts.map((receipt) => receipt.id);
    const firstCursor = page.nextCursor!;
    while (page.nextCursor) {
      page = store.listReceipts(task.id, { limit: 100, cursor: page.nextCursor });
      ids.push(...page.receipts.map((receipt) => receipt.id));
    }
    expect(ids).toHaveLength(301);
    expect(new Set(ids).size).toBe(301);
    expect(() => store.listReceipts("other", { limit: 100, cursor: firstCursor })).toThrow(/another view/);
    expect(() => store.listReceipts(task.id, { limit: 101 })).toThrow();
    store.removeTask(task.id, task.revision);
    expect(store.listReceipts(task.id, { limit: 100 }).receipts).toHaveLength(100);
    expect(store.exportSnapshot().receipts).toHaveLength(301);
    expect(store.exportSnapshot().generations).toContainEqual({ taskId: task.id, nextGeneration: task.nextGeneration });
  });
});

describe("atomic restore and deletion preservation", () => {
  it("restores exact state, permits only exact retries, rejects whole-card/receipt conflicts without partial writes", () => {
    const first = open();
    store.applyAction(action(first, "answer", "answer", { response: "original" }), local);
    const second = open("DO");
    const snapshot = store.exportSnapshot();
    const restored = freshStore();
    expect(restored.importSnapshot(snapshot)).toEqual({ imported: 2 });
    expect(restored.exportSnapshot()).toEqual(snapshot);
    expect(restored.importSnapshot(snapshot)).toEqual({ imported: 0 });
    const changedCard = structuredClone(snapshot); changedCard.tasks[0]!.note = "changed";
    expect(() => restored.importSnapshot(changedCard)).toThrow(/conflicts/);
    expect(restored.exportSnapshot()).toEqual(snapshot);
    const changedReceipt = structuredClone(snapshot); changedReceipt.receipts[0]!.delivery.error = "changed";
    expect(() => restored.importSnapshot(changedReceipt)).toThrow(/conflicts/);
    expect(restored.exportSnapshot()).toEqual(snapshot);
    const truncated = { ...snapshot, tasks: snapshot.tasks.filter((task) => task.id !== second.id) };
    expect(() => restored.importSnapshot(truncated)).toThrow(/conflicts/);
    const wrongRevision = structuredClone(snapshot); wrongRevision.receipts[0]!.toRevision += 1;
    expect(() => freshStore().importSnapshot(wrongRevision)).toThrow(/receipt/);
    const duplicate = { ...snapshot, tasks: [...snapshot.tasks, snapshot.tasks[0]!] };
    expect(() => freshStore().importSnapshot(duplicate)).toThrow(/Duplicate/);
  });

  it("rolls back every card, receipt, metadata and marker if a restore SQL trigger aborts", () => {
    const one = open(); store.applyAction(action(one, "dismiss", "receipt"), local);
    open("DO");
    const snapshot = store.exportSnapshot();
    const restored = freshStore();
    const db = otherHosts[otherHosts.length - 1]!.bb.storage.database();
    db.exec("CREATE TRIGGER restore_failure BEFORE INSERT ON deck_receipts BEGIN SELECT RAISE(ABORT,'restore failure'); END;");
    expect(() => restored.importSnapshot(snapshot)).toThrow(/restore failure/);
    expect(restored.exportSnapshot()).toEqual({ format: "captains-deck", version: 1, tasks: [], receipts: [], generations: [], commands: [] });
    db.exec("DROP TRIGGER restore_failure;");
    expect(restored.importSnapshot(snapshot).imported).toBe(2);
    expect(restored.exportSnapshot()).toEqual(snapshot);
  });

  it("retains deleted receipts/replays and failed generation highwater and rejects id reuse/reset on restore", () => {
    const task = open("DO");
    const input = action(task, "answer", "deleted-replay", { response: "original" });
    const receipt = store.applyAction(input, local);
    const current = store.getTask(task.id);
    const pending = store.prepareCall({ taskId: task.id, expectedRevision: current.revision, payload: payload(), threadId: "producer", turnId: "failed-turn", afterSeq: 20 });
    const failed = store.failCall(task.id, pending.generation, "failed");
    store.removeTask(task.id, failed.revision);
    const snapshot = store.exportSnapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.receipts).toEqual([receipt]);
    expect(snapshot.generations).toEqual([{ taskId: task.id, nextGeneration: 3 }]);
    expect(store.applyAction(input, local)).toEqual(receipt);
    const restored = freshStore();
    restored.importSnapshot(snapshot);
    expect(restored.applyAction(input, local)).toEqual(receipt);
    expect(restored.listReceipts(task.id).receipts).toEqual([receipt]);
    const reset = { ...snapshot, generations: [{ taskId: task.id, nextGeneration: 1 }] };
    expect(() => restored.importSnapshot(reset)).toThrow(/tombstone/);
    const reused = { ...snapshot, tasks: [{ ...current, nextGeneration: 3 }] };
    expect(() => restored.importSnapshot(reused)).toThrow(/conflicts/);
    expect(restored.exportSnapshot()).toEqual(snapshot);
  });

  it("rejects changed pending blocks and duplicate source rows before any restore writes", () => {
    const task = open("DO");
    const row = nativeRow("answer");
    store.applyAction(action(task, "answer", "source", { response: row.text, source: sourceRef(row) }), { provenance: "chat-selected", sourceRow: row, notifyThreadId: "producer" });
    const current = store.getTask(task.id);
    store.prepareCall({ taskId: task.id, expectedRevision: current.revision, payload: payload(), threadId: "producer", turnId: "pending", afterSeq: 20 });
    const snapshot = store.exportSnapshot();
    const changed = structuredClone(snapshot); changed.tasks[0]!.pendingCall!.block += "changed";
    const restored = freshStore();
    expect(() => restored.importSnapshot(changed)).toThrow(/reservation/);
    expect(restored.exportSnapshot().tasks).toEqual([]);
    const duplicate = structuredClone(snapshot);
    const receipt = structuredClone(duplicate.receipts[0]!); receipt.id = "other-op"; receipt.input.operationId = "other-op";
    duplicate.receipts.push(receipt);
    expect(() => restored.importSnapshot(duplicate)).toThrow(/reuses/);
    expect(restored.exportSnapshot().receipts).toEqual([]);
  });
});
