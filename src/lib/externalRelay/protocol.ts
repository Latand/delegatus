import { hasHistoryMedia, hasInboundMedia, MAX_INPUT_MEDIA_REFS, normalizeInputMediaDescriptor, validateInputMediaDescriptor, validateMediaInput, type InputMedia } from "./mediaInputValidation";
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
  // Relative to this pairing: service routing may belong to another install (§B.2 rule 10).
  answered_elsewhere: z.boolean().optional(),
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
  poll_freshness_s: z.number().int().positive(),
  claim_window_s: z.number().int().positive(),
  ack_window_s: z.number().int().positive(),
  heartbeat_interval_s: z.number().int().min(2).max(60),
  stall_window_s: z.number().int().min(1).max(600),
});
export const descriptorSchema = z.object({
  protocol: z.literal("delegatus-relay"),
  versions: z.array(z.number().int().min(1)).min(1),
  name: boundedString(64).refine((value) => value.length > 0),
  description: boundedString(1000),
  api_base: z.url().refine((value) => [...value].length <= 2048),
  icon_url: boundedString(2048).nullish(),
  kinds: z.array(z.string()).min(1),
  features: z.array(z.string()).optional(),
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
const inputMediaSchema = z.object({
  ref: id, kind: z.enum(["photo", "document"]), availability: z.enum(["ready", "too_large", "unsupported_type", "missing", "protected"]),
  mime_type: boundedString(100).optional(), filename: boundedString(128).optional(),
  byte_size: z.number().int().positive().max(20971520).optional(), expires_at: time.optional(),
}).strict();
const claimMediaSchema = inputMediaSchema.extend({ byte_size: z.number().int().positive().safe().optional() });
const mentionSchema = z.object({ author_key: id, offset: z.number().int().min(0).max(31999), length: z.number().int().min(1).max(128) }).strict();
const messageSchema = z.object({
  id,
  media: z.array(inputMediaSchema).max(MAX_INPUT_MEDIA_REFS).optional(),
  author: z.object({
    key: id,
    name: boundedString(128),
    self: z.boolean(),
    tags: z.array(boundedString(32)).max(4).optional(),
  }),
  sent_at: time,
  text: boundedString(20000),
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
type RequesterAnchor = {
  requester?: z.infer<typeof requesterSchema> | null;
  respond_to: string | null;
  conversation: readonly z.infer<typeof messageSchema>[];
};

/** A requester identifies the unique, human-authored trigger in this claim. */
export function requesterTrigger(input: RequesterAnchor) {
  if (!input.requester || input.respond_to === null) return null;
  const matches = input.conversation.filter(message => message.id === input.respond_to);
  const trigger = matches[0];
  return matches.length === 1 && trigger && !trigger.author.self && trigger.author.key === input.requester.key
    ? trigger : null;
}

export function ownerRequesterTrigger(input: RequesterAnchor) {
  return input.requester?.is_owner === true && !input.requester.is_anonymous_admin ? requesterTrigger(input) : null;
}

export const INVALID_REQUESTER_DETAIL = "Requester does not match the triggering author or the owner delivery context.";
const toolSchema = z.object({
  name: boundedString(64).refine((value) => value.length > 0),
  summary: boundedString(240),
  mode: z.enum(["direct", "handoff"]),
  effect: z.enum(["read", "action"]).optional(),
  spec: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  parameters: z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 8192).optional(),
  audience: z.enum(["admin", "owner"]).optional(),
});
export const relayAnswerDescription = "Only while you answer a relay message as its owner: text is your reply posted in the chat (without it, your last message is posted); format, buttons, mentions and attachments choose how it is delivered. format rich_markdown renders the Markdown subset and length in your prompt; buttons are https links; mentions annotates person labels at original Unicode-scalar offsets; attachments select exactly one path under your document roots or an unexpired media_ref downloaded in this request. Photo references use stable attachment_id values from the receipt; several photos form one carousel with your message. Each call replaces the previous one. Refused in every other conversation and after the answer.";
export const relayAnswerSchema = z.object({
  text: z.string().min(1).max(32000).optional().describe("Your reply as posted in the chat."),
  mentions: z.array(mentionSchema).max(16).optional(),
  format: z.enum(["plain","rich_markdown"]).optional(),
  buttons: z.array(z.array(z.object({text:boundedString(64).refine(v => v.length > 0),url:boundedString(2048).refine(v => v.length > 0)})).min(1).max(3)).max(2).optional(),
  attachments: z.array(z.object({path:z.string().min(1).max(4096).optional(),media_ref:z.string().regex(/^media_[0-9a-f]{32}$/).optional(),kind:z.enum(["photo","document","audio","video"]),caption:z.string().max(1024).optional(),filename:boundedString(128).refine(v => v.length > 0).optional()}).refine(v => (v.path !== undefined) !== (v.media_ref !== undefined), { message: "Choose exactly one path or media_ref" })).max(4).optional(),
});

export const mediaKindSchema = z.enum(["photo", "document", "audio", "video"]);
export type RelayMediaKind = z.infer<typeof mediaKindSchema>;
export const relayFormatSchema = z.object({
  version: z.string().min(1).max(64),
  formats: z.object({ plain: z.number().int().positive(), rich_markdown: z.number().int().positive() }).passthrough(),
  guide: boundedString(4000), markdown_subset: z.array(boundedString(64)).max(64),
  max_blocks: z.number().int().positive(), max_depth: z.number().int().positive(), max_table_columns: z.number().int().positive(),
  mentions: z.object({ placement: z.literal("answer.mentions"), max_items: z.number().int().min(1).max(16), offset_units: z.literal("unicode_scalars"), max_label_chars: z.number().int().min(1).max(128) }).optional(),
  image_refs: z.object({ requires: z.literal("relay_media_out").optional(), syntax: z.literal("![](attachment:attachment_id)"), max_items: z.number().int().min(1).max(4), layout: z.literal("photo_carousel") }).optional(),
  buttons: z.object({ allowed: z.boolean(), max_rows: z.number().int().min(0), max_per_row: z.number().int().min(0), max_total: z.number().int().min(0) }).passthrough(),
  forbidden: z.array(boundedString(64)).max(64),
}).passthrough();
export const uploadedAttachmentSchema = z.object({ attachment_id: id, mime_type: boundedString(100), filename: boundedString(128).refine(v => v.length > 0),
  byte_size: z.number().int().min(1).max(20971520), sha256: z.string().regex(/^[a-f0-9]{64}$/), expires_at: time });
export const relayAttachmentLimitsSchema = z.object({ max_items: z.number().int().min(1).max(4),
  max_total_bytes: z.number().int().positive().max(67108864), kinds: z.array(mediaKindSchema).min(1).max(4) });
export const inputSchema = z.object({
  format: relayFormatSchema.optional().catch(undefined),
  instructions: boundedString(32000),
  owner_instructions: boundedString(16000).nullable(),
  documents: z
    .array(
      z.object({ title: boundedString(200), text: boundedString(16000), message_id: id.optional(), media_ref: id.optional(), extraction: z.enum(["complete", "truncated", "unavailable"]).optional() }),
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
}).superRefine((input, context) => {
  const ownerTrigger = ownerRequesterTrigger(input);
  for (const [index, message] of input.conversation.entries()) {
    const prototypeReply = message === ownerTrigger
      && /#proto-[a-f0-9]{8}\b/i.test(message.text.replace(/\\([#-])/g, "$1"));
    if ([...message.text].length > 16000 && !prototypeReply) context.addIssue({ code: "custom",
      path: ["conversation", index, "text"], message: "expected at most 16000 Unicode code points" });
  }
});
const chatKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** Supplied only by the service for its verified pairing owner. Opaque message
 * references elsewhere in a claim cannot be converted into this destination. */
export const ownerDeliverySchema = z.object({
  chat_id: z.number().int().safe().refine(value => value !== 0),
  reply_to_message_id: z.number().int().min(1).max(2147483647),
  message_thread_id: z.number().int().positive().nullable(),
});
export type OwnerDelivery = z.infer<typeof ownerDeliverySchema>;
const answerRequestSchema = z.object({
  delivery: z.literal("guest").optional(),
  owner_delivery: ownerDeliverySchema.optional().catch(undefined),
  features: z.array(boundedString(64)).max(32).refine(v => new Set(v).size === v.length).optional().catch(undefined),
  request_id: id,
  lease_id: leaseId,
  kind: z.literal("answer"),
  target_id: id,
  claimed_at: time,
  liveness: livenessSchema,
  // The chat key of §A.8, kept for the member limit and the records. A
  // malformed one is dropped, as an unknown field would be.
  chat: z.object({ key: chatKey, title: boundedString(200).optional().catch(undefined) }).optional().catch(undefined),
  input: inputSchema,
  answer: z.object({
    attachments: relayAttachmentLimitsSchema.optional().catch(undefined),
    max_chars: z.number().int().min(1).max(32000),
    progress: z.enum(["notes", "none"]),
  }),
});
/** Normalize item policy refusals on anchors; malformed anchors stay fail-closed. */
export const requestSchema = z.preprocess((raw, context) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let value = raw as Record<string, unknown>;
  const mediaPolicy = {
    delivery: value.delivery === "guest" ? "guest" as const : undefined,
    features: Array.isArray(value.features) ? value.features : undefined,
  };
  // The ordinary schema tolerates a malformed destination extension. Guest
  // delivery cannot carry an owner destination, including a malformed one.
  if (mediaPolicy.delivery === "guest" && value.owner_delivery !== undefined)
    context.addIssue({ code: "custom", path: ["owner_delivery"], message: INVALID_REQUESTER_DETAIL });
  const inbound = hasInboundMedia(mediaPolicy);
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) return raw;
  let input = value.input as Record<string, unknown>;
  const trigger = Array.isArray(input.conversation) ? input.conversation.find(message =>
    message && typeof message === "object" && message.id === input.respond_to) : undefined;
  const allowed = new Set([trigger?.id, trigger?.reply_to].filter(candidate => typeof candidate === "string"));
  if (inbound && Array.isArray(input.conversation)) {
    input = { ...input, conversation: input.conversation.map(message => {
      if (!message || !allowed.has(message.id) || !Array.isArray(message.media)) return message;
      return { ...message, media: message.media.map((rawMedia: unknown) => {
        const parsed = claimMediaSchema.safeParse(rawMedia);
        if (!parsed.success) return rawMedia;
        try { return normalizeInputMediaDescriptor(parsed.data, mediaPolicy.features); }
        catch { return rawMedia; }
      }) };
    }) };
    value = { ...value, input };
  }
  const history = hasHistoryMedia(mediaPolicy);
  // Anchor descriptors take precedence over conflicting historical copies.
  const refs = new Map<string, InputMedia>();
  if (Array.isArray(input.conversation)) for (const message of input.conversation) {
    if (!message || !allowed.has(message.id) || !Array.isArray(message.media)) continue;
    for (const rawMedia of message.media) {
      const parsed = inputMediaSchema.safeParse(rawMedia);
      if (parsed.success) refs.set(parsed.data.ref, parsed.data);
    }
  }
  const requestId = id.safeParse(value.request_id).success ? value.request_id : "invalid";
  return { ...value, input: { ...input,
    ...(Array.isArray(input.conversation) ? { conversation: input.conversation.map((message, entryIndex) => {
      if (!message || typeof message !== "object") return message;
      if (inbound && allowed.has(message.id) || !inbound && value.delivery === "guest") return message;
      const kept: InputMedia[] = [];
      if (Object.hasOwn(message, "media")) {
        for (const rawMedia of Array.isArray(message.media) ? message.media : [message.media]) {
          const parsed = history ? inputMediaSchema.safeParse(rawMedia) : null;
          let media = parsed?.success && parsed.data.kind === "photo" ? parsed.data : null;
          if (media) {
            try { validateInputMediaDescriptor(media, mediaPolicy.features); }
            catch { media = null; }
          }
          const previous = media && refs.get(media.ref);
          if (media && (!previous || JSON.stringify(previous) === JSON.stringify(media))) {
            refs.set(media.ref, media); kept.push(media);
          } else if (inbound) {
            // Never log descriptor contents or conversation data.
            console.info("External relay history media dropped", JSON.stringify({ request: requestId, entryIndex, count: 1 }));
          }
        }
      }
      if (kept.length) return { ...message, media: kept };
      const copy = { ...message }; delete copy.media; return copy;
    }) } : {}),
    ...(!inbound && value.delivery !== "guest" && Array.isArray(input.documents) ? { documents: input.documents.map(document => {
      if (!document || typeof document !== "object") return document;
      const copy = { ...document }; delete copy.message_id; delete copy.media_ref; delete copy.extraction; return copy;
    }) } : {}),
  } };
}, answerRequestSchema.superRefine((request, context) => {
  const { input } = request;
  const { requester } = input;
  const invalidRequester = request.delivery === "guest"
    ? !requester || !requesterTrigger(input) || requester.is_anonymous_admin
      || !requester.is_owner && (requester.is_admin || requester.can_restrict_members || requester.can_delete_messages)
    : requester && (!requesterTrigger(input) || requester.is_owner && requester.is_anonymous_admin
        || request.owner_delivery && !requester.is_owner);
  if (invalidRequester)
    context.addIssue({ code: "custom", path: ["input", "requester"], message: INVALID_REQUESTER_DETAIL });
  if (request.delivery === "guest") {
    if (request.answer.progress !== "none" || request.owner_delivery || request.input.format || request.answer.attachments
      || request.input.tools?.some(tool => tool.mode !== "handoff")
      || !hasInboundMedia(request) && (request.input.conversation.some(message => message.media?.length)
        || request.input.documents.some(document => document.media_ref !== undefined)))
      context.addIssue({ code: "custom", message: "invalid guest delivery contract" });
  }
  if (!hasInboundMedia(request)) return;
  try { validateMediaInput(request); }
  catch { context.addIssue({ code: "custom", message: "invalid negotiated media input" }); }
}));
export type ExternalRelayRequest = z.infer<typeof requestSchema>;
export type ExternalRelayTool = z.infer<typeof toolSchema>;
export function relayToolAudience(request: ExternalRelayRequest) {
  const requester = request.input.requester;
  const matched = requesterTrigger(request.input) !== null;
  const owner = matched && requester?.is_owner === true && !requester.is_anonymous_admin && request.delivery !== "guest";
  const admin = matched && requester?.is_admin === true;
  return (audience?: string) => audience === undefined || (audience === "admin" && admin) || (audience === "owner" && owner);
}
export function visibleRelayTools(request: ExternalRelayRequest) {
  const mayQuote = relayToolAudience(request);
  return (request.input.tools ?? []).filter(tool => mayQuote(tool.audience));
}
export const RELAY_TOOLS_ON_DEMAND = "relay_tools_on_demand";
export const RELAY_OWNER_TOOLS = "relay_owner_tools";
/** I9 uses the offered audience; operation names and schemas stay service-owned. */
export const isOwnerTool = (tool: ExternalRelayTool) => tool.audience === "owner";
/** E3 is the only owner 429 that proves no admission, debit or action stamp. */
export const ownerRateLimitSchema = z.object({ error: z.object({
  code: z.literal("rate_limited"), message: z.literal("rate limited"),
  retry_after_s: z.number().int().min(1).max(60),
}) });
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
export const lookupResultSchema = toolCallResultSchema.extend({
  tools: z.array(toolSchema).max(128).optional(),
  guidance: z.array(z.object({ tools: z.array(z.string().max(64)).max(128), text: boundedString(24000) })).max(128).optional(),
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
export const guestAnswerSchema = {
  ...answerSchema,
  properties: { ...answerSchema.properties, action: { type: "string", enum: ["reply", "handoff"] }, reply_to: { type: "null" } },
} as const;
export const replyAnswerSchema = {
  ...answerSchema,
  properties: { ...answerSchema.properties, action: { type: "string", enum: ["reply"] } },
} as const;
/** Guest delivery can return to the hosted assistant even without a tool index. */
export const offersHandoff = (request: ExternalRelayRequest) =>
  request.delivery === "guest" || visibleRelayTools(request).length > 0;
export type RelayMention = { author_key: string; offset: number; length: number };
export type RelayUrlButton = { text: string; url: string };
export type RelayAttachment = { attachment_id: string; kind: RelayMediaKind; caption?: string };
export type ExternalRelayAnswer = {
  format?: "plain" | "rich_markdown";
  buttons?: RelayUrlButton[][];
  mentions?: RelayMention[];
  attachments?: RelayAttachment[];
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
  if (answer.action === "ignore" && (!options.ignore || request.delivery === "guest")) return null;
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
      request.delivery !== "guest" && reply &&
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
} | ExternalRelayStepProgress;
export type ExternalRelayStepId = "accepted" | "queued" | "thinking" | "reading_board" | "working" | "writing_answer";
export type ExternalRelayStepProgress = {
  kind: "step";
  label: ExternalRelayStepId;
  tool: null;
  status: null;
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

// Celestia H1–H3: strict wire objects reject undocumented private fields.
export const ownerHistoryGroupsSchema = z.object({ groups: z.array(z.object({
  chat_id: z.number().int(), title: z.string(),
}).strict()) }).strict();
export const ownerHistoryPageSchema = z.object({
  chat_id: z.number().int(), title: z.string(), timezone: z.string(), start: time, end: time,
  oldest_stored_at: z.iso.datetime().nullable(),
  messages: z.array(z.object({
    message_id: z.number().int(), sent_at: z.iso.datetime(), edited_at: z.iso.datetime().nullable().optional(),
    author: z.object({ user_id: z.number().int(), name: z.string().nullable(), username: z.string().nullable() }).strict(),
    from_assistant: z.boolean(), thread_id: z.number().int().nullable(), reply_to_message_id: z.number().int().nullable(),
    text: boundedString(4096), media: z.object({ kind: z.string(), description: boundedString(1000).nullable(),
      file_name: boundedString(128).nullable().optional(), mime_type: boundedString(100).nullable().optional(),
      size: z.number().int().nonnegative().safe().nullable().optional(), duration: z.number().int().nonnegative().nullable().optional(),
      width: z.number().int().nonnegative().nullable().optional(), height: z.number().int().nonnegative().nullable().optional(),
      fetch: z.enum(["available", "too_large", "protected", "unsupported_kind", "unavailable"]).optional(),
    }).strict().nullable(),
    truncated: z.boolean(),
  }).strict()).max(100),
  next_cursor: z.string().regex(/^[1-9][0-9]{0,9}$/).nullable(),
}).strict();
export type OwnerHistoryGroups = z.infer<typeof ownerHistoryGroupsSchema>;
export type OwnerHistoryPage = z.infer<typeof ownerHistoryPageSchema>;

/** H4 never accepts arbitrary provider text as a refusal or filename path. */
export const ownerMediaPreparingSchema = z.object({ status: z.literal("preparing"), retry_after_s: z.number().int().min(1).max(30) }).strict();
export const ownerMediaRefusalSchema = z.object({ error: z.object({
  code: z.enum(["no_media", "unsupported_kind", "protected", "too_large", "media_unavailable", "rate_limited"]),
  message: z.string().optional(), retry_after_s: z.number().int().positive().optional(),
  limit_bytes: z.number().int().nonnegative().safe().optional(), size_bytes: z.number().int().nonnegative().safe().optional(),
}).strict() }).strict();
