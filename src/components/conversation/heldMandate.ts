import { ORCHESTRATOR_ROLE_TABLE_HEADING, orchestratorMandateWithRoleTable } from "@/lib/orchestrator/prompt";
import type { MandateDelivery } from "@/lib/runtime/messageOrigin";

/**
 * A seat's mandate card across the adoption of its live conversation.
 *
 * The server strips `prompt` and `mandate` from the launch facts when the live
 * conversation is adopted, a poll before the transcript's own record of the
 * mandate has rendered, and a surface that re-resolves the conversation at that
 * moment (the phone's focus view) mounts a new feed that never saw them. The
 * last pair a feed rendered is therefore kept here by conversation identity, outside any
 * one mount, so the card stays the seat's first message until the transcript's
 * record takes its place.
 */
export interface HeldMandate {
  conversationKey: string;
  text: string;
  echoText?: string;
  ts: number | undefined;
  mandate: MandateDelivery;
}

const KEEP = 32;
const held = new Map<string, HeldMandate>();

export function holdMandate(card: HeldMandate): void {
  held.delete(card.conversationKey);
  held.set(card.conversationKey, card);
  for (const oldest of held.keys()) {
    if (held.size <= KEEP) break;
    held.delete(oldest);
  }
}

export function heldMandateFor(conversationKey: string | null | undefined): HeldMandate | null {
  return conversationKey ? held.get(conversationKey) ?? null : null;
}

/** The server completes a provisional mandate with delivery directives and
 * its frozen role table. Match that composition as well as the raw editor text. */
export function heldMandateMatches(card: HeldMandate, recordText: string): boolean {
  const text = recordText.trim();
  if (text === card.text.trim() || text === card.echoText?.trim()) return true;
  const delivered = orchestratorMandateWithRoleTable(card.text, null).trim();
  // A provisional card can precede the server's exact echo. The role scaffold
  // prefixes the same completed mandate; only its first uncropped record uses
  // this fallback, and provenance remains authoritative once it arrives.
  const start = text.startsWith(delivered) ? 0 : text.indexOf(`\n\n${delivered}`);
  if (start < 0) return false;
  const body = text.slice(start === 0 ? 0 : start + 2);
  return body === delivered || body.startsWith(`${delivered}\n\n${ORCHESTRATOR_ROLE_TABLE_HEADING}\n`);
}

/**
 * Which sections of the card the reader has opened, kept per conversation for the
 * same reason: the held card and the transcript's own card are two mounts of
 * one thing, and a card opened before the hand-over stays open after it.
 */
export type MandateSection = "mandate" | "handoff";

const opened = new Map<string, Map<MandateSection, string>>();

export function mandateSectionOpen(conversationKey: string | null | undefined, section: MandateSection): boolean {
  return conversationKey ? opened.get(conversationKey)?.has(section) ?? false : false;
}

/** Keep the section the reader is currently reading stable until reopened. */
export function mandateSectionText(conversationKey: string | null | undefined, section: MandateSection): string | null {
  return conversationKey ? opened.get(conversationKey)?.get(section) ?? null : null;
}

export function setMandateSectionOpen(conversationKey: string | null | undefined, section: MandateSection, open: boolean, text: string): void {
  if (!conversationKey) return;
  const sections = opened.get(conversationKey) ?? new Map<MandateSection, string>();
  if (open) sections.set(section, text);
  else sections.delete(section);
  opened.delete(conversationKey);
  if (sections.size === 0) return;
  opened.set(conversationKey, sections);
  for (const oldest of opened.keys()) {
    if (opened.size <= KEEP) break;
    opened.delete(oldest);
  }
}

export function resetHeldMandatesForTests(): void {
  held.clear();
  opened.clear();
}
