import { z } from "zod";
export const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
export const versionSchema = z.number().int().positive();
// BB composes row ids from thread, turn, parent and item segments.
export const rowIdSchema = z.string().min(1).max(400).regex(/^[^\u0000-\u001f\u007f]+$/);
export const sourceRefSchema = z.object({ threadId: idSchema, turnId: idSchema, rowId: rowIdSchema, sourceSeqStart: z.number().int().nonnegative(), sourceSeqEnd: z.number().int().nonnegative(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;
export interface NativeRow extends SourceRef { text: string; role: "user" | "assistant"; createdAt: number; initiator: string | null; senderThreadId: string | null; completed: boolean; visibility: string | null }
export interface SourceDetail { status: "verified" | "missing" | "changed" | "too-large"; ref: SourceRef; text: string; nextOffset: number | null; totalLength: number; sourceCreatedAt: number | null }
export const evidenceSchema = z.object({ label: z.string().min(1).max(120), url: z.string().max(2048).refine((value) => { try { const u = new URL(value); return !/[\u0000-\u001f\u007f]/.test(value) && ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }).optional(), threadId: idSchema.optional(), rowId: rowIdSchema.optional() }).strict().refine((value) => !!value.url || !!value.threadId);
export const optionSchema = z.object({ id: idSchema, label: z.string().min(1).max(2000), detail: z.string().max(4000).nullable() }).strict();
export const approvalScopeSchema = z.object({ action: z.string().min(1).max(2000), target: z.string().min(1).max(2000), constraints: z.string().min(1).max(2000), expiresAt: z.number().int().nonnegative().optional() }).strict();
export const callPayloadSchema = z.object({ kind: z.enum(["DO", "DECIDE", "APPROVE"]), ask: z.string().min(1).max(2000), recommendation: z.string().max(2000).nullable(), options: z.array(optionSchema).max(20), recommendedId: idSchema.nullable(), context: z.string().max(16000).nullable(), evidence: z.array(evidenceSchema).max(10), approvalScope: approvalScopeSchema.nullable() }).strict().superRefine((p, ctx) => {
  if (p.kind === "APPROVE" && !p.approvalScope) ctx.addIssue({ code: "custom", message: "APPROVE needs its exact scope" });
  if (p.kind !== "APPROVE" && p.approvalScope) ctx.addIssue({ code: "custom", message: "Only APPROVE accepts approval scope" });
  if (new Set(p.options.map((o) => o.id)).size !== p.options.length || (p.recommendedId && !p.options.some((o) => o.id === p.recommendedId))) ctx.addIssue({ code: "custom", message: "Invalid option identity/recommendation" });
});
// Stored legacy calls are not subject to new-creation size/option limits.
export const callSchema = z.object({
  ...callPayloadSchema.shape,
  ask: z.string(),
  recommendation: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().nullable() }).strict()),
  recommendedId: z.string().nullable(),
  context: z.string().nullable(),
  id: idSchema, generation: versionSchema,
  status: z.enum(["open", "answered", "deferred", "dismissed", "completed"]),
  source: sourceRefSchema.nullable(), replyThreadId: idSchema.nullable(), replyAfterSeq: z.number().int().nonnegative(),
  provenance: z.enum(["native-origin", "legacy", "local-cli"]),
  askedAt: z.string(), answeredAt: z.string().nullable(),
  answerId: z.string().nullable(), answerLabel: z.string().nullable(), answerNote: z.string().nullable(),
  deferUntil: z.number().int().nonnegative().nullable(),
}).strict();
export const pendingCallSchema = z.object({ generation: versionSchema, payload: callPayloadSchema, threadId: idSchema, turnId: idSchema, afterSeq: z.number().int().nonnegative(), block: z.string().max(250000), state: z.enum(["pending", "failed"]), error: z.string().max(2000).nullable() }).strict();
export const workStateSchema = z.enum(["charted", "underway", "decision", "merge", "landed", "failed"]);
export const cardSchema = z.object({ id: idSchema, title: z.string(), brief: z.string().nullable(), kind: z.enum(["ship", "scout"]), state: workStateSchema, threadId: z.string().nullable(), projectId: z.string().nullable(), bot: z.string().nullable(), prUrl: z.string().nullable(), note: z.string().nullable(), call: callSchema.nullable(), history: z.array(callSchema), createdAt: z.string(), updatedAt: z.string(), landedAt: z.string().nullable(), revision: versionSchema, nextGeneration: versionSchema, seenGeneration: z.number().int().nonnegative(), pendingCall: pendingCallSchema.nullable() }).strict();
export const actionInputSchema = z.object({ taskId: idSchema, threadId: idSchema.optional(), expectedRevision: versionSchema, generation: versionSchema, operationId: idSchema, action: z.enum(["answer", "complete", "defer", "dismiss", "reopen"]), optionId: idSchema.nullish(), response: z.string().max(16000).optional(), decision: z.enum(["approve", "decline"]).optional(), deferUntil: z.number().int().nonnegative().nullable().optional(), source: sourceRefSchema.optional() }).strict();
export const deliverySchema = z.object({ state: z.enum(["pending", "sent", "queued", "failed", "uncertain", "disabled"]), threadId: z.string().nullable(), queueId: z.string().nullable(), error: z.string().nullable(), attempts: z.number().int().nonnegative() }).strict();
export const receiptSchema = z.object({ id: idSchema, taskId: idSchema, generation: versionSchema, fromRevision: versionSchema, toRevision: versionSchema, input: actionInputSchema, source: sourceRefSchema.nullable(), sourceCreatedAt: z.number().nullable(), provenance: z.enum(["panel-local", "chat-selected", "producer-selected", "local-cli"]), createdAt: z.string(), delivery: deliverySchema }).strict();
export const cancelCommandSchema = z.object({ operationId: idSchema, taskId: idSchema, generation: versionSchema, expectedRevision: versionSchema, result: cardSchema }).strict();
export const snapshotSchema = z.object({
  format: z.literal("captains-deck"), version: z.literal(1),
  tasks: z.array(cardSchema), receipts: z.array(receiptSchema),
  generations: z.array(z.object({ taskId: idSchema, nextGeneration: versionSchema }).strict()),
  commands: z.array(cancelCommandSchema),
}).strict();
export type DeckSnapshot = z.infer<typeof snapshotSchema>;
export const pageInputSchema = z.object({ cursor: z.string().max(4000).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
export const callsInputSchema = pageInputSchema.extend({ threadId: idSchema, view: z.enum(["attention", "deferred", "closed"]).default("attention") }).strict();
export const cardsPageSchema = z.object({ tasks: z.array(cardSchema).max(100), nextCursor: z.string().nullable(), serverNow: z.number(), counts: z.object({ total: z.number().int().nonnegative(), attention: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative(), unseen: z.number().int().nonnegative(), deferred: z.number().int().nonnegative(), closed: z.number().int().nonnegative() }).strict(), nextDueAt: z.number().nullable() }).strict();
export const sourceDetailSchema = z.object({ status: z.enum(["verified", "missing", "changed", "too-large"]), ref: sourceRefSchema, text: z.string().max(16000), nextOffset: z.number().nullable(), totalLength: z.number(), sourceCreatedAt: z.number().nullable() }).strict();
export type CallPayload = z.infer<typeof callPayloadSchema>;
export type CaptainCall = z.infer<typeof callSchema>;
export type DeckCard = z.infer<typeof cardSchema>;
export type ActionInput = z.infer<typeof actionInputSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type PendingCall = z.infer<typeof pendingCallSchema>;
export type CallsInput = z.infer<typeof callsInputSchema>;
export type CardsPage = z.infer<typeof cardsPageSchema>;
