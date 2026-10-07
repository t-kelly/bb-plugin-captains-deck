import { describe, expect, it } from "vitest";
import { callPayloadSchema, cardSchema, type ActionInput, type CaptainCall, type NativeRow } from "../contract";
import { applyCallAction, canonical, hash, normalizeLegacyCards, renderCallBlock, sourceRef, validateResponseSource } from "../model";

const now = 1_800_000_000_000;
const oldDecision = {
  question: "Original question", options: [{ id: "o1", label: "Old option" }], recommendedId: "o1", context: "Original context",
  askedAt: "2024-02-01T10:00:00.000Z", answeredAt: null, answerId: null, answerLabel: null, answerNote: null,
};
const oldCard = {
  id: "old-card", title: "Existing ship", brief: "Original brief", kind: "ship", state: "decision", threadId: "worker",
  projectId: "project", bot: "crew", prUrl: "https://example.test/pull/1", note: "Old note", decision: oldDecision,
  createdAt: "2023-01-01T00:00:00.000Z", updatedAt: "2024-02-01T10:00:00.000Z", landedAt: null,
};
function call(kind: CaptainCall["kind"] = "DECIDE"): CaptainCall {
  return { ...normalizeLegacyCards([oldCard])[0]!.call!, kind, provenance: "local-cli", replyThreadId: "producer", replyAfterSeq: 10,
    approvalScope: kind === "APPROVE" ? { action: "Deploy exact commit", target: "staging", constraints: "No production", expiresAt: now + 1000 } : null };
}
function action(type: ActionInput["action"], patch: Partial<ActionInput> = {}): ActionInput {
  return { taskId: "old-card", expectedRevision: 1, generation: 1, operationId: "op", action: type, ...patch };
}
function row(text = "  exact original\n\n"): NativeRow {
  return { threadId: "producer", turnId: "response-turn", rowId: "response", sourceSeqStart: 11, sourceSeqEnd: 12,
    contentSha256: hash(text), text, role: "user", createdAt: now, initiator: "user", senderThreadId: null, completed: true, visibility: null };
}

describe("legacy normalization", () => {
  it("preserves original fields and times, supplies only missing history/detail, and never invents sources", () => {
    const card = normalizeLegacyCards([oldCard])[0]!;
    expect(card.history).toEqual([]);
    expect(card).toMatchObject({ id: oldCard.id, title: oldCard.title, brief: oldCard.brief, kind: oldCard.kind, state: oldCard.state,
      threadId: oldCard.threadId, projectId: oldCard.projectId, bot: oldCard.bot, prUrl: oldCard.prUrl, note: oldCard.note,
      createdAt: oldCard.createdAt, updatedAt: oldCard.updatedAt, landedAt: null, revision: 1, nextGeneration: 2 });
    expect(card.call).toMatchObject({ ask: oldDecision.question, options: [{ id: "o1", label: "Old option", detail: null }], context: oldDecision.context,
      askedAt: oldDecision.askedAt, provenance: "legacy", source: null, replyThreadId: null, replyAfterSeq: 0, status: "open" });
  });

  it("keeps newest-first history order, answers, timestamps and every oversized old value", () => {
    const histories = Array.from({ length: 10 }, (_, index) => ({ ...oldDecision, question: `history ${index}`, askedAt: `old-${index}`,
      answeredAt: `answer-${index}`, answerId: "freeform", answerLabel: "Original answer", answerNote: ` note ${index} ` }));
    const oversized = { ...oldDecision, question: "q".repeat(9000), context: "c".repeat(40000), options: Array.from({ length: 25 }, (_, index) => ({
      id: `o${index}`, label: "label".repeat(1000), detail: "detail".repeat(1000),
    })), recommendedId: "o24" };
    const card = normalizeLegacyCards([{ ...oldCard, decision: oversized, history: histories }])[0]!;
    expect(card.history.map((entry) => entry.ask)).toEqual(histories.map((entry) => entry.question));
    expect(card.history.map((entry) => entry.generation)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(card.history.map((entry) => entry.askedAt)).toEqual(histories.map((entry) => entry.askedAt));
    expect(card.history[0]).toMatchObject({ answerNote: " note 0 ", answeredAt: "answer-0", status: "answered" });
    expect(card.call).toMatchObject({ ask: oversized.question, context: oversized.context, options: oversized.options, recommendedId: "o24", generation: 11 });
    expect(card.nextGeneration).toBe(12);
    expect(() => callPayloadSchema.shape.ask.parse(card.call!.ask)).toThrow();
    expect(() => callPayloadSchema.shape.options.parse(card.call!.options)).toThrow();
    expect(() => callPayloadSchema.shape.context.parse(card.call!.context)).toThrow();
  });

  it("validates all rows, duplicates and unknown legacy fields before accepting an aggregate", () => {
    expect(() => normalizeLegacyCards([oldCard, { ...oldCard, id: "bad", decision: { ...oldDecision, options: [{ id: "o", label: 3 }] } }])).toThrow();
    expect(() => normalizeLegacyCards([oldCard, oldCard])).toThrow(/Duplicate/);
    expect(() => normalizeLegacyCards([{ ...oldCard, hiddenOldField: "must not silently drop" }])).toThrow();
    expect(normalizeLegacyCards(undefined)).toEqual([]);
    expect(normalizeLegacyCards([{ ...oldCard, title: "" }])[0]!.title).toBe("");
  });
});

describe("shared human action policy", () => {
  it("DO answers are clarification, preserve exact whitespace, and Complete closes only the call", () => {
    const clarified = applyCallAction(call("DO"), action("answer", { response: "  Clarification\n" }), now, null);
    expect(clarified.call).toMatchObject({ status: "open", answeredAt: null, answerNote: "  Clarification\n" });
    expect(clarified.terminal).toBe(false);
    expect(applyCallAction(clarified.call, action("complete"), now, null).call.status).toBe("completed");
    expect(() => applyCallAction(call(), action("complete"), now, null)).toThrow(/only.*DO/);
  });

  it("options must belong to the call and local answers must be nonblank", () => {
    expect(applyCallAction(call(), action("answer", { optionId: "o1", response: "  keep  " }), now, null).call).toMatchObject({ status: "answered", answerId: "o1", answerLabel: "Old option", answerNote: "  keep  " });
    expect(() => applyCallAction(call(), action("answer", { optionId: "unknown" }), now, null)).toThrow(/Unknown/);
    expect(() => applyCallAction(call(), action("answer", { response: " \n " }), now, null)).toThrow(/blank/);
    expect(() => applyCallAction(call(), action("answer"), now, null)).toThrow(/Answer/);
    expect(() => applyCallAction(call(), action("answer", { response: " \n " }), now, now - 1)).toThrow(/blank/);
  });

  it("approval requires explicit approve/decline and checks exact option consistency and source-time expiry", () => {
    const approval = { ...call("APPROVE"), options: [{ id: "approve", label: "Approve", detail: null }, { id: "decline", label: "Decline", detail: null }] };
    expect(() => applyCallAction(approval, action("answer", { response: "yes" }), now, null)).toThrow(/requires/);
    expect(() => applyCallAction(approval, action("answer", { decision: "approve", optionId: "decline" }), now, null)).toThrow(/disagree/);
    expect(() => applyCallAction(approval, action("answer", { decision: "approve" }), now + 1000, null)).toThrow(/expired/);
    expect(applyCallAction(approval, action("answer", { decision: "approve", response: "Approve." }), now + 2000, now + 999).call.answerId).toBe("approve");
    expect(() => applyCallAction(approval, action("answer", { decision: "approve", response: "approve" }), now, now + 1000)).toThrow(/expired/);
    // Conditional or negated text is not an approval of the exact scope.
    for (const text of ["maybe later", "approve only after the rollback drill", "I approve nothing until legal signs off", "approve but not the prod step"]) {
      expect(() => applyCallAction(approval, action("answer", { decision: "approve", response: text }), now, now)).toThrow(/unqualified/);
    }
    expect(applyCallAction(approval, action("answer", { decision: "decline" }), now + 2000, null).call.status).toBe("answered");
    expect(() => applyCallAction(call(), action("answer", { decision: "approve" }), now, null)).toThrow(/Only APPROVE/);
  });

  it("defer needs explicit future/null, dismissal is closed and reopen preserves oversized legacy contents", () => {
    expect(() => applyCallAction(call(), action("defer"), now, null)).toThrow(/explicit/);
    expect(() => applyCallAction(call(), action("defer", { deferUntil: now }), now, null)).toThrow(/future/);
    const deferred = applyCallAction(call(), action("defer", { deferUntil: null }), now, null).call;
    expect(deferred).toMatchObject({ status: "deferred", deferUntil: null });
    expect(() => applyCallAction(deferred, action("reopen"), now, null)).toThrow(/closed/);
    const dismissed = applyCallAction({ ...deferred, ask: "x".repeat(9000) }, action("dismiss"), now, null).call;
    const reopened = applyCallAction(dismissed, action("reopen"), now, null);
    expect(reopened.reopen).toBe(true);
    expect(reopened.call.ask).toBe(dismissed.ask);
    expect(reopened.call).toMatchObject({ status: "open", answerId: null, answeredAt: null, deferUntil: null });
    expect(() => applyCallAction(dismissed, action("dismiss"), now, null)).toThrow(/closed/);
    expect(() => applyCallAction(call(), action("dismiss", { response: "hidden" }), now, null)).toThrow(/Answer fields/);
    expect(() => applyCallAction(call(), action("answer", { response: "ok", deferUntil: null }), now, null)).toThrow(/Only defer/);
  });
});

describe("native evidence and visible call blocks", () => {
  it("requires exact original committed user source after the bound thread boundary", () => {
    const original = row();
    const input = action("answer", { source: sourceRef(original), response: original.text });
    for (const patch of [{ role: "assistant" }, { completed: false }, { initiator: "agent" }, { senderThreadId: "sender" }, { visibility: "agent-only" }, { visibility: "system" },
      { sourceSeqStart: 10 }, { sourceSeqEnd: 9 }, { text: "changed" }, { contentSha256: "0".repeat(64) }, { createdAt: -1 }]) {
      expect(() => validateResponseSource(input, { ...original, ...patch } as NativeRow, "producer", 10)).toThrow();
    }
    expect(() => validateResponseSource(input, original, null, 10)).toThrow(/wrong thread/);
    expect(() => validateResponseSource(input, original, "other", 10)).toThrow(/wrong thread/);
    expect(() => validateResponseSource({ ...input, response: original.text.trim() }, original, "producer", 10)).toThrow(/changed/);
    expect(() => validateResponseSource({ ...input, action: "dismiss" }, original, "producer", 10)).toThrow(/identity/);
  });

  it("renders all fields deterministically and hashes exact text with canonical semantic JSON", () => {
    const payload = callPayloadSchema.parse({ kind: "APPROVE", ask: "Deploy?", recommendation: "Approve staging", options: [{ id: "approve", label: "Approve", detail: "exact build" }],
      recommendedId: "approve", context: "Context", evidence: [{ label: "Build", url: "https://example.test/build" }],
      approvalScope: { action: "Deploy build", target: "staging", constraints: "No prod", expiresAt: now } });
    const block = renderCallBlock("task", 2, payload);
    expect(block).toContain("Call generation: 2");
    expect(block.split("\n")[0]).toBe("[Captain's Deck task generation 2]");
    for (const text of ["Deploy?", "Approve staging", "exact build", "Context", "https://example.test/build", "Deploy build", "staging", "No prod", "does not execute"]) expect(block).toContain(text);
    expect(renderCallBlock("task", 2, payload)).toBe(block);
    expect(hash("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(hash("hello ")).not.toBe(hash("hello"));
    expect(canonical({ b: 2, a: { y: 1, x: 2 } })).toBe(canonical({ a: { x: 2, y: 1 }, b: 2 }));
  });
});
