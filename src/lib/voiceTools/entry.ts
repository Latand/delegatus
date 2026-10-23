import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { VoiceToolServer } from "./contracts";

/** Kept outside the store graph: the probe never imports Viewer state. */
export async function verifyEntry(server: VoiceToolServer): Promise<void> {
  if (!server.entryFile) return;
  try {
    const hash = createHash("sha256");
    const file = await fs.open(server.entryFile.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("ENTRY_CHANGED");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) throw new Error("ENTRY_CHANGED");
        hash.update(chunk);
      }
    } finally { await file.close(); }
    if (hash.digest("hex") !== server.entryFile.sha256) throw new Error("ENTRY_CHANGED");
  } catch { throw new Error("ENTRY_CHANGED"); }
}
