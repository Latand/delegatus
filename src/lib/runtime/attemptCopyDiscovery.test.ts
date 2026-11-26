import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAttemptCopies } from "./attemptCopyDiscovery";

test.skipIf(process.platform === "win32").each([65, 513])("discovery reads a bounded page across process restarts (%i copies)", async total => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-discovery-"));
  for (let n = 0; n < total; n++) fs.mkdirSync(path.join(root, n.toString(16).padStart(64, "0")));
  const seen = new Set<string>(); let cursor = "", done = false;
  try {
    for (let pass = 0; !done && pass < Math.ceil((total + 2) / 32) + 2; pass++) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--copy-page", root, cursor],
        { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, error).toBe(0);
      const page = JSON.parse(output) as ReturnType<typeof discoverAttemptCopies>;
      expect(page.read).toBeLessThanOrEqual(32); expect(page.names.length).toBeLessThanOrEqual(32);
      expect(page.bytes).toBeLessThanOrEqual(4096);
      for (const name of page.names) { expect(seen.has(name)).toBeFalse(); seen.add(name); }
      cursor = page.cursor; done = page.done;
    }
    expect(done).toBeTrue(); expect(seen.size).toBe(total);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("deadline precedes directory enumeration and a changed parent starts a new page", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-discovery-budget-"));
  try {
    for (let n = 0; n < 65; n++) fs.mkdirSync(path.join(root, String(n)));
    const first = discoverAttemptCopies(root, "", () => 1, 2);
    expect(discoverAttemptCopies(root, first.cursor, () => 2, 2).read).toBe(0);
    fs.mkdirSync(path.join(root, "new-copy"));
    const restarted = discoverAttemptCopies(root, first.cursor, () => 1, 2);
    expect(restarted.names).toEqual(discoverAttemptCopies(root, "", () => 1, 2).names);
    expect(restarted.read).toBeLessThanOrEqual(32);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
