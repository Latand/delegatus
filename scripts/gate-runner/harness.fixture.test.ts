// destructive-code: no received command is ever executed by the SSH double.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeHarness } from "./harness.fixture";

test("SSH double records and refuses arbitrary shell text, including metacharacters around a known verb", () => {
  const h = makeHarness();
  try {
    const marker = path.join(h.root, "must-not-exist");
    for (const command of [`touch '${marker}'`, `~/.bun/bin/bun ~/runs/aaaaaaaaaaaa/serve.ts run ~/runs/aaaaaaaaaaaa; touch '${marker}'`, `mkdir -p ~/runs/../../outside && tar -xf - -C ~/runs/../../outside`]) {
      const result = spawnSync(h.stub, ["fixture-host", command], { env: h.env(), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(255);
      expect(fs.existsSync(marker)).toBeFalse();
    }
    expect(h.calls()).toHaveLength(3);
    expect(h.calls().every(call => (call as { refused?: boolean }).refused)).toBeTrue();
  } finally { h.cleanup(); }
});
