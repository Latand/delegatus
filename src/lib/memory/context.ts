import fs from "node:fs";
import { normalizeSessionLine } from "@/lib/session/reader";
import { readMessagesPage } from "@/lib/session/messagesPage";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { cleanEnvelope } from "./selection";

/** A bounded prefix for the opening request and the existing bounded tail reader. */
export function memoryTurnContext(filename: string, engine: "claude" | "codex", latest: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, "r");
    const size = fs.fstatSync(fd).size;
    const claudeOrigins = engine === "claude" ? claudeMessageProvenance(filename) : {};
    const roleFor = (role: string, text: string, sourceId?: string) => {
      if (role !== "user") return role;
      const origin = engine === "codex" ? decodeCodexStructuredUserText(text).origin?.kind : sourceId ? claudeOrigins[sourceId]?.origin : undefined;
      return origin === "agent" ? "machine" : role;
    };
    const prefix = Buffer.alloc(Math.min(size, 256000));
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    let opening: { role: string; text: string } | undefined;
    for (const line of prefix.toString("utf8").split("\n")) {
      try {
        const row = JSON.parse(line);
        const sourceId = engine === "claude" && typeof row.uuid === "string" ? row.uuid : undefined;
        for (const { record } of normalizeSessionLine(engine, row)) {
          if (record.kind === "message" && roleFor(record.role, record.text, sourceId) === "user" && !/^(# AGENTS\.md|<environment_context>|<permissions instructions>)/.test(record.text.trim())) {
            opening = { role: "user", text: cleanEnvelope(record.text) }; break;
          }
        }
      } catch { /* incomplete prefix line */ }
      if (opening) break;
    }
    const page = readMessagesPage({ descriptor: fd, size, engine }, { kinds: new Set(["message"]), roles: new Set(["user", "assistant"]), limit: 16, maxChars: 4000 });
    const recent = page.records.reverse().map(r => ({ role: roleFor(r.role, r.text, r.sourceId), text: cleanEnvelope(r.text) }));
    if (recent.at(-1)?.role === "user" && recent.at(-1)?.text === cleanEnvelope(latest)) recent.pop();
    return opening ? [opening, ...recent.filter(r => r.text !== opening.text)] : recent;
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
