import { z } from "zod";

// JSON Schema maxLength counts Unicode code points, including astral characters.
const boundedString = (max: number) =>
  z.string().refine((value) => [...value].length <= max, { message: `expected at most ${max} Unicode code points` });

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const leaseId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const bearerSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pollSecretKey = "poll_secret" as const;
const label = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= 128)
  .regex(/^[^\x00-\x1f\x7f]*$/);
const time = z.iso.datetime({ offset: true });
export const ownerSchema = z.object({
  namespace: z.string().regex(/^[a-z0-9_.-]{1,32}$/),
  id,
  display_name: label,
  handle: boundedString(64).nullable(),
});
export const targetSchema = z.object({
  target_id: id,
  name: label,
  answered_by: z.enum(["install", "service"]),
  fallback: z.enum(["service", "none"]),
});
// Endpoint 6. One entry per target id: a list naming a target twice cannot
// be merged into the stored settings, so it is refused as a whole.
export const targetsSchema = z
  .object({ targets: z.array(targetSchema).max(100) })
  .refine(
    (value) =>
      new Set(value.targets.map((target) => target.target_id)).size ===
      value.targets.length,
    { message: "duplicate target_id" },
  );
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
  name: boundedString(64).refine((value) => value.length > 0),
  description: boundedString(1000),
  api_base: z.url().refine((value) => [...value].length <= 2048),
  icon_url: boundedString(2048).nullish(),
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
    reason: boundedString(300).optional(),
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
    name: boundedString(128),
    self: z.boolean(),
    tags: z.array(boundedString(32)).max(4).optional(),
  }),
  sent_at: time,
  text: boundedString(16000),
  reply_to: id.nullable(),
});
// requester_context (relay.md §A.8): who asked, the chat's short-term memory
// and the service's tools for the requester's role. All optional, so a request
// without them reads, and is answered, exactly as before.
const requesterSchema = z.object({
  key: id,
  is_admin: z.boolean(),
  can_restrict_members: z.boolean(),
  can_delete_messages: z.boolean(),
  is_anonymous_admin: z.boolean(),
  is_owner: z.boolean(),
});
const toolSchema = z.object({
  name: boundedString(64).refine((value) => value.length > 0),
  summary: boundedString(240),
  mode: z.enum(["direct", "handoff"]),
  effect: z.enum(["read", "action"]).optional(),
  parameters: z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192).optional(),
  audience: z.enum(["admin", "owner"]).optional(),
});
export const inputSchema = z.object({
  instructions: boundedString(32000),
  owner_instructions: boundedString(16000).nullable(),
  documents: z
    .array(
      z.object({ title: boundedString(200), text: boundedString(16000) }),
    )
    .max(20),
  conversation: z.array(messageSchema).max(200),
  respond_to: id.nullable(),
  request_text: boundedString(4000).nullable(),
  requester: requesterSchema.nullish(),
  short_term_memory: boundedString(16000).nullish(),
  tool_guidance: boundedString(24000).nullish(),
  tools: z
    .array(toolSchema)
    .max(128)
    .refine(
      (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
      { message: "duplicate tool name" },
    )
    .optional(),
});
const chatKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const requestSchema = z.object({
  request_id: id,
  lease_id: leaseId,
  kind: z.literal("answer"),
  target_id: id,
  claimed_at: time,
  liveness: livenessSchema,
  // The chat key of §A.8, kept for the member limit and the records. A
  // malformed one is dropped, as an unknown field would be.
  chat: z.object({ key: chatKey }).optional().catch(undefined),
  input: inputSchema,
  answer: z.object({
    max_chars: z.number().int().min(1).max(32000),
    progress: z.enum(["notes", "none"]),
  }),
});
export type ExternalRelayRequest = z.infer<typeof requestSchema>;
export type ExternalRelayTool = z.infer<typeof toolSchema>;
const callId = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
export const toolCallResultSchema = z.object({
  call_id: callId,
  tool: z.string().max(64),
  status: z.enum(["ok", "error", "denied", "pending", "confirmation_pending", "outcome_unknown"]),
  output: boundedString(16000),
  truncated: z.boolean(),
  effect: z.enum(["read", "action"]),
  delivered: z.boolean(),
  replayed: z.boolean(),
  calls_remaining: z.number().int().min(0).max(16),
  code: z.enum(["not_permitted", "unknown_tool", "quota_exhausted", "too_many_calls", "invalid_arguments", "unavailable"]).optional(),
  cursor: callId.optional(),
  audience: z.enum(["admin", "owner"]).optional(),
  retry_after_s: z.number().int().min(1).max(60).optional(),
  confirmation_id: id.optional(),
  summary: boundedString(240).optional(),
  expires_at: time.optional(),
});
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;
export type RoundCall = { tool: string; arguments: string; cursor: string | null };
export function roundSchema(tools: ExternalRelayTool[], options: { handoff: boolean } = { handoff: true }) {
  return {
    ...handoffAnswerSchema,
    required: ["action", "text", "reply_to", "calls"],
    properties: {
      ...handoffAnswerSchema.properties,
      action: { type: "string", enum: options.handoff ? ["reply", "ignore", "handoff", "call"] : ["reply", "ignore", "call"] },
      calls: { type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["tool", "arguments", "cursor"],
        properties: {
          tool: { type: "string", enum: tools.map((tool) => tool.name).sort() },
          arguments: { type: "string" },
          cursor: { type: ["string", "null"] },
        },
      } },
    },
  };
}
export function checkedRound(value: unknown, request: ExternalRelayRequest, options: { handoff: boolean; ignore: boolean } = { handoff: true, ignore: true }):
  ExternalRelayDecision | { kind: "calls"; calls: RoundCall[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (answer.action !== "call") return checkedAnswer(value, request, options);
  if (typeof answer.text !== "string" || (answer.reply_to !== null && typeof answer.reply_to !== "string")) return null;
  if (!Array.isArray(answer.calls) || !answer.calls.every((call) =>
    call && typeof call === "object" && typeof call.tool === "string" &&
    typeof call.arguments === "string" && (call.cursor === null || typeof call.cursor === "string"))) return null;
  return { kind: "calls", calls: answer.calls };
}
export type ExternalRelayRequester = z.infer<typeof requesterSchema>;
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
/** The schema of a request that carries a tool index: a third action hands
 * the request back to the service (§A.8), with no text and no reply target. */
export const handoffAnswerSchema = {
  ...answerSchema,
  properties: {
    ...answerSchema.properties,
    action: { type: "string", enum: ["reply", "ignore", "handoff"] },
  },
} as const;
export const replyAnswerSchema = {
  ...answerSchema,
  properties: { ...answerSchema.properties, action: { type: "string", enum: ["reply"] } },
} as const;
/** Hand-off is offered only for a request whose service listed its tools. */
export const offersHandoff = (request: ExternalRelayRequest) =>
  (request.input.tools?.length ?? 0) > 0;
export type ExternalRelayAnswer = {
  action: "reply" | "ignore";
  text: string;
  reply_to: string | null;
};
export type ExternalRelayDecision =
  | ExternalRelayAnswer
  | { action: "handoff"; text: ""; reply_to: null };
export function checkedAnswer(
  value: unknown,
  request: ExternalRelayRequest,
  options: { handoff: boolean; ignore: boolean } = { handoff: true, ignore: true },
): ExternalRelayDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (answer.action === "handoff")
    return options.handoff && offersHandoff(request)
      ? { action: "handoff", text: "", reply_to: null }
      : null;
  if (answer.action === "ignore" && !options.ignore) return null;
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
  | { lease_id: string; outcome: "compacted"; reason: CompactReason; detail: string | null; duration_ms: number }
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

// Parsed separately: the public slice 2b descriptor keeps dropping these fields.
export const ownerApiSchema = z.object({
  features: z.array(z.string()).refine((value) => value.includes("owner_api")),
  owner_api: z.object({ api_base: z.url(), openapi_url: z.url(), key_url: z.url(),
    operations: z.array(z.string().min(1).max(128)).min(1).max(128).refine((value) => new Set(value).size === value.length) }),
});
export const ownerApiMeSchema = z.object({ user_id: z.number().int(), expires_at: time.nullish() });
export const compactRequestSchema = z.object({ request_id: id, lease_id: leaseId,
  kind: z.literal("compact"), target_id: id, claimed_at: time, liveness: livenessSchema,
  chat: z.object({ key: chatKey }), input: z.object({ requester: requesterSchema }) });
export type CompactRequest = z.infer<typeof compactRequestSchema>;
export type CompactReason = "compacted" | "started_fresh" | "nothing_to_compact";
export const compactCompletionSchema = z.union([
  z.object({ lease_id: leaseId, outcome: z.literal("compacted"),
    reason: z.enum(["compacted", "started_fresh", "nothing_to_compact"]), detail: boundedString(200).nullable(), duration_ms: z.number().int().nonnegative() }),
  z.object({ lease_id: leaseId, outcome: z.literal("declined"),
    reason: z.enum(["not_configured", "disabled", "busy", "no_capacity", "unsupported_kind", "invalid_request", "profile_error", "handoff", "member_limit"]),
    detail: boundedString(200).nullable(), retry_after_s: z.number().int().nonnegative().nullable() }),
  z.object({ lease_id: leaseId, outcome: z.literal("failed"), reason: z.enum(["agent_error", "invalid_answer", "profile_violation", "hard_cap", "install_restarted", "cancelled"]), detail: boundedString(200).nullable() }),
]);
