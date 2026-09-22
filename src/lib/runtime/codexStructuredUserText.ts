import {
  decodeSelectedContextRef,
  type SelectedContextRef,
} from "@/lib/selection/selectedContext";

import { messageOriginRole, type MessageOrigin } from "./messageOrigin";

/**
 * The marker line that makes a Codex app-server user record recognisably OURS.
 *
 * New deliveries carry `ctx` (a durable metadata handle) and `origin`.
 * The d-prefixed handle contains the full delivery hash, so browser rows
 * retain their submission identity before metadata is fetched. The server
 * record holds the selected card, sender role and image content digest.
 *
 * Legacy attributes remain independent: `sha256`, base64 JSON `ctx`, `origin`,
 * `sender` and `dedup`. Bare, digest-only and long-context records decode
 * byte-identically to their original shapes. Transcripts are not migrated.
 *
 * Attributes are `name=value` whose values may hold anything but a space and a
 * `>`, so the marker cannot be broken open by its own payload and stays on one
 * line. The grammar is deliberately looser than what we WRITE: a corrupt or
 * forged attribute value must cost only that attribute, never the record's
 * structured-user identity, which is what routes it to the user lane. The
 * operator's own text may legitimately begin with something marker-shaped, so
 * the prefix is only ever stripped once, from the front.
 */

/* The newline after the marker is what SEPARATES it from the message, so a
   record with no message has nothing to separate: a send that carried only an
   attachment is written as the marker and nothing else, and whatever handles
   the record on the way back may trim the trailing newline off it. Accepting
   end-of-string there is what stops such a record decoding as a message whose
   text IS the marker — which is how an image-only send printed its own
   delivery comment at the operator instead of being recognised as theirs. */
const MARKER_WITH_ATTRIBUTES = /^<!-- llv:structured-user((?: [a-z0-9]+=[^ >]+)+) -->(?:\n|$)/;
const BARE_MARKER = /^<!-- llv:structured-user -->(?:\n|$)/;
const ATTRIBUTE = /(?:^| )([a-z0-9]+)=([^ >]+)/g;
const SHA256 = /^[a-f0-9]{64}$/;

/** A full 256-bit delivery key, encoded compactly. The prefix distinguishes
 * durable references from every legacy base64 JSON context token. */
export function structuredUserReferenceKey(value: string): string | null {
  if (!/^[dh]\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const binary = atob(value.slice(2).replace(/-/g, "+").replace(/_/g, "/") + "=");
    const key = Array.from(binary, (byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    return binary.length === 32 && structuredUserReference(key, value[0] === "d") === value ? key : null;
  } catch { return null; }
}

export function structuredUserReference(key: string, delivery: boolean): string {
  if (!SHA256.test(key)) throw new Error("invalid structured-user reference key");
  const binary = key.match(/../g)!.map((byte) => String.fromCharCode(parseInt(byte, 16))).join("");
  return `${delivery ? "d" : "h"}.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export interface DecodedCodexStructuredUserText {
  text: string;
  structured: boolean;
  contentDigest: string | null;
  /** The selected-card reference this turn was admitted with, or null. A
      corrupt or forged value decodes as null: the record still reads. */
  selectedContext: SelectedContextRef | null;
  /** Authorship stamped at delivery (#1117), or null when the record predates
      the attribute or the value did not validate — the feed then keeps its
      current rendering rather than guessing. */
  origin: MessageOrigin | null;
  /** Hashed durable operation identity used only for recipient-side replay
      convergence. Optional so every pre-#1366 transcript keeps its exact
      decoded shape. */
  deliveryDedup?: string;
  /** Durable metadata reference. Present only on the compact wire form. */
  metadataRef?: string;
}

/** Encode only a durable reference; delivery metadata never enters the prompt. */
export function encodeCodexStructuredUserText(
  text: string,
  metadataRef: string,
  origin?: MessageOrigin | null,
): string {
  if (!structuredUserReferenceKey(metadataRef)) throw new Error("invalid structured-user reference");
  return `<!-- llv:structured-user ctx=${metadataRef}${origin ? ` origin=${origin.kind}` : ""} -->\n${text}`;
}

export function decodeCodexStructuredUserText(value: string): DecodedCodexStructuredUserText {
  const marker = value.match(MARKER_WITH_ATTRIBUTES);
  if (marker) {
    let contentDigest: string | null = null;
    let selectedContext: SelectedContextRef | null = null;
    let originKind: MessageOrigin["kind"] | null = null;
    let senderRole: string | undefined;
    let deliveryDedup: string | undefined;
    let metadataRef: string | undefined;
    for (const [, name, attribute] of marker[1]!.matchAll(ATTRIBUTE)) {
      if (name === "sha256" && SHA256.test(attribute!)) contentDigest = attribute!;
      if (name === "ctx") {
        const key = structuredUserReferenceKey(attribute!);
        if (key) {
          metadataRef = attribute!;
          if (attribute!.startsWith("d.")) deliveryDedup = key;
        } else selectedContext = decodeSelectedContextRef(attribute!);
      }
      if (name === "origin" && (attribute === "operator" || attribute === "agent")) originKind = attribute;
      if (name === "sender") senderRole = messageOriginRole(attribute);
      if (name === "dedup" && SHA256.test(attribute!)) deliveryDedup = attribute!;
    }
    const origin: MessageOrigin | null = originKind
      ? { kind: originKind, ...(originKind === "agent" && senderRole ? { role: senderRole } : {}) }
      : null;
    return {
      text: value.slice(marker[0].length),
      structured: true,
      contentDigest,
      selectedContext,
      origin,
      ...(deliveryDedup ? { deliveryDedup } : {}),
      ...(metadataRef ? { metadataRef } : {}),
    };
  }
  const bare = value.match(BARE_MARKER);
  if (!bare) {
    return { text: value, structured: false, contentDigest: null, selectedContext: null, origin: null };
  }
  return {
    text: value.slice(bare[0].length),
    structured: true,
    contentDigest: null,
    selectedContext: null,
    origin: null,
  };
}
