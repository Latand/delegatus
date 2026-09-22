/** Historical encoder retained only as a fixture for pre-change transcripts. */
import { encodeSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";
import { messageOriginRole, type MessageOrigin } from "./messageOrigin";
const SHA256 = /^[a-f0-9]{64}$/;
const STRUCTURED_USER_MARKER = "<!-- llv:structured-user -->\n";

export function encodeCodexStructuredUserText(
  text: string,
  contentDigest?: string,
  selectedContext?: SelectedContextRef | null,
  origin?: MessageOrigin | null,
  deliveryDedup?: string | null,
): string {
  const attributes: string[] = [];
  if (contentDigest) attributes.push(`sha256=${contentDigest}`);
  if (selectedContext) attributes.push(`ctx=${encodeSelectedContextRef(selectedContext)}`);
  if (origin) {
    attributes.push(`origin=${origin.kind}`);
    const role = messageOriginRole(origin.role);
    if (role) attributes.push(`sender=${role}`);
  }
  if (deliveryDedup && SHA256.test(deliveryDedup)) attributes.push(`dedup=${deliveryDedup}`);
  if (attributes.length === 0) return STRUCTURED_USER_MARKER + text;
  return `<!-- llv:structured-user ${attributes.join(" ")} -->\n${text}`;
}
