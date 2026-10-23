import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { inspectTree, sweepStaleTempDirs } from "./tempSweep";

test("a capped stale sweep spends its removal budget on the oldest root first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cap-sweep-"));
  const now = Date.parse("2030-01-01T00:00:00Z");
  const newer = path.join(root, "llv-a-newer"), older = path.join(root, "llv-z-older");
  for (const [directory, age] of [[newer, 2], [older, 4]] as const) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "disposable");
    fs.utimesSync(directory, new Date(now - age * 86400000), new Date(now - age * 86400000));
  }
  try {
    const report = await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], now: () => now, maxAgeMs: 86400000,
      maxRemovals: 1, scan: { ownNamespace: null, processes: [] },
      inspect: (directory, options) => ({ ...inspectTree(directory, options), newestMs: 0 }) });
    expect(report.removed.map(row => path.basename(row.path))).toEqual(["llv-z-older"]);
    expect(fs.existsSync(newer)).toBeTrue();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
