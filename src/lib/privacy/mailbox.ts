/* Shared RFC 5322 mailbox shape. The publication gate adds contextual
   exemptions to occurrences; strict reports admit no mailbox exemptions.
   International local parts are enabled for strict public reports. */
const quotedLocalPart = /"(?:[^"\\\r\n]|\\.)*"/;
const dotAtomLocalPart = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+/;
const internationalLocalPart = /[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+/u;
// Contextual code points and dot variants belong to IDNA domain labels.
const domainLabel = String.raw`(?:[A-Z0-9\p{L}\p{M}\p{N}\p{Default_Ignorable_Code_Point}\u00B7\u0375\u05F3\u05F4\u0F0B\u30FB-]|\\x[0-9a-f]{2})+`;
const domainSeparator = String.raw`[.\u3002\uFF0E\uFF61]`;
const domainSource = `(${domainLabel}(?:${domainSeparator}${domainLabel})+)`;

/** Captures local part and domain, in that order, for occurrence readers. */
export function mailboxPattern(international = false): RegExp {
  const local = international ? internationalLocalPart : dotAtomLocalPart;
  return new RegExp(`(${quotedLocalPart.source}|${local.source})@${domainSource}`, "giu");
}
