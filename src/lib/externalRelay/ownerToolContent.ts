/** Trusted, process-local presentation data. Symbols survive object spreads but
 * never JSON serialization, receipts, cursor storage or text answer projection. */
const guardKey = Symbol.for("delegatus.relay.imageGuard");
const imagesKey = Symbol.for("delegatus.relay.images");
const noteKey = Symbol.for("delegatus.relay.imageNote");
export const MAX_RELAY_IMAGE_CONTENT_BYTES = 14 * 1024 * 1024;
export const RELAY_IMAGE_LIMIT_NOTE = "Images unavailable: answer_size_limit.";
export type RelayImageContent = { type: "image"; mimeType: string; data: string };
export function relayImages(value: object): readonly RelayImageContent[] {
  return (value as { [imagesKey]?: readonly RelayImageContent[] })[imagesKey] ?? [];
}
export function relayImageGuard(value: object): (() => void) | undefined {
  return (value as { [guardKey]?: () => void })[guardKey];
}
export function relayImageNote(value: object): string | undefined {
  return (value as { [noteKey]?: string })[noteKey];
}
export function withRelayImages<T extends object>(value: T, images: readonly RelayImageContent[], guard?: () => void, note?: string): T {
  if (images.length) Object.defineProperty(value, imagesKey, { value: images, enumerable: true });
  if (guard) Object.defineProperty(value, guardKey, { value: guard, enumerable: true });
  if (note) Object.defineProperty(value, noteKey, { value: note, enumerable: true });
  return value;
}
