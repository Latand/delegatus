/** Trusted, process-local presentation data. Symbols survive object spreads but
 * never JSON serialization, receipts, cursor storage or text answer projection. */
const guardKey = Symbol.for("delegatus.relay.imageGuard");
const imagesKey = Symbol.for("delegatus.relay.images");
export type RelayImageContent = { type: "image"; mimeType: string; data: string };
export function relayImages(value: object): readonly RelayImageContent[] {
  return (value as { [imagesKey]?: readonly RelayImageContent[] })[imagesKey] ?? [];
}
export function relayImageGuard(value: object): (() => void) | undefined {
  return (value as { [guardKey]?: () => void })[guardKey];
}
export function withRelayImages<T extends object>(value: T, images: readonly RelayImageContent[], guard?: () => void): T {
  if (images.length) Object.defineProperty(value, imagesKey, { value: images, enumerable: true });
  if (guard) Object.defineProperty(value, guardKey, { value: guard, enumerable: true });
  return value;
}
