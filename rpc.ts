import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { actionInputSchema, cardSchema, cardsPageSchema, callsInputSchema, callPayloadSchema, idSchema, pageInputSchema, receiptSchema, snapshotSchema, sourceDetailSchema, sourceRefSchema, versionSchema } from "./contract";

const scopedTask = z.object({ taskId: idSchema, threadId: idSchema.optional() }).strict();
const scopedGeneration = scopedTask.extend({ generation: versionSchema });
const actionResult = z.object({ task: cardSchema.nullable(), receipt: receiptSchema }).strict();
const nativeRowSchema = sourceRefSchema.extend({ text: z.string().max(16000), role: z.enum(["user", "assistant"]), createdAt: z.number(), initiator: z.string().nullable(), senderThreadId: z.string().nullable(), completed: z.boolean(), visibility: z.string().nullable() }).strict();

export const rpcContract = defineRpcContract({
  getSetup: { input: z.null(), output: z.object({ firstMateThreadId: z.string(), producer: z.object({ threadId: z.string(), projectId: z.string(), title: z.string() }).nullable(), valid: z.boolean(), reason: z.string().nullable() }).strict() },
  deck_board: { input: pageInputSchema.nullable(), output: cardsPageSchema },
  deck_get: { input: scopedTask, output: z.object({ task: cardSchema, receipts: z.array(receiptSchema).max(100), nextCursor: z.string().nullable() }).strict() },
  deck_calls: { input: callsInputSchema, output: cardsPageSchema },
  deck_action: { input: actionInputSchema, output: actionResult },
  deck_answer: { input: actionInputSchema.refine((v) => v.action === "answer", "Requires answer action"), output: actionResult },
  deck_seen: { input: scopedGeneration, output: cardSchema },
  deck_source: { input: scopedGeneration.extend({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() }), output: sourceDetailSchema.nullable() },
  deck_candidates: { input: scopedGeneration.extend({ threadId: idSchema, afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).default(30) }), output: z.object({ rows: z.array(nativeRowSchema).max(100), omitted: z.array(sourceRefSchema).max(100), nextSeq: z.number(), hasMore: z.boolean() }).strict() },
  deck_associate: { input: actionInputSchema.omit({ response: true }).extend({ source: sourceRefSchema, threadId: idSchema }), output: actionResult },
  deck_call_post: { input: scopedTask.extend({ threadId: idSchema, expectedRevision: versionSchema, payload: callPayloadSchema }), output: z.object({ task: cardSchema, generation: versionSchema, block: z.string() }).strict() },
  deck_cancel_call: { input: scopedGeneration.extend({ expectedRevision: versionSchema, operationId: idSchema }), output: cardSchema },
  deck_receipts: { input: scopedTask.extend({ cursor: z.string().max(4000).optional(), limit: z.number().int().min(1).max(100).default(30) }), output: z.object({ receipts: z.array(receiptSchema).max(100), nextCursor: z.string().nullable() }).strict() },
  deck_delivery_check: { input: z.object({ receiptId: idSchema, threadId: idSchema.optional() }).strict(), output: receiptSchema },
  deck_delivery_retry: { input: z.object({ receiptId: idSchema, threadId: idSchema.optional(), acknowledgeDuplicateRisk: z.boolean().default(false) }).strict(), output: receiptSchema },
  deck_export: { input: z.null(), output: snapshotSchema },
  deck_import: { input: snapshotSchema, output: z.object({ imported: z.number().int().nonnegative() }).strict() },
});
