// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../rpc";
import type { PluginNavPanelProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { ActionInput, CaptainCall, CardsPage, DeckCard, NativeRow, Receipt } from "../contract";

const NOW = Date.parse("2026-10-07T12:00:00Z");
function card(index = 1, kind: CaptainCall["kind"] = "DO"): DeckCard {
  return {
    id: `t${index}`, title: `Task ${index}`, brief: "Preserved work brief", kind: "ship", state: "underway",
    threadId: "worker", projectId: null, bot: "First mate", prUrl: null, note: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), landedAt: null,
    revision: 1, nextGeneration: 2, seenGeneration: 0, pendingCall: null, history: [],
    call: { id: `t${index}:1`, generation: 1, kind, ask: `Please handle call ${index}`, recommendation: "Keep the existing work lane", options: [], recommendedId: null,
      context: "Call context", evidence: [], approvalScope: kind === "APPROVE" ? { action: "Publish", target: "Synthetic target", constraints: "Only this target" } : null,
      source: null, replyThreadId: "cos", replyAfterSeq: 10, provenance: "local-cli", askedAt: new Date(NOW).toISOString(), answeredAt: null,
      status: "open", answerId: null, answerLabel: null, answerNote: null, deferUntil: null },
  };
}

interface FakeHost {
  rpc: PluginRpcTestHandlers<typeof rpcContract>;
  setDelivery(value: Receipt["delivery"]["state"]): void;
  setAmbiguous(): void;
  setRows(rows: NativeRow[]): void;
  setSource(text: string): void;
  replace(cards: DeckCard[]): void;
}

// A fake public host supplies wire results; domain correctness is separately
// covered by the real SQLite store suite. These tests exercise visible controls.
function host(initial = [card()]): FakeHost {
  let tasks = structuredClone(initial);
  const receipts: Receipt[] = [];
  const applied = new Map<string, { task: DeckCard; receipt: Receipt }>();
  let state: Receipt["delivery"]["state"] = "sent";
  let ambiguous = false;
  let nativeRows: NativeRow[] = [];
  let sourceText = "Exact original native source row";
  const page = (cursor?: string, view?: "attention" | "deferred" | "closed"): CardsPage => {
    const open = tasks.filter((task) => task.call?.status === "open" || (task.call?.status === "deferred" && task.call.deferUntil !== null && task.call.deferUntil <= Date.now()));
    const deferred = tasks.filter((task) => task.call?.status === "deferred");
    const closed = tasks.filter((task) => task.call && ["completed", "dismissed", "answered"].includes(task.call.status));
    const all = view === "attention" ? open : view === "deferred" ? deferred : view === "closed" ? closed : tasks;
    const offset = Number(cursor ?? 0);
    const window = all.slice(offset, offset + 100);
    return { tasks: structuredClone(window), nextCursor: offset + 100 < all.length ? String(offset + 100) : null, serverNow: Date.now(),
      counts: { total: tasks.length, attention: open.length, unresolved: open.length + deferred.filter((task) => !open.includes(task)).length,
        unseen: tasks.filter((task) => task.call && task.seenGeneration < task.call.generation).length, deferred: deferred.length, closed: closed.length },
      nextDueAt: deferred.reduce<number | null>((next, task) => task.call!.deferUntil !== null && task.call!.deferUntil! > Date.now() ? Math.min(next ?? Infinity, task.call!.deferUntil!) : next, null) };
  };
  const action = (input: ActionInput) => {
    const replay = applied.get(input.operationId);
    if (replay) return structuredClone(replay);
    if (input.response !== undefined && !input.response.trim()) throw new Error("Response must not be blank");
    const task = tasks.find((value) => value.id === input.taskId)!;
    const call = task.call!;
    if (input.action === "answer") { call.answerNote = input.response ?? null; if (call.kind !== "DO") call.status = "answered"; }
    if (input.action === "complete") call.status = "completed";
    if (input.action === "dismiss") call.status = "dismissed";
    if (input.action === "defer") { call.status = "deferred"; call.deferUntil = input.deferUntil ?? null; }
    if (input.action === "reopen") { task.history.push(structuredClone(call)); call.generation++; call.status = "open"; }
    const fromRevision = task.revision++;
    const receipt: Receipt = { id: `r${receipts.length + 1}`, taskId: task.id, generation: input.generation, fromRevision, toRevision: task.revision, input: structuredClone(input),
      source: input.source ?? null, sourceCreatedAt: input.source ? NOW : null, provenance: input.source ? "chat-selected" : "panel-local", createdAt: new Date(NOW + receipts.length).toISOString(),
      delivery: { state, threadId: "cos", queueId: state === "queued" ? "queue-1" : null, error: ["failed", "uncertain"].includes(state) ? "Native notice transport failed" : null, attempts: 1 } };
    receipts.unshift(receipt);
    const result = structuredClone({ task, receipt });
    applied.set(input.operationId, result);
    if (ambiguous) { ambiguous = false; throw new Error("Transport timed out after commit"); }
    return result;
  };
  const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
    getSetup: () => ({ firstMateThreadId: "cos", producer: { threadId: "cos", projectId: "project", title: "Synthetic CoS" }, valid: true, reason: null }),
    deck_calls: (input) => page(input.cursor, input.view),
    deck_board: (input: { cursor?: string } | null) => page(input?.cursor),
    deck_get: (input: { taskId: string }) => ({ task: structuredClone(tasks.find((task) => task.id === input.taskId) ?? null), receipts: structuredClone(receipts.filter((receipt) => receipt.taskId === input.taskId).slice(0, 30)), nextCursor: null }),
    deck_seen: (input: { taskId: string; generation: number }) => { const task = tasks.find((task) => task.id === input.taskId); if (!task?.call || task.call.generation !== input.generation) return null; task.seenGeneration = input.generation; return structuredClone(task); },
    deck_action: action,
    deck_answer: action,
    deck_associate: (input: Omit<ActionInput, "response"> & { source: NonNullable<ActionInput["source"]> }) => action({ ...input, response: nativeRows.find((row) => row.rowId === input.source.rowId)!.text }),
    deck_source: (input: { taskId: string; offset?: number; limit?: number }) => {
      const task = tasks.find((task) => task.id === input.taskId);
      if (!task?.call?.source) return null;
      const offset = input.offset ?? 0, end = Math.min(sourceText.length, offset + (input.limit ?? 8000));
      return { status: "verified" as const, ref: task.call.source, text: sourceText.slice(offset, end), nextOffset: end < sourceText.length ? end : null, totalLength: sourceText.length, sourceCreatedAt: NOW };
    },
    deck_candidates: (input: { afterSeq?: number }) => ({ rows: structuredClone(nativeRows.filter((row) => row.sourceSeqEnd > (input.afterSeq ?? 10))), omitted: [], nextSeq: nativeRows.at(-1)?.sourceSeqEnd ?? 10, hasMore: false }),
    deck_receipts: () => ({ receipts: [], nextCursor: null }),
    deck_delivery_check: (input: { receiptId: string }) => structuredClone(receipts.find((receipt) => receipt.id === input.receiptId)!),
    deck_delivery_retry: (input) => {
      if (!input.acknowledgeDuplicateRisk) throw new Error("Explicit acknowledgement required");
      const receipt = receipts.find((value) => value.id === input.receiptId)!; receipt.delivery.state = "queued"; receipt.delivery.queueId = "queue-2"; receipt.delivery.attempts++; return structuredClone(receipt);
    },
    deck_cancel_call: (input: { taskId: string }) => { const task = tasks.find((value) => value.id === input.taskId)!; if (task.pendingCall) { task.pendingCall.state = "failed"; task.pendingCall.error = "Cancelled"; } return structuredClone(task); },
    deck_call_post: () => { throw new Error("No producer post is exercised by this UI fixture"); },
    deck_export: () => ({ format: "captains-deck", version: 1, tasks: structuredClone(tasks), receipts: structuredClone(receipts), generations: tasks.map((task) => ({ taskId: task.id, nextGeneration: task.nextGeneration })), commands: [] }),
    deck_import: () => { throw new Error("No import is exercised by this UI fixture"); },
  };
  return { rpc, setDelivery: (value: typeof state) => { state = value; }, setAmbiguous: () => { ambiguous = true; }, setRows: (rows: NativeRow[]) => { nativeRows = rows; }, setSource: (text: string) => { sourceText = text; }, replace: (cards: DeckCard[]) => { tasks = structuredClone(cards); } };
}

async function attention(fake: FakeHost, threadId = "cos") {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot<PluginThreadPanelProps, typeof rpcContract>(app.threadPanelActions[0]!, { threadId, params: null }, { rpc: fake.rpc });
}
async function openFirst() {
  await userEvent.click(await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ }));
  await screen.findByRole("button", { name: "Complete DO" });
}

async function expandSection(title: string) {
  await userEvent.click(screen.getByText(title, { selector: "summary" }));
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared Deck and native attention controls", () => {
  it("keeps the list mounted behind a dialog and restores its trigger on Escape", async () => {
    const second = card(2);
    await attention(host([card(), second]));
    const trigger = await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Captain's Call" });
    await within(dialog).findByRole("button", { name: "Complete DO" });
    expect(trigger.isConnected).toBe(true);
    expect(document.querySelectorAll(".deck-attention-card")).toHaveLength(2);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("button", { name: /Task 2.*Please handle call 2/ })).toBeTruthy();
  });

  it("closes a removed selection quietly and refreshes its list", async () => {
    const fake = host();
    const mounted = await attention(fake);
    await openFirst();
    fake.replace([]);
    await act(async () => { mounted.behavior.emitRealtime("deck-changed", {}); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText(/No explicit open or due Captain calls/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No deck task/)).toBeNull();
  });

  it("closes when the card no longer carries a call", async () => {
    const fake = host();
    const mounted = await attention(fake);
    await openFirst();
    const remaining = card(); remaining.call = null;
    fake.replace([remaining]);
    await act(async () => { mounted.behavior.emitRealtime("deck-changed", {}); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["DO", "DECIDE", "APPROVE"] as const)("shows only the %s primary controls and keeps long context collapsed", async (kind) => {
    const task = card(1, kind);
    task.call!.context = "Long context paragraph. ".repeat(500);
    await attention(host([task]));
    await userEvent.click(await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ }));
    const dialog = await screen.findByRole("dialog");
    if (kind === "DO") {
      await within(dialog).findByRole("button", { name: "Complete DO" });
      expect(within(dialog).getByRole("button", { name: "Save clarification" })).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: "Approve exact scope" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Save answer" })).toBeNull();
    } else if (kind === "DECIDE") {
      await within(dialog).findByRole("button", { name: "Save answer" });
      expect(within(dialog).queryByRole("button", { name: "Complete DO" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Approve exact scope" })).toBeNull();
    } else {
      await within(dialog).findByRole("button", { name: "Approve exact scope" });
      expect(within(dialog).getByRole("button", { name: "Decline exact scope" })).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: "Complete DO" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Save answer" })).toBeNull();
    }
    const context = within(dialog).getByText("Context", { selector: "summary" }).parentElement as HTMLDetailsElement;
    expect(context.open).toBe(false);
    await userEvent.click(within(dialog).getByText("Context", { selector: "summary" }));
    expect(context.open).toBe(true);
    expect(context.textContent).toContain(task.call!.context);
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to calls" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps DO clarification unresolved and only Complete DO clears the action, never the work", async () => {
    const fake = host();
    await attention(fake);
    await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Which account should I use?");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByText("Action receipt saved");
    expect(screen.getByRole("button", { name: "Complete DO" })).toBeTruthy();
    expect(screen.getByText(/work lane: underway/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Complete DO" }));
    await screen.findByRole("button", { name: "Reopen call as a new generation" });
    expect(screen.getByText(/work lane: underway/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back to calls" }));
    await screen.findByText(/No explicit open or due Captain calls/);
  });

  it("defer requires future date or explicit indefinite and dismiss is not completion", async () => {
    await attention(host());
    await openFirst();
    await expandSection("Defer or dismiss");
    await userEvent.click(screen.getByRole("button", { name: "Defer call" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Choose a future date/);
    await userEvent.click(screen.getByRole("checkbox", { name: /Defer indefinitely/ }));
    await userEvent.click(screen.getByRole("button", { name: "Defer call" }));
    await screen.findByText("Deferred indefinitely; still unresolved.");
    await userEvent.click(screen.getByRole("button", { name: "Back to calls" }));
    await screen.findByText(/No explicit open or due/);
    await userEvent.click(screen.getByRole("button", { name: /Deferred \(1\)/ }));
    await openFirst();
    await expandSection("Defer or dismiss");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss without approval or completion" }));
    await screen.findByRole("button", { name: "Reopen call as a new generation" });
    expect(screen.getByText(/work lane: underway/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Current Captain call" })).getByText(/dismissed/)).toBeTruthy();
  });

  it("denies other-thread tab without loading card contents", async () => {
    await attention(host(), "other-thread");
    await screen.findByText(/only available inside the configured Chief of Staff conversation/);
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(screen.queryByRole("button", { name: /Complete DO/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open \/ due/ })).toBeNull();
  });

  it.each(["failed", "uncertain", "queued"] as const)("shows saved action separately from %s delivery and requires duplicate-risk acknowledgement", async (delivery) => {
    const fake = host(); fake.setDelivery(delivery);
    await attention(fake); await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Clarification");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByText("Action receipt saved");
    expect(screen.queryByText(/Answer sent/)).toBeNull();
    expect(screen.getByText(delivery === "failed" ? /Notice failed/ : delivery === "uncertain" ? /Notice delivery uncertain/ : /Notice queued/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry notice only" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /retrying the notice may deliver a duplicate/ }));
    await userEvent.click(retry);
    await screen.findByText("Queue: queue-2");
    expect(screen.getAllByText("Action receipt saved")).toHaveLength(1);
  });

  it("replays an unconfirmed action across tab close/reopen without repeating it", async () => {
    const fake = host(); fake.setAmbiguous();
    const mounted = await attention(fake); await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Original clarification");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByRole("button", { name: "Retry same action" });
    mounted.unmount();
    await attention(fake); await openFirst();
    await userEvent.click(screen.getByRole("button", { name: "Retry same action" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry same action" })).toBeNull());
    expect(screen.getAllByText("Action receipt saved")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Action receipts" })).getByText("Original clarification")).toBeTruthy();
  });

  it("pages beyond 256 and reconciles realtime, reconnect and focus without dropping loaded pages", async () => {
    const fake = host(Array.from({ length: 301 }, (_, index) => card(index + 1)));
    const mounted = await attention(fake);
    await screen.findByText("Showing 100 of 301 calls");
    await userEvent.click(screen.getByRole("button", { name: "Load more calls" }));
    await screen.findByText("Showing 200 of 301 calls");
    await userEvent.click(screen.getByRole("button", { name: "Load more calls" }));
    await screen.findByText("Showing 300 of 301 calls");
    await userEvent.click(screen.getByRole("button", { name: "Load more calls" }));
    await screen.findByText("Showing 301 of 301 calls");
    const changed = Array.from({ length: 301 }, (_, index) => card(index + 1)); changed[300]!.title = "Updated final card";
    fake.replace(changed);
    await mounted.behavior.emitRealtime("deck-changed", {});
    await screen.findByText("Updated final card");
    expect(screen.getByText("Showing 301 of 301 calls")).toBeTruthy();
    changed[300]!.title = "Reconnected final card"; fake.replace(changed);
    await mounted.behavior.setRealtimeConnectionState("reconnecting");
    await mounted.behavior.setRealtimeConnectionState("connected");
    await screen.findByText("Reconnected final card");
    changed[300]!.title = "Focused final card"; fake.replace(changed);
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText("Focused final card");
    expect(screen.getByText("Showing 301 of 301 calls")).toBeTruthy();
  });

  it("ignores obsolete slow page responses after a newer realtime reset", async () => {
    const fake = host(Array.from({ length: 101 }, (_, index) => card(index + 1)));
    const original = fake.rpc.deck_calls;
    let release!: (value: CardsPage) => void;
    const oldPage = await original({ threadId: "cos", cursor: "100", view: "attention" });
    fake.rpc.deck_calls = (input) => input.cursor === "100" ? new Promise<CardsPage>((resolve) => { release = resolve; }) : original(input);
    const mounted = await attention(fake);
    await screen.findByText("Showing 100 of 101 calls");
    await userEvent.click(screen.getByRole("button", { name: "Load more calls" }));
    const replacement = card(); replacement.title = "New snapshot card"; fake.replace([replacement]);
    await mounted.behavior.emitRealtime("deck-changed", {});
    await screen.findByText("New snapshot card");
    await act(async () => release(oldPage));
    expect(screen.queryByText("Task 101")).toBeNull();
    expect(screen.getByText("Showing 1 of 1 calls")).toBeTruthy();
  });

  it("refreshes at the next due date and disposes timers when the tab closes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const deferred = card(); deferred.call!.status = "deferred"; deferred.call!.deferUntil = NOW + 2000;
    const mounted = await attention(host([deferred]));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText("Task 1")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2026); });
    expect(screen.getByText("Task 1")).toBeTruthy();
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains fullboard lanes, kind and crew with a separate explicit call projection and card deep link", async () => {
    const task = card(); task.kind = "scout"; task.state = "merge";
    const other = card(2); other.bot = "Other crew"; other.state = "merge"; other.call = null;
    const app = await loadPluginApp(() => import("../app"));
    const mounted = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, { rpc: host([task, other]).rpc });
    const merge = await screen.findByRole("region", { name: "Awaiting Merge" });
    await within(merge).findByText("Task 1");
    expect(within(merge).getByText("SCOUT")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Captain's Call" })).getByText("Task 1")).toBeTruthy();
    await userEvent.click(within(screen.getByRole("group", { name: "Crew filters" })).getByRole("button", { name: /^First mate/ }));
    expect(within(merge).queryByText("Task 2")).toBeNull();
    expect(within(merge).getByText("Task 1")).toBeTruthy();
    await userEvent.click(within(merge).getByRole("button", { name: /Task 1/ }));
    await screen.findByRole("dialog");
    expect(mounted.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "board", options: { subPath: "task/t1" } });
  });

  it("requires explicit approval choice, never infers it from an option or response", async () => {
    const task = card(1, "APPROVE");
    await attention(host([task]));
    await userEvent.click(await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ }));
    await screen.findByRole("button", { name: "Approve exact scope" });
    expect(screen.queryByRole("button", { name: "Save answer" })).toBeNull();
    expect(screen.getByText("Only this target")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Decline exact scope" }));
    await screen.findByText("Explicit decision: decline");
    expect(screen.getByText(/work lane: underway/)).toBeTruthy();
  });

  it("shows exact native source pages separately from native thread navigation and explicit selected chat association", async () => {
    const task = card();
    const source = { threadId: "cos", turnId: "origin-turn", rowId: "origin-row", sourceSeqStart: 8, sourceSeqEnd: 10, contentSha256: "a".repeat(64) };
    task.call!.source = source; task.call!.provenance = "native-origin";
    const row: NativeRow = { threadId: "cos", turnId: "reply-turn", rowId: "reply-row", sourceSeqStart: 11, sourceSeqEnd: 12, contentSha256: "b".repeat(64), text: "Exact original clarification, not paraphrased", role: "user", createdAt: NOW, initiator: "user", senderThreadId: null, completed: true, visibility: null };
    const fake = host([task]); fake.setRows([row]); fake.setSource("A".repeat(8000) + "Last exact source page");
    const mounted = await attention(fake); await openFirst();
    await expandSection("Exact source and provenance");
    await userEvent.click(screen.getByRole("button", { name: "Open source thread" }));
    expect(mounted.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "cos" });
    await userEvent.click(screen.getByRole("button", { name: "Read exact source row" }));
    await screen.findByText("8000 of 8022 characters");
    await userEvent.click(screen.getByRole("button", { name: "Load more source text" }));
    await screen.findByText(/Last exact source page/);
    await expandSection("Associate a committed chat response");
    await userEvent.click(screen.getByRole("button", { name: "Browse native responses" }));
    await screen.findByText(row.text);
    expect(screen.queryByText("Action receipt saved")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /reply-row/ }));
    await userEvent.click(screen.getByRole("button", { name: "Associate selected row as clarification" }));
    await screen.findByText("Action receipt saved");
    expect(within(screen.getByRole("region", { name: "Action receipts" })).getByText(row.text)).toBeTruthy();
    expect(screen.getByText(/Explicitly selected committed native chat row/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Complete DO" })).toBeTruthy();
  });

  it("keeps unresolved and unseen independent after opening a call", async () => {
    const mounted = await attention(host());
    await screen.findByText("1 unresolved · 1 unseen · 1 open or due");
    await openFirst();
    await mounted.behavior.emitRealtime("deck-changed", {});
    await screen.findByText("1 unresolved · 0 unseen · 1 open or due");
    expect(screen.getByRole("button", { name: "Complete DO" })).toBeTruthy();
  });

  it("displays failed publication and cancellation without closing the existing call", async () => {
    const task = card();
    const { kind, ask, recommendation, options, recommendedId, context, evidence, approvalScope } = task.call!;
    task.pendingCall = { generation: 2, payload: { kind, ask: `Replacement: ${ask}`, recommendation, options, recommendedId, context, evidence, approvalScope },
      threadId: "cos", turnId: "unpublished", afterSeq: 10, block: "Exact pending block", state: "failed", error: "The expected native row was not committed" };
    await attention(host([task]));
    await openFirst();
    await screen.findByRole("heading", { name: "Call publication failed" });
    expect(screen.getByText("The expected native row was not committed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel unpublished call" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Call publication failed" })).toBeNull());
    await screen.findByRole("heading", { name: "Call publication cancelled" });
    expect(within(screen.getByRole("region", { name: "Current Captain call" })).getByText("Please handle call 1")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Complete DO" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows source and oversized native-response failures rather than presenting truncated substitutes", async () => {
    const task = card();
    task.call!.source = { threadId: "cos", turnId: "old", rowId: "gone", sourceSeqStart: 1, sourceSeqEnd: 10, contentSha256: "c".repeat(64) };
    const fake = host([task]);
    fake.rpc.deck_source = () => ({ status: "missing", ref: task.call!.source!, text: "", nextOffset: null, totalLength: 0, sourceCreatedAt: null });
    fake.rpc.deck_candidates = () => { throw new Error("Committed native row exceeds 16000 characters"); };
    await attention(fake); await openFirst();
    await expandSection("Exact source and provenance");
    await userEvent.click(screen.getByRole("button", { name: "Read exact source row" }));
    await screen.findByText(/original row is no longer available/);
    await expandSection("Associate a committed chat response");
    await userEvent.click(screen.getByRole("button", { name: "Browse native responses" }));
    await screen.findByText(/Committed native row exceeds 16000/);
    expect(screen.queryByRole("radio", { name: /native/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Associate selected row as clarification" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads earlier-call history and action receipt pages independently", async () => {
    const task = card();
    task.history = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(task.call!), id: `t1:old${index}`, generation: index + 2, ask: `Historic ask ${index}`, status: "answered" as const, answerNote: `Historic answer ${index}` }));
    const fake = host([task]);
    const makeReceipt = (index: number): Receipt => ({ id: `receipt-${index}`, taskId: "t1", generation: 1, fromRevision: 1, toRevision: 2,
      input: { taskId: "t1", generation: 1, expectedRevision: 1, operationId: `old-operation-${index}`, action: "answer", response: `Saved response ${index}` },
      source: null, sourceCreatedAt: null, provenance: "panel-local", createdAt: new Date(NOW + index).toISOString(),
      delivery: { state: "disabled", threadId: null, queueId: null, error: null, attempts: 0 } });
    fake.rpc.deck_get = () => ({ task, receipts: [makeReceipt(1)], nextCursor: "older-receipts" });
    fake.rpc.deck_receipts = () => ({ receipts: [makeReceipt(2)], nextCursor: null });
    await attention(fake); await openFirst();
    expect(screen.queryByText(/Historic ask 7/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Load more earlier calls" }));
    expect(screen.getByText(/Historic ask 7/, { selector: "summary" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more receipts" }));
    await screen.findByText("Saved response 2");
    expect(screen.getByText("Saved response 1")).toBeTruthy();
  });

  it("loads all board cards beyond 256 with global totals", async () => {
    const cards = Array.from({ length: 301 }, (_, index) => { const task = card(index + 1); task.call = null; return task; });
    const app = await loadPluginApp(() => import("../app"));
    renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath: "" }, { rpc: host(cards).rpc });
    await screen.findByText("100 of 301 cards loaded");
    await userEvent.click(screen.getByRole("button", { name: "Load more cards" }));
    await screen.findByText("200 of 301 cards loaded");
    await userEvent.click(screen.getByRole("button", { name: "Load more cards" }));
    await screen.findByText("300 of 301 cards loaded");
    await userEvent.click(screen.getByRole("button", { name: "Load more cards" }));
    await screen.findByText("301 of 301 cards loaded");
    expect(screen.getByText("Task 301")).toBeTruthy();
  });

  it("shows the saved receipt and failed notice when the card is removed during an action", async () => {
    const fake = host();
    fake.setDelivery("failed");
    const apply = fake.rpc.deck_action;
    fake.rpc.deck_action = async (input) => {
      const result = await apply(input);
      fake.replace([]);
      return { task: null, receipt: result.receipt };
    };
    await attention(fake); await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Saved before removal");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByRole("heading", { name: "Card removed" });
    expect(screen.getByText("Action receipt saved")).toBeTruthy();
    expect(screen.getByText(/Notice failed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry same action" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry notice only" })).toBeTruthy();
  });

  it("uses the selected original native timestamp for approval expiry rather than association time", async () => {
    const task = card(1, "APPROVE");
    const expiry = Date.now() - 1000;
    task.call!.approvalScope!.expiresAt = expiry;
    const row: NativeRow = { threadId: "cos", turnId: "approval-turn", rowId: "approval-row", sourceSeqStart: 11, sourceSeqEnd: 12, contentSha256: "d".repeat(64),
      text: "Approve the exact published scope", role: "user", createdAt: expiry - 1000, initiator: "user", senderThreadId: null, completed: true, visibility: null };
    const fake = host([task]); fake.setRows([row]);
    await attention(fake);
    await userEvent.click(await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ }));
    await screen.findByRole("button", { name: "Approve exact scope" });
    expect((screen.getByRole("button", { name: "Approve exact scope" }) as HTMLButtonElement).disabled).toBe(true);
    await expandSection("Associate a committed chat response");
    await userEvent.click(screen.getByRole("button", { name: "Browse native responses" }));
    await userEvent.click(await screen.findByRole("radio", { name: /approval-row/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Selected native decision" }), "approve");
    const associate = screen.getByRole("button", { name: "Associate selected row as answer" }) as HTMLButtonElement;
    expect(associate.disabled).toBe(false);
    await userEvent.click(associate);
    await screen.findByText("Explicit decision: approve");
  });

  it("records an explicit option without an empty response or an inferred default", async () => {
    const task = card(1, "DECIDE");
    task.call!.options = [{ id: "o1", label: "Keep current approach", detail: "Preserved legacy option" }];
    task.call!.recommendedId = "o1";
    await attention(host([task]));
    await userEvent.click(await screen.findByRole("button", { name: /Task 1.*Please handle call 1/ }));
    const option = await screen.findByRole("radio", { name: /Keep current approach/ }) as HTMLInputElement;
    expect(option.checked).toBe(false);
    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await screen.findByText("Selected option: o1");
    expect(screen.queryByRole("button", { name: "Retry same action" })).toBeNull();
  });

  it("refreshes a definitively rejected stale generation and permits an explicit response to the new call", async () => {
    const fake = host();
    const apply = fake.rpc.deck_action;
    let stale = true;
    fake.rpc.deck_action = (input) => {
      if (stale) {
        stale = false;
        const replacement = card(); replacement.revision = 2; replacement.nextGeneration = 4;
        replacement.call!.generation = 3; replacement.call!.ask = "New generation ask";
        fake.replace([replacement]);
        throw new Error("Rejected: Stale call generation");
      }
      return apply(input);
    };
    await attention(fake); await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Old ask response");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByText("Action rejected: Stale call generation");
    await screen.findByText("New generation ask");
    expect(screen.queryByRole("button", { name: "Retry same action" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "New ask response");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByText("Action receipt saved");
  });

  it("keeps an unconfirmed action retryable but frees the card once the source rejects a changed source context", async () => {
    const fake = host();
    fake.rpc.deck_action = () => { throw new Error("The native server did not answer in time"); };
    await attention(fake); await openFirst();
    await userEvent.type(screen.getByRole("textbox", { name: "Response" }), "Clarify this");
    await userEvent.click(screen.getByRole("button", { name: "Save clarification" }));
    await screen.findByText(/was not confirmed/);
    expect(screen.getByRole("button", { name: "Retry same action" })).toBeTruthy();
    fake.rpc.deck_action = () => { throw new Error("Rejected: This response belongs to another conversation than the call"); };
    await userEvent.click(screen.getByRole("button", { name: "Retry same action" }));
    await screen.findByText("Action rejected: This response belongs to another conversation than the call");
    expect(screen.queryByRole("button", { name: "Retry same action" })).toBeNull();
    await expandSection("Defer or dismiss");
    expect(screen.getByRole("button", { name: "Dismiss without approval or completion" })).toBeTruthy();
  });
});
