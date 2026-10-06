import { readStructuredUserMetadata, persistStructuredUserMetadata } from "@/lib/selection/structuredUserMetadata";
import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";
import { parseMessageOrigin, type MessageOrigin } from "./messageOrigin";
import { decodeCodexStructuredUserText as decode, encodeCodexStructuredUserText as encode } from "./codexStructuredUserText";
import { structuredContentDigest } from "./structuredContent";
import { RECOVERY_NOTICE_ORIGIN } from "./recoveryNotices";

/** All Codex delivery paths persist their metadata before exposing the marker
 * to the engine. The pure codec remains usable by the browser. */
export function encodeCodexStructuredUserText(
  text: string,
  contentDigest?: string,
  selectedContext?: SelectedContextRef | null,
  origin?: MessageOrigin | null,
  deliveryDedup?: string | null,
): string {
  const parsedOrigin = parseMessageOrigin(origin);
  const automatic = parsedOrigin?.kind === "agent" && (parsedOrigin.role === "pipeline" || parsedOrigin.role === RECOVERY_NOTICE_ORIGIN.role);
  const metadata = {
    version: 1 as const,
    contentDigest: contentDigest ?? (automatic ? structuredContentDigest({ text, images: [] }) : null),
    selectedContext: parseSelectedContextRef(selectedContext),
    origin: parsedOrigin,
    ...(deliveryDedup && /^[a-f0-9]{64}$/.test(deliveryDedup) ? { deliveryDedup } : {}),
  };
  const ref = persistStructuredUserMetadata(metadata);
  return encode(text, ref, metadata.origin);
}

export function decodeCodexStructuredUserText(text: string) {
  const decoded = decode(text);
  if (!decoded.metadataRef) return decoded;
  const metadata = readStructuredUserMetadata(decoded.metadataRef);
  const { metadataRef: _, ...legacyShape } = decoded;
  return { ...legacyShape, contentDigest: metadata.contentDigest, selectedContext: metadata.selectedContext,
    origin: metadata.origin, ...(metadata.deliveryDedup ? { deliveryDedup: metadata.deliveryDedup } : {}) };
}
