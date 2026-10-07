import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { cardSchema, cardsPageSchema, receiptSchema } from "../contract";

const actionResult = z.object({ task: cardSchema, receipt: receiptSchema });
type AsyncResult<F> = F extends (...args: never[]) => Promise<infer Result> ? Result : never;
type NativeEvent = AsyncResult<BbPluginApi["sdk"]["threads"]["events"]["list"]>[number];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

async function fixture(notify = false) {
  let sendAttempts = 0;
  const native = {
    completed: false,
    text: "",
    failSend: false,
  };
  const host = createFakePluginHost({ pluginId: "captains-deck", agentSkillIds: ["captains-deck"], settings: { firstMateThreadId: notify ? "producer" : "" }, sdk: {
    projects: { get: async () => ({ id: "personal", name: "Synthetic", kind: "personal", sources: [], gitRemoteUrl: null, createdAt: 1, updatedAt: 1 }) },
    threads: {
      get: async () => makeThreadResponse({ id: "producer", projectId: "personal", environmentId: null, title: "CoS synthetic", visibility: "visible", archivedAt: null, deletedAt: null }),
      send: async () => { sendAttempts++; if (native.failSend) throw new Error("Synthetic ambiguous transport failure"); return { ok: true, delivery: "sent" }; },
      queuedMessages: { list: async () => [] },
      events: { list: async (args) => {
        const boundaries: NativeEvent[] = [{ id: "start", threadId: "producer", seq: 10, createdAt: 1010, scope: { kind: "turn", turnId: "turn1" }, type: "turn/started", data: { providerThreadId: "provider" } }];
        if (native.completed) boundaries.push({ id: "end", threadId: "producer", seq: 30, createdAt: 1030, scope: { kind: "turn", turnId: "turn1" }, type: "turn/completed", data: { providerThreadId: "provider", status: "completed" } });
        return boundaries.filter((event) => (!args.types || args.types.includes(event.type)) && (args.afterSeq === undefined || event.seq > Number(args.afterSeq)) && (args.beforeSeq === undefined || event.seq < Number(args.beforeSeq))).sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit ?? 100));
      } },
      timeline: async () => ({ activeBackgroundCommands: [], activePromptMode: null, activeThinking: null, activeWorkflows: [], completedTurnDisplay: "collapse", contextBoundarySeq: null, goal: null, maxSeq: 30, modelFallback: null, pendingTodos: null, rows: [{ kind: "turn", id: "turn:turn1", threadId: "producer", turnId: "turn1", sourceSeqStart: 10, sourceSeqEnd: 30, createdAt: 1010, startedAt: 1010, status: native.completed ? "completed" : "pending", completedAt: native.completed ? 1030 : null, summaryCount: 2, children: null }], timelinePage: { kind: "latest", hasOlderRows: false, olderCursor: null, returnedSegmentCount: 1, segmentLimit: 100 } }),
      timelineTurnSummaryDetails: async () => ({ rows: native.text ? [{ kind: "conversation", role: "assistant", id: "assistant:original", threadId: "producer", turnId: "turn1", sourceSeqStart: 20, sourceSeqEnd: 22, createdAt: 1020, startedAt: 1020, text: native.text, attachments: null, turnRequest: null }] : [], olderCursor: null, historySnapshot: "snapshot1" }),
    },
  } });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  return { ...host, native, sends: () => sendAttempts };
}

async function chart(host: FakePluginHost, title: string) {
  const result = await host.harness.behavior.runCli(["chart", "--title", title, "--json"]);
  expect(result.exitCode).toBe(0);
  return cardSchema.parse(JSON.parse(result.stdout!));
}

describe("one authoritative Deck mutation boundary", () => {
  it("does not lose overlapping CLI writers and exposes every created card", async () => {
    const host = await fixture();
    const expected = Array.from({ length: 40 }, (_, i) => `Work ${i}`);
    await Promise.all(expected.map((title) => chart(host, title)));
    const page = cardsPageSchema.parse(await host.harness.behavior.callRpc("deck_board", { limit: 100 }));
    expect(page.tasks.map((task) => task.title).sort()).toEqual([...expected].sort());
    expect(page.counts).toMatchObject({ total: 40, attention: 0, unresolved: 0, unseen: 0 });
  });
  it("records DO clarification without completing work, then clears only the DO with the same shared action path", async () => {
    const host = await fixture();
    let task = await chart(host, "Human-only DO");
    const ask = await host.harness.behavior.runCli(["ask", task.id, "--kind", "DO", "--question", "Review the synthetic evidence", "--json"]);
    expect(ask.exitCode).toBe(0); task = cardSchema.parse(JSON.parse(ask.stdout!));
    const first = actionResult.parse(await host.harness.behavior.callRpc("deck_answer", { taskId: task.id, generation: task.call!.generation, expectedRevision: task.revision, operationId: "clarify", action: "answer", response: "Which evidence?" }));
    expect(first.task).toMatchObject({ state: "charted", call: { status: "open", answerNote: "Which evidence?" } });
    const second = actionResult.parse(await host.harness.behavior.callRpc("deck_action", { taskId: task.id, generation: task.call!.generation, expectedRevision: first.task.revision, operationId: "complete", action: "complete" }));
    expect(second.task).toMatchObject({ state: "charted", call: { status: "completed" } });
    expect(second.receipt.delivery.state).toBe("disabled");
  });
  it("keeps an uncertain native notice visible and never sends it again on an action replay", async () => {
    const host = await fixture(true); host.native.failSend = true;
    let task = await chart(host, "Decision");
    const ask = await host.harness.behavior.runCli(["ask", task.id, "--question", "Choose", "--option", "A :: Evidence", "--json"]);
    expect(ask.exitCode).toBe(0); task = cardSchema.parse(JSON.parse(ask.stdout!));
    const input = { taskId: task.id, generation: task.call!.generation, expectedRevision: task.revision, operationId: "answer1", action: "answer", optionId: "o1" };
    const result = actionResult.parse(await host.harness.behavior.callRpc("deck_action", input));
    expect(result.task.call!.status).toBe("answered");
    expect(result.receipt.delivery).toMatchObject({ state: "uncertain", attempts: 1, error: "Synthetic ambiguous transport failure" });
    const replay = actionResult.parse(await host.harness.behavior.callRpc("deck_action", input));
    expect(replay.receipt).toEqual(result.receipt);
    expect(host.sends()).toBe(1);
    await expect(host.harness.behavior.callRpc("deck_delivery_retry", { receiptId: result.receipt.id })).rejects.toThrow("duplicate notice");
    expect(host.sends()).toBe(1);
  });
  it("denies wrong-conversation attention and fabricated local source rows without modifying the card", async () => {
    const host = await fixture(true);
    let task = await chart(host, "Context guarded");
    const ask = await host.harness.behavior.runCli(["ask", task.id, "--question", "Ask", "--json"]);
    expect(ask.exitCode).toBe(0); task = cardSchema.parse(JSON.parse(ask.stdout!));
    await expect(host.harness.behavior.callRpc("deck_calls", { threadId: "wrong", view: "attention" })).rejects.toThrow("configured first mate");
    await expect(host.harness.behavior.callRpc("deck_action", { taskId: task.id, threadId: "wrong", expectedRevision: task.revision, generation: task.call!.generation, operationId: "bad1", action: "dismiss" })).rejects.toThrow("configured first mate");
    await expect(host.harness.behavior.callRpc("deck_action", { taskId: task.id, expectedRevision: task.revision, generation: task.call!.generation, operationId: "bad2", action: "answer", response: "invented", source: { threadId: "producer", turnId: "turn1", rowId: "invented", sourceSeqStart: 100, sourceSeqEnd: 101, contentSha256: "0".repeat(64) } })).rejects.toThrow("cannot invent");
    const actual = z.object({ task: cardSchema }).passthrough().parse(await host.harness.behavior.callRpc("deck_get", { taskId: task.id }));
    expect(actual.task.revision).toBe(task.revision);
    expect(actual.task.call!.status).toBe("open");
  });
  it("publishes only the exact completed producer row, retaining a previous call while the turn is active", async () => {
    const host = await fixture(true);
    let task = await chart(host, "Native origin");
    const old = await host.harness.behavior.runCli(["ask", task.id, "--question", "Previous call", "--json"]);
    task = cardSchema.parse(JSON.parse(old.stdout!));
    const posted = z.object({ task: cardSchema, generation: z.number(), block: z.string() }).parse(await host.harness.behavior.callRpc("deck_call_post", { taskId: task.id, threadId: "producer", expectedRevision: task.revision, payload: { kind: "DECIDE", ask: "Native exact call", recommendation: "Inspect original", options: [], recommendedId: null, context: null, evidence: [], approvalScope: null } }));
    let page = cardsPageSchema.parse(await host.harness.behavior.callRpc("deck_board", null));
    expect(page.tasks[0]!.call!.ask).toBe("Previous call");
    expect(page.tasks[0]!.pendingCall!.state).toBe("pending");
    host.native.text = posted.block; host.native.completed = true;
    page = cardsPageSchema.parse(await host.harness.behavior.callRpc("deck_board", null));
    expect(page.tasks[0]!).toMatchObject({ state: "charted", pendingCall: null, call: { ask: "Native exact call", generation: posted.generation, provenance: "native-origin", replyThreadId: "producer", source: { rowId: "assistant:original", threadId: "producer", turnId: "turn1" } } });
    expect(page.tasks[0]!.history[0]!.ask).toBe("Previous call");
  });
});
