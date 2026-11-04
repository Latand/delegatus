import { z } from "zod";
import type { CloneMethodInput, CloneSendInput } from "./cloneSend";

export const cloneSendLimitsSchema = z.object({
  methods: z.array(z.string().max(64).regex(/^send[A-Za-z]+$/)).min(1).max(32),
  max_files: z.number().int().min(1).max(10),
  max_total_file_bytes: z.number().int().positive().max(67108864),
  max_body_bytes: z.number().int().positive().max(68157440),
  max_caption_utf16: z.number().int().positive().max(1024),
  file_pending_s: z.number().int().positive().max(120),
  files: z.record(z.string().max(32), z.object({ mime_types: z.array(z.string().max(100)).max(32),
    max_bytes: z.number().int().positive().max(20971520), max_pixels: z.number().int().positive().optional() })).refine(files => Object.keys(files).length <= 8),
});
export type CloneSendLimits = z.infer<typeof cloneSendLimitsSchema>;
export const cloneSendRightsSchema = z.object({
  read_at: z.iso.datetime({ offset: true }).max(64), status: z.enum(["creator", "administrator", "member", "restricted", "left", "kicked"]),
  can_send_messages: z.boolean(), can_send_audios: z.boolean(), can_send_documents: z.boolean(),
  can_send_photos: z.boolean(), can_send_videos: z.boolean(), can_send_video_notes: z.boolean(),
  can_send_voice_notes: z.boolean(), can_send_polls: z.boolean(), can_send_other_messages: z.boolean(),
  can_add_web_page_previews: z.boolean(),
});
export type CloneSendRights = z.infer<typeof cloneSendRightsSchema>;
export interface CloneMethodPayload { input: CloneMethodInput; files: Array<{ name: string; blob: Blob; filename: string; kind: string }> }

const fields: Record<string, string[]> = {
  sendMessage: ["text", "parse_mode"], sendPhoto: ["photo", "caption", "parse_mode"],
  sendDocument: ["document", "caption", "parse_mode"], sendVideo: ["video", "caption", "parse_mode"],
  sendAnimation: ["animation", "caption", "parse_mode"], sendAudio: ["audio", "caption", "parse_mode"],
  sendVoice: ["voice", "caption", "parse_mode"], sendVideoNote: ["video_note"], sendSticker: ["sticker", "emoji"],
  sendMediaGroup: ["media"], sendRichMessage: ["rich_message"],
  sendLocation: ["latitude", "longitude", "horizontal_accuracy"], sendVenue: ["latitude", "longitude", "title", "address"],
  sendContact: ["phone_number", "first_name", "last_name"],
  sendPoll: ["question", "options", "is_anonymous", "type", "allows_multiple_answers", "correct_option_ids", "explanation"],
  sendDice: ["emoji"],
};
const singleFiles: Record<string, string> = { sendPhoto: "photo", sendDocument: "document", sendVideo: "video",
  sendAnimation: "animation", sendAudio: "audio", sendVoice: "voice", sendVideoNote: "video_note", sendSticker: "sticker" };
const permission: Record<string, keyof CloneSendRights> = { photo: "can_send_photos", document: "can_send_documents",
  video: "can_send_videos", animation: "can_send_other_messages", audio: "can_send_audios", voice: "can_send_voice_notes",
  video_note: "can_send_video_notes", sticker: "can_send_other_messages" };
const json = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;

/** Only known wire fields are expressible. Unknown Telegram options keep the
 * local route instead of being silently dropped by the relay adapter. */
export function cloneMethodPayload(method: string, params: Record<string, unknown>, common: CloneSendInput,
  limits: CloneSendLimits, rights: CloneSendRights | null): CloneMethodPayload | null {
  if (!limits.methods.includes(method) || !fields[method]) return null;
  const kinds = new Map<string, string>();
  const input: CloneMethodInput = { client_key: common.client_key, chat_id: common.chat_id,
    silent: common.silent, ...(common.reply_to_message_id ? { reply_to_message_id: common.reply_to_message_id } : {}),
    ...(common.message_thread_id ? { message_thread_id: common.message_thread_id } : {}), method };
  const attach = (value: unknown, kind: string): string => {
    const name = value instanceof Blob ? kind : typeof value === "string" && /^attach:\/\/[A-Za-z0-9_]{1,32}$/.test(value) ? value.slice(9) : "";
    if (!name || kinds.has(name) && kinds.get(name) !== kind) throw new Error("invalid attachment");
    kinds.set(name, kind); return `attach://${name}`;
  };
  const caption = (item: Record<string, unknown>) => {
    if (item.caption !== undefined && (typeof item.caption !== "string" || (item.parse_mode === "HTML"
      ? [...item.caption].length > 4096 : item.caption.length > limits.max_caption_utf16))) throw new Error("caption limit");
    if (item.parse_mode !== undefined && item.parse_mode !== null && item.parse_mode !== "HTML") throw new Error("parse mode");
  };
  try {
    if (fields[method].includes("parse_mode") && params.parse_mode != null && params.parse_mode !== "HTML") return null;
    for (const key of fields[method]) if (params[key] !== undefined) input[key] = params[key];
    if (fields[method].includes("parse_mode")) input.parse_mode = params.parse_mode === "HTML" ? "HTML" : null;
    if (singleFiles[method]) input[singleFiles[method]] = attach(params[singleFiles[method]], singleFiles[method]);
    if (method === "sendMediaGroup") {
      const media = json(params.media);
      if (!Array.isArray(media) || media.length < 2 || media.length > 10) return null;
      input.media = media.map((item: Record<string, unknown>) => {
        if (!item || !["photo", "video", "document", "audio"].includes(String(item.type))
          || Object.keys(item).some(k => !["type", "media", "caption", "parse_mode"].includes(k))) throw new Error("media");
        caption(item); return { ...item, media: attach(item.media, String(item.type)), parse_mode: item.parse_mode ?? null };
      });
      const types = new Set(media.map(item => item.type));
      if ((types.has("document") || types.has("audio")) && types.size !== 1) return null;
    }
    if (method === "sendRichMessage") {
      const rich = json(params.rich_message) as Record<string, unknown>;
      if (!rich || Object.keys(rich).some(k => !["markdown", "html", "media"].includes(k))
        || (typeof rich.markdown === "string") === (typeof rich.html === "string")
        || [...String(rich.markdown ?? rich.html)].length > 32000) return null;
      input.rich_message = { ...rich };
      if (rich.media !== undefined) {
        if (!Array.isArray(rich.media) || rich.media.length > 10) return null;
        input.rich_message = { ...rich, media: rich.media.map(item => {
          if (!item || !/^[A-Za-z0-9_]{1,64}$/.test(item.id) || Object.keys(item).some(k => !["id", "media"].includes(k))
            || !item.media || Object.keys(item.media).some(k => !["type", "media"].includes(k))
            || !["photo", "video", "document", "audio"].includes(item.media.type)) throw new Error("rich media");
          return { id: item.id, media: { type: item.media.type, media: attach(item.media.media, item.media.type) } };
        }) };
      }
    }
    caption(input);
    if (method === "sendMessage" && (typeof input.text !== "string" || !input.text.trim()
      || [...input.text].length > 16384 || input.parse_mode !== "HTML" && input.text.length > 4096)) return null;
    const commonFields = ["chat_id", "reply_parameters", "message_thread_id", "disable_notification"];
    for (const key of Object.keys(params)) if (!commonFields.includes(key) && !fields[method].includes(key) && !kinds.has(key)) return null;
    const files = [...kinds].map(([name, kind]) => {
      const blob = params[name];
      const limit = limits.files[kind];
      if (!(blob instanceof Blob) || !limit || !limit.mime_types.includes(blob.type) || blob.size < 1 || blob.size > limit.max_bytes) throw new Error("file limit");
      // HTML documents always stay on the local bot, even if advertised.
      if (blob.type === "text/html") throw new Error("HTML document");
      const suffix = ({ "image/png": "png", "image/jpeg": "jpg" } as Record<string, string>)[blob.type] ?? "bin";
      const filename = blob instanceof File ? blob.name : `${name}.${suffix}`;
      if ([...filename].length > 128 || !filename || /[\\/:\x00-\x1f\x7f]|%[0-9a-f]{2}/i.test(filename)) throw new Error("filename");
      return { name, blob, filename, kind };
    });
    if (files.length > limits.max_files || files.reduce((n, f) => n + f.blob.size, 0) > limits.max_total_file_bytes
      || Buffer.byteLength(JSON.stringify(input)) > 65536) return null;
    if (!rights || ["left", "kicked"].includes(rights.status)) return null;
    if (files.some(f => rights[permission[f.kind]] !== true)) return null;
    if (!files.length && method !== "sendDice" && rights[method === "sendPoll" ? "can_send_polls" : "can_send_messages"] !== true) return null;
    return { input, files };
  } catch { return null; }
}

/** Framing is deterministic per key; retries open fresh streams over the same
 * immutable Blobs. Only headers and the small JSON part are buffered. */
export function cloneMultipart(payload: CloneMethodPayload) {
  const boundary = `delegatus_${payload.input.client_key}`;
  const first = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload.input)}\r\n`);
  const parts = payload.files.map(file => ({ ...file, header: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename.replace(/"/g, '\\"')}"\r\nContent-Type: ${file.blob.type}\r\n\r\n`) }));
  const last = Buffer.from(`--${boundary}--\r\n`);
  return { byteLength: first.length + last.length + parts.reduce((n, f) => n + f.header.length + f.blob.size + 2, 0),
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: async function* () {
      yield first;
      for (const file of parts) {
        yield file.header;
        const reader = file.blob.stream().getReader();
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; yield chunk.value; } }
        finally { await reader.cancel(); reader.releaseLock(); }
        yield Buffer.from("\r\n");
      }
      yield last;
    } };
}
