import type { FileEntry } from "@/lib/types";

import { readAsksYouSettings } from "./settings";
import { openAskIndex, readOperatorAsks, type OperatorAskRecord } from "./store";

/**
 * Stamp each conversation's newest ask on its current entry, for `/api/files`
 * (docs/research/attention-classifier.md §7.3). Whether it is still open is
 * the reason model's call, over the entry's own turn and message clocks. With
 * the switch off nothing is stamped, so turning it off clears every card. A
 * retired round is skipped, as the dismissal overlay skips it. A store that
 * cannot be read costs the flag, never the poll.
 */
export function overlayOperatorAsks(
  files: readonly FileEntry[],
  read: () => Map<string, OperatorAskRecord> | null = () => (readAsksYouSettings().enabled ? openAskIndex(readOperatorAsks()) : null),
): void {
  let index: Map<string, OperatorAskRecord> | null;
  try {
    index = read();
  } catch {
    index = null;
  }
  for (const file of files) {
    const ask = !index || file.supersededBy || file.migratedTo
      ? undefined
      : (file.conversationId ? index.get(file.conversationId) : undefined) ?? index.get(file.path);
    if (ask) file.operatorAsk = { id: ask.id, messageAt: ask.messageAt, gist: ask.gist };
    else if (file.operatorAsk) delete file.operatorAsk;
  }
}
