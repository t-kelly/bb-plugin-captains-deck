// One Deck authority for the full board, native thread tab, CLI and explicit chat association.
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { actionInputSchema, callPayloadSchema, idSchema, versionSchema, type ActionInput, type CallPayload, type Receipt } from "./contract";
import { rpcContract } from "./rpc";
import { DeckStore, migrations } from "./store";
import { NativeEvidenceReader } from "./evidence";
import { registerDeckCli } from "./cli";
import { sourceRef } from "./model";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ firstMateThreadId: { type: "string", label: "First mate thread", description: "Native thread hosting Needs my attention and receiving action notices. Empty records board actions without sending a notice.", default: "" } });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const store = new DeckStore(db);
  store.importLegacy(await bb.storage.kv.get("tasks")); // Retain the original KV untouched for recovery.
  const evidence = new NativeEvidenceReader(bb.sdk);
  let disposed = false;
  const deliveries = new Map<string, Promise<Receipt>>();
  let observing: Promise<void> | null = null;
  let observeAgain = false;
  const changed = () => { if (!disposed) bb.realtime.publish("deck-changed", {}); };

  async function getSetup() {
    const configured = (await settings.get()).firstMateThreadId.trim();
    if (!configured) return { firstMateThreadId: "", producer: null, valid: false, reason: "Configure First mate thread to use Needs my attention and native source association." };
    if (!idSchema.safeParse(configured).success) return { firstMateThreadId: configured, producer: null, valid: false, reason: "First mate thread is not a valid thread id. Captain actions are still recorded; their notices are not sent." };
    const thread = await evidence.nativeThread(configured);
    return { firstMateThreadId: configured, producer: thread.available ? { threadId: thread.threadId, projectId: thread.projectId, title: thread.title } : null, valid: thread.available, reason: thread.available ? null : "The configured first mate thread or its environment is unavailable." };
  }

  /** A rejection the source refused before committing; the client can safely discard it. */
  async function committing<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (store.findReceiptByOperation(operationId) !== null) throw error;
      throw new Error(`Rejected: ${message}`);
    }
  }

  async function guard(threadId: string, context?: Pick<PluginAgentToolContext, "threadId" | "projectId" | "signal">) {
    if (disposed || context?.signal.aborted) throw new Error("plugin_or_request_cancelled");
    const setup = await getSetup();
    if (!setup.valid || !setup.producer || setup.firstMateThreadId !== threadId || (context && (context.threadId !== threadId || context.projectId !== setup.producer.projectId))) throw new Error("This operation belongs to the configured first mate conversation.");
    if (disposed || context?.signal.aborted) throw new Error("plugin_or_request_cancelled");
    // Settings can change while native resources are being read.
    if ((await settings.get()).firstMateThreadId.trim() !== threadId) throw new Error("producer_configuration_changed");
    return setup.producer;
  }

  async function scoped(threadId?: string) {
    if (disposed) throw new Error("plugin_disposed");
    if (threadId !== undefined) await guard(threadId);
  }

  function noticeText(receipt: Receipt) {
    return [
      `[Captain's Deck receipt ${receipt.id}]`,
      `Task ${receipt.taskId}; Captain action generation ${receipt.generation}.`,
      `Recorded ${receipt.input.action}${receipt.input.decision ? ` (${receipt.input.decision})` : ""}; provenance ${receipt.provenance}.`,
      ...(receipt.input.optionId ? [`Option: ${receipt.input.optionId}`] : []),
      ...(receipt.input.response !== undefined ? [`Original response: ${receipt.input.response}`] : []),
      ...(receipt.input.action === "defer" ? [`Deferred until: ${receipt.input.deferUntil === null ? "indefinitely" : new Date(receipt.input.deferUntil!).toISOString()}`] : []),
      "This receipt records the Captain action only. DO clarification is not completion; DO completion does not land underlying work; approval executes nothing externally.",
    ].join("\n");
  }

  function deliver(receiptId: string, explicitRetry = false): Promise<Receipt> {
    const active = deliveries.get(receiptId);
    if (active) return active;
    const current = store.getReceipt(receiptId);
    if (!current.delivery.threadId || current.delivery.state === "disabled" || (!explicitRetry && (current.delivery.state !== "pending" || current.delivery.attempts !== 0))) return Promise.resolve(current);
    // Claim BEFORE any await. A crash or timeout is uncertain, never an automatic retry.
    const claimed = store.updateDelivery(receiptId, { state: "uncertain", attempts: current.delivery.attempts + 1, queueId: null, error: "Notice transport is in progress; reconcile before retrying." });
    const flight = (async () => {
      let timer: NodeJS.Timeout | undefined;
      let startedSending = false;
      try {
        if (!(await evidence.nativeThread(claimed.delivery.threadId!)).available) throw new Error("Notice destination is unavailable; receipt remains saved.");
        if (disposed) throw new Error("plugin_disposed");
        startedSending = true;
        const sending = bb.sdk.threads.send({ threadId: claimed.delivery.threadId!, mode: "auto", input: [{ type: "text", text: noticeText(claimed), mentions: [], visibility: "agent-only" }] });
        const result = await Promise.race([sending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native notice timed out; delivery may have occurred. Reconcile before explicitly retrying.")), 15_000); })]);
        if (disposed) return claimed;
        const latest = store.getReceipt(receiptId);
        if (latest.delivery.attempts !== claimed.delivery.attempts) return latest;
        return store.updateDelivery(receiptId, { state: result.delivery, queueId: result.delivery === "queued" ? result.queuedMessage.id : null, error: result.delivery === "queued" ? result.queuedMessage.failureReason : null });
      } catch (error) {
        if (disposed) return claimed;
        const message = error instanceof Error ? error.message : String(error);
        // A send exception cannot establish that the native server did nothing.
        return store.updateDelivery(receiptId, { state: startedSending ? "uncertain" : "failed", error: message });
      } finally {
        clearTimeout(timer);
        deliveries.delete(receiptId);
        changed();
      }
    })();
    deliveries.set(receiptId, flight);
    return flight;
  }

  async function checkDelivery(receiptId: string, threadId?: string) {
    await scoped(threadId);
    const receipt = store.getReceipt(receiptId);
    if (!receipt.delivery.threadId || receipt.delivery.state === "disabled" || receipt.delivery.state === "sent") return receipt;
    if (threadId && receipt.delivery.threadId !== threadId) throw new Error("notice_destination_context_mismatch");
    if (deliveries.has(receiptId)) return receipt;
    const state = await evidence.notice(receipt.delivery.threadId, `[Captain's Deck receipt ${receipt.id}]`, Date.parse(receipt.createdAt));
    await scoped(threadId);
    const next = store.updateDelivery(receiptId, state); changed(); return next;
  }

  async function apply(input: ActionInput, provenance: "panel-local" | "local-cli") {
    return committing(input.operationId, async () => {
      await scoped(input.threadId);
      if (input.source) throw new Error("Use explicit native association; local input cannot invent a source row.");
      const setup = await getSetup();
      await scoped(input.threadId);
      const existing = store.findReceiptByOperation(input.operationId);
      const notifyThreadId = existing ? existing.delivery.threadId : idSchema.safeParse(setup.firstMateThreadId).success ? setup.firstMateThreadId : null;
      const receipt = store.applyAction(input, { provenance, notifyThreadId });
      changed();
      // An unusable setting must not discard a recorded action; only its notice fails.
      const delivered = !existing && notifyThreadId === null && setup.firstMateThreadId
        ? store.updateDelivery(receipt.id, { state: "failed", error: setup.reason })
        : await deliver(receipt.id);
      return { task: store.findTask(input.taskId), receipt: delivered };
    });
  }

  async function associate(input: z.infer<typeof rpcContract.deck_associate.input>, provenance: "chat-selected" | "producer-selected", context?: PluginAgentToolContext) {
    return committing(input.operationId, async () => {
      await guard(input.threadId, context);
      const existing = store.findReceiptByOperation(input.operationId);
      if (existing) {
        const receipt = store.applyAction({ ...input, response: existing.input.response }, { provenance, notifyThreadId: existing.delivery.threadId });
        return { task: store.findTask(input.taskId), receipt: await deliver(receipt.id) };
      }
      const row = await evidence.original(input.source);
      await guard(input.threadId, context);
      const task = store.getTask(input.taskId);
      if (!task.call || task.call.generation !== input.generation) throw new Error("Stale call generation");
      if (task.call.replyThreadId !== input.threadId || row.threadId !== input.threadId) throw new Error("This response belongs to another conversation than the call");
      if (row.text.length > 16000) throw new Error("Original response exceeds 16000 characters; inspect its exact source and submit a bounded native response.");
      const receipt = store.applyAction({ ...input, response: row.text }, { provenance, sourceRow: row, notifyThreadId: input.threadId });
      changed();
      const delivered = await deliver(receipt.id);
      return { task: store.findTask(input.taskId), receipt: delivered };
    });
  }

  async function post(input: z.infer<typeof rpcContract.deck_call_post.input>, context?: PluginAgentToolContext) {
    await guard(input.threadId, context);
    const turn = await evidence.captureTurn(input.threadId);
    await guard(input.threadId, context);
    const result = store.prepareCall({ taskId: input.taskId, expectedRevision: input.expectedRevision, payload: input.payload, threadId: input.threadId, turnId: turn.turnId, afterSeq: turn.afterSeq });
    changed();
    return result;
  }

  async function observePending() {
    let cursor: string | undefined;
    do {
      const page = store.pendingCalls({ cursor, limit: 100 });
      for (const task of page.tasks) {
        const pending = task.pendingCall;
        if (disposed || !pending || pending.state !== "pending") continue;
        const configured = (await settings.get()).firstMateThreadId.trim();
        const current = store.findTask(task.id);
        if (!current || current.revision !== task.revision || current.pendingCall?.generation !== pending.generation || current.pendingCall.state !== "pending") continue;
        if (pending.threadId !== configured) { store.failCall(task.id, pending.generation, "Producer configuration changed; previous call preserved.", task.revision); changed(); continue; }
        try {
          await guard(pending.threadId);
          const result = await evidence.turnRows(pending.threadId, pending.turnId);
          await guard(pending.threadId);
          const latest = store.findTask(task.id);
          if (!latest || latest.revision !== task.revision || latest.pendingCall?.generation !== pending.generation || latest.pendingCall.state !== "pending") continue;
          if (result.state === "active") continue;
          if (result.state !== "completed" || !result.complete) { store.failCall(task.id, pending.generation, `Origin turn ${result.state}; previous call preserved.`, task.revision); changed(); continue; }
          const marker = `[Captain's Deck ${task.id} generation ${pending.generation}]`;
          const rows = result.rows.filter((row) => row.role === "assistant" && row.completed && row.sourceSeqEnd > pending.afterSeq && row.text.includes(pending.block));
          if (rows.length !== 1 || rows[0]!.text.split(pending.block).length !== 2 || rows[0]!.text.split(marker).length !== 2) { store.failCall(task.id, pending.generation, "Origin block is missing, changed or ambiguous; previous call preserved.", task.revision); changed(); continue; }
          store.publishCall(task.id, pending.generation, rows[0]!, task.revision); changed();
        } catch (error) {
          // Keep the reservation visible and cancellable during native-history outages.
          bb.log.warn(`Deck proposal ${task.id}/${pending.generation}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && !disposed);
  }

  function refreshPending() {
    if (disposed) return Promise.resolve();
    if (observing) { observeAgain = true; return observing; }
    observing = (async () => { do { observeAgain = false; await observePending(); } while (observeAgain && !disposed); })().finally(() => { observing = null; });
    return observing;
  }

  bb.rpc.register(rpcContract, {
    getSetup: async () => getSetup(),
    deck_board: async (input) => { await refreshPending(); return store.listBoard(input ?? { limit: 50 }); },
    deck_get: async ({ taskId, threadId }) => { await scoped(threadId); const page = store.listReceipts(taskId, { limit: 30 }); return { task: store.getTask(taskId), receipts: page.receipts, nextCursor: page.nextCursor }; },
    deck_calls: async (input) => { await guard(input.threadId); await refreshPending(); await guard(input.threadId); return store.listCalls(input); },
    deck_action: async (input) => apply(input, "panel-local"),
    deck_answer: async (input) => apply(input, "panel-local"),
    deck_seen: async ({ taskId, generation, threadId }) => { await scoped(threadId); const result = store.markSeen(taskId, generation); changed(); return result; },
    deck_source: async ({ taskId, generation, threadId, offset, limit }) => { await scoped(threadId); const task = store.getTask(taskId); const call = [task.call, ...task.history].find((call) => call?.generation === generation); if (!call) throw new Error("call_generation_missing"); if (!call.source) return null; const result = await evidence.source(call.source, offset, limit); await scoped(threadId); return result; },
    deck_candidates: async ({ threadId, taskId, generation, afterSeq, limit }) => {
      await guard(threadId);
      const task = store.getTask(taskId);
      if (!task.call || task.call.generation !== generation || task.call.replyThreadId !== threadId) throw new Error("This call has no response boundary in the configured conversation.");
      const result = await evidence.forwardRows(threadId, Math.max(afterSeq ?? 0, task.call.replyAfterSeq), limit);
      await guard(threadId);
      if (store.getTask(taskId).call?.generation !== generation) throw new Error("call_generation_changed");
      const rows = result.rows.filter((row) => row.role === "user" && row.completed && row.initiator === "user" && row.senderThreadId === null && row.visibility === null && row.sourceSeqStart > task.call!.replyAfterSeq);
      // Keep the cursor usable after an oversized response. Never associate a truncated substitute.
      return { ...result, rows: rows.filter((row) => row.text.length <= 16000), omitted: rows.filter((row) => row.text.length > 16000).map(sourceRef) };
    },
    deck_associate: async (input) => associate(input, "chat-selected"),
    deck_call_post: async (input) => post(input),
    deck_cancel_call: async ({ taskId, generation, expectedRevision, operationId, threadId }) => { await scoped(threadId); const result = store.cancelCall(taskId, generation, expectedRevision, operationId); changed(); return result; },
    deck_receipts: async ({ taskId, threadId, cursor, limit }) => { await scoped(threadId); return store.listReceipts(taskId, { cursor, limit }); },
    deck_delivery_check: async ({ receiptId, threadId }) => checkDelivery(receiptId, threadId),
    deck_delivery_retry: async ({ receiptId, threadId, acknowledgeDuplicateRisk }) => {
      const checked = await checkDelivery(receiptId, threadId);
      if (checked.delivery.state === "sent" || checked.delivery.state === "disabled") return checked;
      if (checked.delivery.state === "queued") {
        if (!checked.delivery.queueId || !checked.delivery.error) return checked;
        const result = await bb.sdk.threads.queuedMessages.send({ threadId: checked.delivery.threadId!, queuedMessageId: checked.delivery.queueId, mode: "auto" });
        await scoped(threadId);
        const receipt = store.updateDelivery(receiptId, { state: result.delivery, attempts: checked.delivery.attempts + 1, queueId: result.delivery === "queued" ? result.queuedMessage.id : null, error: result.delivery === "queued" ? result.queuedMessage.failureReason : null }); changed(); return receipt;
      }
      if (checked.delivery.state === "uncertain" && !acknowledgeDuplicateRisk) throw new Error("Native transport has no idempotency key. Reconcile first, then explicitly acknowledge the risk of a duplicate notice.");
      await scoped(threadId); return deliver(receiptId, true);
    },
    deck_export: async () => store.exportSnapshot(),
    deck_import: async (snapshot) => { const result = store.importSnapshot(snapshot); changed(); return result; },
  });

  registerDeckCli(bb, store, { changed, action: apply, async ask(taskId, expectedRevision, payload: CallPayload, threadId?: string) {
    const setup = await getSetup();
    let replyAfterSeq = 0;
    let replyThreadId: string | null = null;
    if (setup.valid) { replyAfterSeq = await evidence.highWater(setup.firstMateThreadId); await guard(setup.firstMateThreadId); replyThreadId = setup.firstMateThreadId; }
    const task = store.openCall({ taskId, expectedRevision, payload, source: null, replyThreadId, replyAfterSeq, provenance: "local-cli", ...(threadId === undefined ? {} : { threadId }) }); changed(); return task;
  } });

  const toolNames = ["deck_call_post", "deck_call_associate", "deck_call_cancel"];
  bb.agents.registerTool({ name: "deck_call_post", description: "Prepare a DO, DECIDE or APPROVE Captain action on an existing Deck card. Copy the returned block verbatim into your final visible assistant reply. Only the configured first mate conversation can use it. The previous call stays until that one exact completed native row is committed.", parameters: z.object({ taskId: idSchema, expectedRevision: versionSchema, payload: callPayloadSchema }).strict(), async execute(input, context) { return JSON.stringify(await post({ ...input, threadId: context.threadId }, context)); } });
  bb.agents.registerTool({ name: "deck_call_associate", description: "Explicitly select an original committed native user response for one current Deck call generation/revision. Preserve exact source text; ambiguous text stays unresolved. Approval records never execute anything externally.", parameters: rpcContract.deck_associate.input.omit({ threadId: true }), async execute(input, context) { return JSON.stringify(await associate({ ...input, threadId: context.threadId }, "producer-selected", context)); } });
  bb.agents.registerTool({ name: "deck_call_cancel", description: "Cancel an unpublished call proposal; preserve the previous current call and consume no human completion/approval.", parameters: rpcContract.deck_cancel_call.input.omit({ threadId: true }), async execute(input, context) { await guard(context.threadId, context); const result = store.cancelCall(input.taskId, input.generation, input.expectedRevision, input.operationId); changed(); return JSON.stringify(result); } });
  let producerId = (await settings.get()).firstMateThreadId.trim();
  settings.onChange((next) => { producerId = next.firstMateThreadId.trim(); changed(); void refreshPending().catch((error) => bb.log.warn(String(error))); });
  bb.agents.configure((context) => ({ skills: ["captains-deck"], tools: context.thread.id === producerId ? toolNames : [], instructions: context.thread.id === producerId ? "Captain's Deck is the one work/action store. Native calls use deck_call_post, then reproduce its exact block in a visible final reply. Explicitly associate only a selected committed source response and the current card generation/revision; never infer approval or completion. The Needs my attention native thread-panel tab is the Captain's view; the full Deck remains available." : "" }));
  bb.events.on("experimental_thread.events", ({ thread }) => { if (thread.id === producerId) void refreshPending().catch((error) => bb.log.warn(String(error))); });
  bb.events.on("thread.idle", ({ thread }) => { if (thread.id === producerId) void refreshPending().catch((error) => bb.log.warn(String(error))); });
  bb.events.on("thread.failed", ({ thread }) => { if (thread.id === producerId) void refreshPending().catch((error) => bb.log.warn(String(error))); });
  bb.events.on("turn.failed", ({ threadId }) => { if (threadId === producerId) void refreshPending().catch((error) => bb.log.warn(String(error))); });
  bb.events.on("message.dispatched", ({ entry }) => {
    if (entry.threadId !== producerId) return;
    const marker = entry.content.find((input) => input.type === "text" && input.visibility === "agent-only" && /^\[Captain's Deck receipt [A-Za-z0-9_.:-]+\]\n/.test(input.text));
    if (!marker || marker.type !== "text") return;
    const receiptId = /^\[Captain's Deck receipt ([A-Za-z0-9_.:-]+)\]/.exec(marker.text)![1]!;
    try { const receipt = store.getReceipt(receiptId); if (receipt.delivery.threadId === entry.threadId && receipt.delivery.queueId === entry.id) { store.updateDelivery(receiptId, { state: "sent", queueId: null, error: null }); changed(); } } catch (error) { bb.log.warn(String(error)); }
  });
  bb.events.on("message.cancelled", ({ entry }) => {
    const marker = entry.content.find((input) => input.type === "text" && input.visibility === "agent-only" && /^\[Captain's Deck receipt [A-Za-z0-9_.:-]+\]\n/.test(input.text));
    if (!marker || marker.type !== "text") return;
    const receiptId = /^\[Captain's Deck receipt ([A-Za-z0-9_.:-]+)\]/.exec(marker.text)![1]!;
    try { const receipt = store.getReceipt(receiptId); if (receipt.delivery.queueId === entry.id) { store.updateDelivery(receiptId, { state: "failed", queueId: null, error: "Native notice was removed from the queue; receipt remains saved." }); changed(); } } catch (error) { bb.log.warn(String(error)); }
  });
  bb.background.service("deck-pending-reconcile", { async start(signal) {
    await refreshPending();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } });
  bb.onDispose(() => { disposed = true; observeAgain = false; });
  bb.log.info("captains-deck loaded: one transactional card store; legacy KV preserved");
}
