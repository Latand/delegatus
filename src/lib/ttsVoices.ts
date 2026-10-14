import { redactSecrets } from "@/lib/review";
import type { TtsBackend, TtsBackendOption } from "@/lib/ttsBackend";

export interface TtsVoice { id: string; name: string; own: boolean }
export interface TtsVoicesResponse {
  backend: TtsBackend;
  voices: TtsVoice[];
  truncated: boolean;
  selected: { id: string; name: string | null; known: boolean | null };
}

/** Read through a byte ceiling and deadline, cancelling even a stalled body. */
export async function readBounded(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<string | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) { abort(); return null; }
    for (;;) {
      const result = await reader.read();
      if (signal.aborted) return null;
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > limit) { void reader.cancel().catch(() => undefined); return null; }
      parts.push(result.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    return new TextDecoder().decode(joined);
  } catch { return null; }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function json(payload: string | null): Record<string, unknown> {
  try { const value = JSON.parse(payload ?? "null"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
function detail(value: Record<string, unknown>): Record<string, unknown> {
  return value.detail && typeof value.detail === "object" ? value.detail as Record<string, unknown> : {};
}
export function voiceRefusal(backend: TtsBackend, status: number, payload: string | null): boolean {
  const value = json(payload);
  if (backend === "elevenlabs") return [400, 404].includes(status) && [detail(value).status, detail(value).code].includes("voice_not_found");
  if (backend === "fishaudio") return [400, 404].includes(status) && typeof value.message === "string" && /reference|voice/i.test(value.message);
  return backend === "soniox" && status === 400 && typeof value.error_message === "string" && /invalid voice/i.test(value.error_message);
}
export function providerErrorMessage(payload: string | null, key: string): string | null {
  const value = json(payload);
  const message = detail(value).message ?? value.message ?? value.error_message;
  return typeof message === "string" ? redactSecrets(message.split(key).join("[redacted]")).slice(0, 300) : null;
}
export class VoiceListError extends Error {
  constructor(public code: "provider-refused" | "unreachable", message: string) { super(message); }
}

/** Provider data is reduced to ids, display names and ownership before leaving the server. */
export async function fetchTtsVoices(backend: TtsBackend, option: TtsBackendOption, key: string, clientSignal: AbortSignal): Promise<TtsVoicesResponse> {
  const headers: Record<string, string> = backend === "elevenlabs" ? { "xi-api-key": key } : { authorization: `Bearer ${key}` };
  const get = async (url: string, lookup = false): Promise<Record<string, unknown> | null> => {
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(10_000)]);
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.body) throw new VoiceListError("unreachable", "Empty voice list response");
    const payload = await readBounded(response.body, 4 * 1024 * 1024, signal);
    if (payload === null) throw new VoiceListError("unreachable", "Voice list response exceeded its limit or timed out");
    if (!response.ok) {
      if (lookup && (voiceRefusal(backend, response.status, payload) || (backend === "fishaudio" && response.status === 404))) return null;
      throw new VoiceListError("provider-refused", providerErrorMessage(payload, key) ?? `Voice list refused (HTTP ${response.status})`);
    }
    try { const data = JSON.parse(payload); if (data && typeof data === "object") return data; } catch { /* reported below */ }
    throw new VoiceListError("unreachable", "Invalid voice list response");
  };
  const voices = new Map<string, TtsVoice>();
  const add = (id: unknown, name: unknown, own: boolean) => {
    if (typeof id !== "string" || typeof name !== "string") throw new VoiceListError("unreachable", "Invalid voice in provider response");
    voices.set(id, { id, name, own: own || voices.get(id)?.own === true });
  };
  const array = (value: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(value)) throw new VoiceListError("unreachable", "Invalid voice list response");
    return value;
  };
  let truncated = false;
  if (backend === "elevenlabs") {
    let token = "";
    for (let page = 0; page < 5; page++) {
      const data = (await get(`https://api.elevenlabs.io/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ""}`))!;
      for (const voice of array(data.voices)) add(voice.voice_id, voice.name, voice.is_owner === true);
      if (!data.has_more) break;
      if (typeof data.next_page_token !== "string" || !data.next_page_token) throw new VoiceListError("unreachable", "Missing voice list cursor");
      token = data.next_page_token;
      truncated = page === 4;
    }
  } else if (backend === "fishaudio") {
    add("default", "Fish default", false);
    for (let page = 1; page <= 5; page++) {
      const data = (await get(`https://api.fish.audio/model?self=true&page_size=100&page_number=${page}`))!;
      const items = array(data.items);
      for (const voice of items) add(voice._id, voice.title, true);
      if (typeof data.total !== "number") throw new VoiceListError("unreachable", "Missing voice list count");
      if (page * 100 >= data.total) break;
      truncated = page === 5;
    }
  } else if (backend === "soniox") {
    const data = (await get("https://api.soniox.com/v1/tts-models"))!;
    const models = array(data.models);
    let model = models.find((m) => m.id === option.model);
    const seen = new Set<unknown>();
    while (model?.aliased_model_id && !seen.has(model.id)) { seen.add(model.id); model = models.find((m) => m.id === model!.aliased_model_id); }
    if (!model || model.aliased_model_id) throw new VoiceListError("unreachable", "Configured speech model was absent from the voice list");
    for (const voice of array(model.voices)) add(voice.id, voice.id, false);
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const clones = (await get(`https://api.soniox.com/v1/voices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`))!;
      for (const voice of array(clones.voices)) add(voice.id, voice.name, true);
      if (!clones.next_page_cursor) break;
      cursor = String(clones.next_page_cursor);
      truncated = page === 4;
    }
  }
  let selected = voices.get(option.voice);
  let lookupMissing = false;
  if (!selected && (backend === "elevenlabs" || backend === "fishaudio")) {
    const data = await get(backend === "elevenlabs" ? `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(option.voice)}` : `https://api.fish.audio/model/${encodeURIComponent(option.voice)}`, true);
    lookupMissing = data === null;
    if (data) {
      add(option.voice, backend === "elevenlabs" ? data.name : data.title, data.is_owner === true);
      selected = voices.get(option.voice);
    }
  }
  return { backend, voices: [...voices.values()].sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name)), truncated,
    selected: { id: option.voice, name: selected?.name ?? null, known: selected ? true : lookupMissing ? false : truncated ? null : false } };
}
