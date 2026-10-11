import { jsonObject, type LiveCommand } from "./provider";

/** Codex's flat transcripts have no audio clock. Receipt offsets supply the
 * companion timeline; done repeats the part's full text, never another delta.
 * This adapter owns no transcript history, admission or credential masking. */
export class CodexVoiceTranscript {
  private readonly parts = new Map<string, string>();
  notification(method: string, value: unknown, atMs: number): LiveCommand[] {
    const params = jsonObject(value);
    if (!params || !["user", "assistant"].includes(String(params.role)) || !Number.isFinite(atMs) || atMs < 0) return [];
    const role = params.role as string;
    const prefix = role === "user" ? "session.input_transcript" : "session.output_transcript";
    if (method === "thread/realtime/transcript/delta" && typeof params.delta === "string" && params.delta.length <= 16_000) {
      this.parts.set(role, ((this.parts.get(role) ?? "") + params.delta).slice(0, 16_000));
      return [{ type: `${prefix}.delta`, delta: params.delta, start_ms: atMs, end_ms: atMs }];
    }
    if (method !== "thread/realtime/transcript/done" || typeof params.text !== "string" || params.text.length > 16_000) return [];
    const earlier = this.parts.get(role) ?? "";
    this.parts.delete(role);
    const tail = params.text.startsWith(earlier) ? params.text.slice(earlier.length) : "";
    return [...(tail ? [{ type: `${prefix}.delta`, delta: tail, start_ms: atMs, end_ms: atMs }] : []),
      { type: `${prefix}.done`, offset_ms: atMs }];
  }
}
