/** Browser-safe transcript state: completion order may differ from item order. */
export interface OpenAiTranscriptItem { id: string; text: string; complete: boolean }
export interface OpenAiTranscript { items: OpenAiTranscriptItem[] }
export const OPENAI_TRANSCRIPTION_STOP_MS = 10_000;
export const openAiCommitEvent = () => ({ type: "input_audio_buffer.commit" as const });
export function reduceOpenAiTranscript(state: OpenAiTranscript, value: unknown): OpenAiTranscript {
  if (!value || typeof value !== "object") return state;
  const event = value as Record<string, unknown>;
  const complete = event.type === "conversation.item.input_audio_transcription.completed";
  if (!complete && event.type !== "conversation.item.input_audio_transcription.delta") return state;
  if (typeof event.item_id !== "string" || typeof (complete ? event.transcript : event.delta) !== "string") return state;
  const items = state.items.slice();
  const index = items.findIndex(item => item.id === event.item_id);
  const item = index < 0 ? { id: event.item_id, text: "", complete: false } : items[index];
  if (item.complete) return state;
  const next = { id: item.id, text: complete ? event.transcript as string : item.text + event.delta, complete };
  if (index < 0) items.push(next); else items[index] = next;
  return { items };
}
export function openAiTranscriptText(state: OpenAiTranscript): string { return state.items.map(item => item.text).filter(Boolean).join(" "); }
