import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeSdk, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { NativeEvidenceReader } from "../evidence";
import { sourceRef } from "../model";
import { sourceRefSchema, type SourceRef } from "../contract";

type AsyncResult<F> = F extends (...args: never[]) => Promise<infer Result> ? Result : never;
type Sdk = BbPluginApi["sdk"];
type Event = AsyncResult<Sdk["threads"]["events"]["list"]>[number];
type Row = AsyncResult<Sdk["threads"]["timelineTurnSummaryDetails"]>["rows"][number];
type Conversation = Extract<Row, { kind: "conversation" }>;
type Turn = Extract<Row, { kind: "turn" }>;

function fixture() {
  const row: Conversation = { kind: "conversation", role: "assistant", id: "assistant:original", threadId: "producer", turnId: "turn1", sourceSeqStart: 20, sourceSeqEnd: 22, createdAt: 1020, startedAt: 1020, text: "Original native ask", attachments: null, turnRequest: null };
  const turn: Turn = { kind: "turn", id: "turn:turn1", threadId: "producer", turnId: "turn1", sourceSeqStart: 10, sourceSeqEnd: 30, createdAt: 1010, startedAt: 1010, status: "completed", completedAt: 1030, summaryCount: 2, children: null };
  const data = { row, turn, collapsed: false, nested: false, rows: [row] as Conversation[], events: [] as Event[], queue: [] as AsyncResult<Sdk["threads"]["queuedMessages"]["list"]> };
  const fake = createFakeSdk({ pluginId: "captains-deck", overrides: {
    threads: {
      get: async () => makeThreadResponse({ id: "producer", projectId: "personal", environmentId: null, title: "Synthetic CoS", visibility: "visible", archivedAt: null, deletedAt: null }),
      // This runtime serves conversation rows directly and only collapses older turns.
      timeline: async () => ({ activeBackgroundCommands: [], activePromptMode: null, activeThinking: null, activeWorkflows: [], completedTurnDisplay: "collapse", contextBoundarySeq: null, goal: null, maxSeq: 30, modelFallback: null, pendingTodos: null, rows: data.collapsed ? [data.turn] : data.rows, timelinePage: { kind: "latest", hasOlderRows: false, olderCursor: null, returnedSegmentCount: data.rows.length, segmentLimit: 100 } }),
      timelineTurnSummaryDetails: async () => ({ rows: data.collapsed ? data.nested ? [{ ...data.turn, children: data.rows }] : data.rows : [], olderCursor: null, historySnapshot: "snapshot1" }),
      events: { list: async (args) => data.events.filter((event) => (!args.types || args.types.includes(event.type)) && (args.afterSeq === undefined || event.seq > Number(args.afterSeq)) && (args.beforeSeq === undefined || event.seq < Number(args.beforeSeq))).sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit ?? 100)) },
      queuedMessages: { list: async () => data.queue },
    },
    projects: { get: async () => ({ id: "personal", name: "Synthetic", kind: "personal", sources: [], gitRemoteUrl: null, createdAt: 1, updatedAt: 1 }) },
  } });
  const ref: SourceRef = { threadId: row.threadId, turnId: row.turnId!, rowId: row.id, sourceSeqStart: row.sourceSeqStart, sourceSeqEnd: row.sourceSeqEnd, contentSha256: createHash("sha256").update(row.text).digest("hex") };
  return { data, ref, reader: new NativeEvidenceReader(fake.sdk), harness: fake.harness };
}

describe("exact native evidence", () => {
  it.each(["direct", "collapsed", "nested"] as const)("pages exact sources without substitution (%s)", async (shape) => {
    const f = fixture();
    f.data.collapsed = shape !== "direct";
    f.data.nested = shape === "nested";
    f.data.row.text = "A".repeat(17000) + "original suffix";
    f.ref.contentSha256 = createHash("sha256").update(f.data.row.text).digest("hex");
    const first = await f.reader.source(f.ref);
    expect(first).toMatchObject({ status: "verified", text: "A".repeat(16000), nextOffset: 16000, totalLength: 17015, sourceCreatedAt: 1020 });
    expect(await f.reader.source(f.ref, first.nextOffset!)).toMatchObject({ status: "verified", text: "A".repeat(1000) + "original suffix", nextOffset: null });
    f.data.rows = [{ ...f.data.row, id: "assistant:nearby" }];
    expect((await f.reader.source(f.ref)).status).toBe("missing");
  });
  it("detects source edits and wrong direct thread lookups", async () => {
    const f = fixture(); f.data.row.text = "edited after capture";
    expect((await f.reader.source(f.ref)).status).toBe("changed");
    expect((await f.reader.nativeThread("wrong-thread")).available).toBe(false);
  });
  it("captures an active turn that has no timeline row yet and refuses a completed boundary", async () => {
    const f = fixture();
    f.data.rows = [];
    f.data.events = [{ id: "start", threadId: "producer", seq: 10, createdAt: 1010, scope: { kind: "turn", turnId: "turn1" }, type: "turn/started", data: { providerThreadId: "provider" } }];
    expect(await f.reader.captureTurn("producer")).toEqual({ turnId: "turn1", afterSeq: 10 });
    f.data.rows = [f.data.row];
    expect((await f.reader.turnRows("producer", "turn1")).rows[0]!.completed).toBe(false);
    f.data.events.push({ id: "end", threadId: "producer", seq: 30, createdAt: 1030, scope: { kind: "turn", turnId: "turn1" }, type: "turn/completed", data: { providerThreadId: "provider", status: "completed" } });
    await expect(f.reader.captureTurn("producer")).rejects.toThrow("origin_active_turn_unavailable");
    const completed = await f.reader.turnRows("producer", "turn1");
    expect(completed.state).toBe("completed");
    expect(completed.rows[0]!.completed).toBe(true);
    expect(await f.reader.turnRows("producer", "other-turn")).toMatchObject({ state: "missing", rows: [] });
  });
  it("requires accepted native user provenance and preserves the exact original text", async () => {
    const f = fixture();
    const text = "  Original response, not inferred  \n";
    f.data.rows = [{ kind: "conversation", role: "user", id: "thr:user|turn:turn1|item:i1", threadId: "producer", turnId: "turn1", sourceSeqStart: 11, sourceSeqEnd: 11, createdAt: 1011, startedAt: 1011, text, attachments: null, mentions: [], initiator: "user", senderThreadId: null, systemMessageKind: "unlabeled", systemMessageSubject: null, turnRequest: { kind: "message", status: "accepted", isGrouped: false } }];
    f.data.events = [
      { id: "turn-start", threadId: "producer", seq: 12, createdAt: 1012, scope: { kind: "turn", turnId: "turn1" }, type: "turn/started", data: { providerThreadId: "provider1" } },
      { id: "request-event", threadId: "producer", seq: 11, createdAt: 1011, scope: { kind: "thread" }, type: "client/turn/requested", data: { direction: "outbound", execution: { model: "synthetic", permissionMode: "full", reasoningLevel: "high", serviceTier: "default", source: "client/turn/requested" }, initiator: "user", senderThreadId: null, input: [{ type: "text", text, mentions: [] }], request: { method: "turn/start", params: {} }, requestId: "req1", source: "tell", target: { kind: "new-turn" } } },
      { id: "accepted-event", threadId: "producer", seq: 15, createdAt: 1015, scope: { kind: "turn", turnId: "turn1" }, type: "turn/input/accepted", data: { clientRequestId: "req1", providerThreadId: "provider1" } },
    ];
    const result = await f.reader.forwardRows("producer", 0);
    expect(result.rows[0]).toMatchObject({ text, initiator: "user", senderThreadId: null, completed: true, visibility: null });
    // Real native input is committed before the provider turn starts.
    expect(await f.reader.original(sourceRef(result.rows[0]!))).toEqual(result.rows[0]);
    f.data.events = f.data.events.filter((event) => event.type !== "turn/input/accepted");
    await expect(f.reader.original(sourceRef(result.rows[0]!))).rejects.toThrow("source_input_not_accepted");
  });

  // Captured from BB 0.45: composed row ids, no rows under summaryOnly, and a
  // producer block surrounded by the assistant's own text.
  it("reads a captured BB 0.45 producer row with its composed id", async () => {
    const f = fixture();
    const block = "[Captain's Deck e4067cc601aa4e38 generation 1]\nKind: DO\nTask: e4067cc601aa4e38\nCall generation: 1\nAsk: Synthetic DO: inspect the original evidence";
    const captured: Conversation = { kind: "conversation", role: "assistant", id: "thr_ncewhzgfws:assistant:kind:assistant|turn:da7a616937-t1|parent:root|item:da7a616937-i1", threadId: "producer", turnId: "da7a616937-t1", sourceSeqStart: 39, sourceSeqEnd: 40, createdAt: 1791405046355, startedAt: 1791405046355, text: block, attachments: null, turnRequest: null };
    f.data.rows = [captured];
    f.data.events = [
      { id: "start", threadId: "producer", seq: 34, createdAt: 1791405046000, scope: { kind: "turn", turnId: "da7a616937-t1" }, type: "turn/started", data: { providerThreadId: "12f3dfaf" } },
      { id: "end", threadId: "producer", seq: 41, createdAt: 1791405046400, scope: { kind: "turn", turnId: "da7a616937-t1" }, type: "turn/completed", data: { providerThreadId: "12f3dfaf", status: "completed" } },
    ];
    const result = await f.reader.turnRows("producer", "da7a616937-t1");
    expect(result).toMatchObject({ state: "completed", complete: true });
    expect(result.rows[0]).toMatchObject({ rowId: captured.id, text: block, completed: true, sourceSeqEnd: 40 });
    expect(sourceRefSchema.parse(sourceRef(result.rows[0]!)).rowId).toBe(captured.id);
    expect((await f.reader.source(result.rows[0]!)).status).toBe("verified");
  });
});

describe("notice receipt versus native transport", () => {
  it("distinguishes queued and failed native queue records without claiming sent", async () => {
    const f = fixture(); const marker = "[Captain's Deck receipt op1]";
    f.data.queue = [makeQueueEntry({ id: "q1", threadId: "producer", content: [{ type: "text", text: marker + "\nOriginal notice", mentions: [], visibility: "agent-only" }], failureReason: "Host unavailable" })];
    expect(await f.reader.notice("producer", marker, 0)).toEqual({ state: "queued", queueId: "q1", error: "Host unavailable" });
    f.data.queue = [];
    expect((await f.reader.notice("producer", marker, 0)).state).toBe("uncertain");
  });
});
