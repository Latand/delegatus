import crypto from "node:crypto";
import { structuredContent } from "../structuredContent";
import type { QueueEntry } from "../engineHost";

/** Independent producer for receipt readers: no composer under test. */
export function fixtureInboxBatch(members: Array<{ id: string; text: string; operator?: boolean }>): QueueEntry {
  let text = "[Delegatus] Messages arrived while you were working.\n";
  const parts = members.map((m, i) => {
    const headerStart = text.length;
    text += `[${i + 1}/${members.length} · from ${m.operator ? "the operator" : "agent reviewer"} · sent 06:00:00 UTC]\n`;
    const textStart = text.length;
    text += m.text;
    const textEnd = text.length;
    text += "\n";
    return { operationId: m.id, contentDigest: structuredContent(m.text, []).contentDigest,
      admittedAt: "2026-10-17T06:00:00.000Z", origin: m.operator ? { kind: "operator" as const } : { kind: "agent" as const, role: "reviewer" },
      headerStart, textStart, textEnd, imageStart: 0, imageEnd: 0 };
  });
  const id = "inbox_" + crypto.createHash("sha256").update(parts.map(p => `${p.operationId}:${p.contentDigest}`).join("\n")).digest("hex").slice(0, 32);
  return { id, ...structuredContent(text, []), parts };
}
