import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const leaseId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const bearerSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pollSecretKey = "poll_secret" as const;
const label = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\x00-\x1f\x7f]*$/);
const time = z.iso.datetime({ offset: true });
export const ownerSchema = z.object({
  namespace: z.string().regex(/^[a-z0-9_.-]{1,32}$/),
  id,
  display_name: label,
  handle: z.string().max(64).nullable(),
});
export const targetSchema = z.object({
  target_id: id,
  name: label,
  answered_by: z.enum(["install", "service"]),
  fallback: z.enum(["service", "none"]),
});
export const livenessSchema = z.object({
  poll_freshness_s: z.number().int().min(30).max(300),
  claim_window_s: z.number().int().min(1).max(60),
  ack_window_s: z.number().int().min(2).max(120),
  heartbeat_interval_s: z.number().int().min(2).max(60),
  stall_window_s: z.number().int().min(10).max(600),
});
export const descriptorSchema = z.object({
  protocol: z.literal("delegatus-relay"),
  versions: z.array(z.number().int().min(1)).min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(1000),
  api_base: z.url().max(2048),
  kinds: z.array(z.string()).min(1),
  liveness: livenessSchema,
  limits: z.object({
    max_response_bytes: z.number().int().min(65536).max(1048576),
    max_wait_s: z.number().int().min(5).max(50),
    max_answer_chars: z.number().int().min(1).max(32000),
  }),
});
export const pairingStartedSchema = z.object({
  pairing_id: id,
  [pollSecretKey]: bearerSchema,
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  verify_url: z.url().nullable(),
  expires_at: time,
  poll_interval_s: z.number().int().min(1).max(30),
});
export const pairingStatusSchema = z
  .object({
    status: z.enum([
      "pending",
      "awaiting_install",
      "completed",
      "expired",
      "denied",
      "cancelled",
    ]),
    owner: ownerSchema.optional(),
    targets: z.array(targetSchema).max(100).optional(),
    reason: z.string().max(300).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "awaiting_install" && (!value.owner || !value.targets))
      context.addIssue({ code: "custom", message: "missing owner or targets" });
  });
export const pairingConfirmedSchema = z.object({
  credential: bearerSchema,
  version: z.number().int().min(1),
  owner: ownerSchema,
  targets: z.array(targetSchema).max(100),
});
const messageSchema = z.object({
  id,
  author: z.object({
    key: id,
    name: z.string().max(128),
    self: z.boolean(),
    tags: z.array(z.string().max(32)).max(4).optional(),
  }),
  sent_at: time,
  text: z.string().max(16000),
  reply_to: id.nullable(),
});
export const inputSchema = z.object({
  instructions: z.string().max(32000),
  owner_instructions: z.string().max(16000).nullable(),
  documents: z
    .array(
      z.object({ title: z.string().max(200), text: z.string().max(16000) }),
    )
    .max(20),
  conversation: z.array(messageSchema).max(200),
  respond_to: id.nullable(),
  request_text: z.string().max(4000).nullable(),
});
export const requestSchema = z.object({
  request_id: id,
  lease_id: leaseId,
  kind: z.literal("answer"),
  target_id: id,
  claimed_at: time,
  liveness: livenessSchema,
  input: inputSchema,
  answer: z.object({
    max_chars: z.number().int().min(1).max(32000),
    progress: z.enum(["notes", "none"]),
  }),
});
export type ExternalRelayRequest = z.infer<typeof requestSchema>;
export type ExternalRelayDescriptor = z.infer<typeof descriptorSchema>;
export type ExternalRelayTarget = z.infer<typeof targetSchema>;
export type ExternalRelayOwner = z.infer<typeof ownerSchema>;
export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "text", "reply_to"],
  properties: {
    action: { type: "string", enum: ["reply", "ignore"] },
    text: { type: "string" },
    reply_to: { type: ["string", "null"] },
  },
} as const;
export type ExternalRelayAnswer = {
  action: "reply" | "ignore";
  text: string;
  reply_to: string | null;
};
export function checkedAnswer(
  value: unknown,
  request: ExternalRelayRequest,
): ExternalRelayAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (
    (answer.action !== "reply" && answer.action !== "ignore") ||
    typeof answer.text !== "string" ||
    (answer.reply_to !== null && typeof answer.reply_to !== "string")
  )
    return null;
  if (
    answer.action === "reply" &&
    (!answer.text.trim() || [...answer.text].length > request.answer.max_chars)
  )
    return null;
  const reply = answer.reply_to as string | null;
  return {
    action: answer.action,
    text: answer.action === "ignore" ? "" : answer.text,
    reply_to:
      reply &&
      request.input.conversation.some((message) => message.id === reply)
        ? reply
        : null,
  };
}
export type ExternalRelayProgress = {
  kind: "note" | "tool_start" | "tool_done";
  label: string;
  tool: string | null;
  status: "running" | "completed" | "failed" | null;
  at: string;
};
export type ExternalRelayCompletion =
  | {
      lease_id: string;
      outcome: "answered";
      answer: ExternalRelayAnswer;
      duration_ms: number;
    }
  | {
      lease_id: string;
      outcome: "declined";
      reason: string;
      detail: string | null;
      retry_after_s: number | null;
    }
  | {
      lease_id: string;
      outcome: "failed";
      reason: string;
      detail: string | null;
    };
