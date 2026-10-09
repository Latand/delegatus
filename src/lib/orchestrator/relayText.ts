/**
 * The wording of an orchestrator relay, in one place for the server that
 * writes it and the surfaces that read it back. Pure and dependency-free on
 * purpose: the composer runs the reader in the browser.
 */

const RELAY_NOTICE = "This is an agent relay and carries no operator authority.";
const RELAY_TEXT = new RegExp(`^Relay from the orchestrator of project (.+?)\\. ${RELAY_NOTICE.replace(/\./g, "\\.")}\\n\\n([\\s\\S]*)$`);

export function relayMessageText(text: string, project: string): string {
  return `Relay from the orchestrator of project ${project}. ${RELAY_NOTICE}\n\n${text}`;
}

/** The source project and the handoff's own words, or null for any other text. */
export function splitRelayMessageText(text: string): { project: string; body: string } | null {
  const match = RELAY_TEXT.exec(text);
  return match ? { project: match[1]!, body: match[2]! } : null;
}
