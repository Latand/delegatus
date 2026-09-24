import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readViewerEntries, recordViewerEntries } from "./viewerEntries";

test("the bound entries round-trip, and anything else reads as no record (#2024)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-entries-"));
  try {
    const filename = path.join(directory, "state", "viewer-entries.json");
    expect(readViewerEntries(filename)).toBeNull();

    recordViewerEntries(filename, { stablePort: 8898, stableEntry: "local-entry", remoteEntryPort: 8897 });
    expect(readViewerEntries(filename)).toEqual({ stablePort: 8898, stableEntry: "local-entry", remoteEntryPort: 8897 });
    recordViewerEntries(filename, { stablePort: 8898, stableEntry: "pipe", remoteEntryPort: null });
    expect(readViewerEntries(filename)).toEqual({ stablePort: 8898, stableEntry: "pipe", remoteEntryPort: null });
    /* Written by rename: nothing is left beside it. */
    expect(fs.readdirSync(path.dirname(filename))).toEqual(["viewer-entries.json"]);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);

    for (const raw of ["", "{", "[]", "null", '{"stablePort":0,"stableEntry":"pipe","remoteEntryPort":null}', '{"stablePort":8898,"stableEntry":"trusted","remoteEntryPort":null}', '{"stablePort":8898,"stableEntry":"pipe","remoteEntryPort":"8897"}']) {
      fs.writeFileSync(filename, raw);
      expect(readViewerEntries(filename)).toBeNull();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
