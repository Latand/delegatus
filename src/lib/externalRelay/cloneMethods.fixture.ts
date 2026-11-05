import type { CloneSendLimits, CloneSendRights } from "./cloneMethods";

export const cloneMethodsNow = Date.parse("2026-11-04T18:00:00Z");
export function clonePdfBytes() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>"];
  let document = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => { const offset = Buffer.byteLength(document); document += `${index + 1} 0 obj\n${body}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
export const cloneMethodLimits = (): CloneSendLimits => ({ methods: ["sendMessage", "sendPhoto", "sendDocument", "sendMediaGroup", "sendRichMessage"],
  max_files: 10, max_total_file_bytes: 67108864, max_body_bytes: 68157440, max_caption_utf16: 1024, file_pending_s: 120,
  files: { photo: { mime_types: ["image/jpeg", "image/png"], max_bytes: 10000000, max_pixels: 20000000 },
    document: { mime_types: ["application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "image/jpeg", "image/png"], max_bytes: 20971520 } } });
export const cloneMethodRights = (overrides: Partial<CloneSendRights> = {}): CloneSendRights => ({
  read_at: new Date(cloneMethodsNow).toISOString(), status: "member", can_send_messages: true,
  can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true,
  can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, ...overrides,
});
export const cloneMethodDescriptor = (origin: string, limits = cloneMethodLimits()) => ({ protocol: "delegatus-relay", versions: [1],
  name: "Fixture relay", description: "", api_base: `${origin}/api/relay/v1`, kinds: ["answer"], features: ["clone_send_methods"],
  liveness: { poll_freshness_s: 60, claim_window_s: 60, ack_window_s: 60, heartbeat_interval_s: 5, stall_window_s: 30 },
  limits: { max_response_bytes: 1048576, max_wait_s: 30, max_answer_chars: 16384, clone_send: limits } });

export async function decodeCloneMultipart(headers: Record<string, string | string[] | undefined>, bytes: Buffer) {
  const form = await new Request("http://127.0.0.1", { method: "POST", headers: { "content-type": String(headers["content-type"]) }, body: new Uint8Array(bytes) }).formData();
  const message = form.get("message");
  if (typeof message !== "string" && !(message instanceof Blob)) throw new Error("message part missing");
  const input = JSON.parse(typeof message === "string" ? message : await message.text()) as Record<string, unknown>;
  const files = new Map<string, File>();
  // Bun retains quoted-string escapes. Match python-multipart's header
  // decoder: https://github.com/Kludex/python-multipart/blob/master/python_multipart/multipart.py
  for (const [name, file] of form) if (name !== "message" && file instanceof File)
    files.set(name, new File([await file.arrayBuffer()], file.name.replaceAll(String.fromCharCode(92, 34), String.fromCharCode(34)), { type: file.type }));
  return { input, files };
}
