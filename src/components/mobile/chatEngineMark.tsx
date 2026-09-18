"use client";

import { EngineMark } from "@/components/EngineMark";
import type { FileEntry } from "@/lib/types";

/*
 * The engine mark that rides the phone's meta lines (docs/design/mobile-v2/
 * README.md §3.2): `dot · state phrase · ENGINE MARK · model · reasoning`.
 *
 * The mark carries the engine and the model name carries the model, so the
 * line never spends a word on what a 14 px mark already says — the strip's
 * "Claude · Claude · Claude" is exactly what the bar must not become. It is
 * decoration beside text that already names the engine's model, so it is
 * hidden from the accessibility tree rather than labelled twice.
 *
 * The mark itself is the Viewer's one shared `EngineMark` (#1743): the phone
 * and the desktop draw the same Claude and Codex.
 */
export function ChatEngineMark({ file }: { file: FileEntry }) {
  /* `data-mobile2-engine` stays the phone's own selector for this mark (mobile
     v2 README §3.2); what changed under it is the drawing. */
  return (
    <span data-mobile2-engine={file.engine} className="inline-flex shrink-0" aria-hidden>
      <EngineMark engine={file.engine} size={14} />
    </span>
  );
}
