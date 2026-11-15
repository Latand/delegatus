import { redactMediaProjection, redactMediaText } from "./mediaPrivacy";

const MAX_WRAPPER_CHARS = 8 * 1024;

/** One secondary text stream. No payload is appended until its surrounding
 * JSON value is inspected. Oversized values are discarded while a bounded
 * lexical state walks to their end; native engine context is never changed. */
export function createMediaTextStream() {
  let pending = "";
  let wrapper: string | null = null;
  let depth = 0;
  let closers = "";
  let quoted = false;
  let escaped = false;
  let omitted = false;
  let url = false;

  const finish = () => {
    const tail = wrapper !== null
      ? omitted ? "[private relay media omitted]" : redactMediaProjection(wrapper)
      : pending.startsWith("media_") && pending.length > 6 ? "[private media]" : redactMediaText(pending);
    pending = ""; wrapper = null; depth = 0; closers = ""; quoted = false; escaped = false; omitted = false; url = false;
    return tail;
  };
  return {
    write(source: string): string {
      let output = "";
      for (const char of source) {
        if (wrapper !== null) {
          if (depth === Infinity) continue;
          if (!omitted) {
            if (wrapper.length < MAX_WRAPPER_CHARS) wrapper += char;
            else { wrapper = ""; omitted = true; }
          }
          if (escaped) escaped = false;
          else if (quoted && char === "\\") escaped = true;
          else if (char === '"') quoted = !quoted;
          else if (!quoted) {
            if (char === "{" || char === "[") {
              depth++;
              if (depth <= 64) closers += char === "{" ? "}" : "]";
            }
            if (char === "}" || char === "]") {
              if (char !== closers.at(-1)) { depth = Infinity; wrapper = ""; omitted = true; }
              else { depth--; closers = closers.slice(0, -1); }
            }
          }
          // A malformed, excessively nested value stays private until end.
          if (depth > 64) { depth = Infinity; wrapper = ""; omitted = true; }
          if (depth === 0) output += finish();
          continue;
        }
        if (url) {
          if (/[a-z0-9+/.;=,-]/i.test(char)) continue;
          url = false;
        }
        if (pending.startsWith("media_")) {
          if (/[0-9a-f]/.test(char)) {
            pending += char;
            if (pending.length === 38) { output += "[private media]"; pending = ""; }
            continue;
          }
          output += pending.length > 6 ? "[private media]" : pending;
          pending = "";
        } else if (pending) {
          const candidate = pending + char;
          if ("media_".startsWith(candidate) || "data:image/".startsWith(candidate.toLowerCase())) {
            pending = candidate;
            if (candidate.toLowerCase() === "data:image/") { output += "[private image]"; pending = ""; url = true; }
            continue;
          }
          output += pending;
          pending = "";
        }
        if (char === "{" || char === "[") { wrapper = char; depth = 1; closers = char === "{" ? "}" : "]"; }
        else if (char === "m" || char.toLowerCase() === "d") pending = char;
        else output += char;
      }
      return output;
    },
    finish,
    get pending() { return !!pending || wrapper !== null || url; },
  };
}
