/*
 * What an ask says, in the agent's own words (docs/research/attention-classifier.md
 * §7.3): the sentence that asks, on one line. Nothing is generated; the
 * operator reads the request as the agent wrote it.
 */

export const GIST_MAX_CHARS = 160;

function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, "$1");
}

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?…])\s+(?=\S)/)) {
      const sentence = part.replace(/\s+/g, " ").trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

function clip(sentence: string): string {
  if (sentence.length <= GIST_MAX_CHARS) return sentence;
  const cut = sentence.slice(0, GIST_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > GIST_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The last sentence that asks a question, among the last few; else the last
 * sentence. Agents rarely end on a question mark ("say the word and I'll
 * merge"), and the ask is usually where the message ends.
 */
export function askGist(text: string): string {
  const all = sentences(plain(text));
  if (!all.length) return "";
  const tail = all.slice(-4);
  const question = tail.findLast((sentence) => sentence.includes("?"));
  return clip(question ?? all.at(-1)!);
}

/** Stage endings that already settle through their own channel (§6). */
const STRUCTURED_ENDING = /(?:^|\n)\s*(?:REVIEW_READY\b|VERDICT\s*:|APPROVE\b|REQUEST_CHANGES\b|NO FINDINGS\b)|```json\s*\{\s*"status"\s*:/;
/** Engine error strings: a deterministic state, never an ask (§6). */
const ENGINE_ERROR = /^(?:API Error\b|Session limit reached|Claude AI usage limit reached|You've hit your (?:usage )?limit|OAuth (?:token )?(?:refresh )?(?:has )?(?:expired|failed)|Invalid API key|Credit balance is too low|stream disconnected|Request timed out|unexpected status \d{3})/i;
export const MIN_ASK_BODY_CHARS = 30;

/** Why a message is not sent at all, or null when it is. */
export function askSkipReason(text: string): "short" | "structured" | "engine-error" | null {
  const body = text.trim();
  if (body.length < MIN_ASK_BODY_CHARS) return "short";
  if (STRUCTURED_ENDING.test(body)) return "structured";
  if (ENGINE_ERROR.test(body)) return "engine-error";
  return null;
}
