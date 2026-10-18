import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Restart the real module owner: both the budget and warning limiter are global.
test("archive residency, byte caps and warning rate survive compiled readers and reset on restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-cache-"));
  try {
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "collectionReadCache.ts")],
      target: "bun", outdir: root, naming: "cache-a.mjs" });
    expect(built.success).toBe(true);
    fs.copyFileSync(path.join(root, "cache-a.mjs"), path.join(root, "cache-b.mjs"));
    const script = `
      const a = await import(process.env.CACHE_MODULE_A);
      const b = await import(process.env.CACHE_MODULE_B);
      const key = (name, generation = 1) => JSON.stringify(["fixture.sqlite", generation, name, 1, "fixture"]);
      const put = (name, bytes, archive = false) => {
        const slot = a.collectionReadCache(key(name), archive);
        a.rememberCollectionReadCache(slot, { name }, bytes * 1024 * 1024);
        return slot;
      };
      let now = 1000; Date.now = () => now;
      const hot = put("pipelines", 64);
      const archive = put("pipelines_archive", 218, true);
      if (!hot.value || !archive.value) throw Error("measured working set evicted");
      if (b.collectionReadCache(key("pipelines_archive"), true) !== archive) throw Error("duplicate owner");
      put("tasks", 192); // exact shared cap
      if (!hot.value || !archive.value) throw Error("archive competed with hot slots");
      put("other", 1); // shared byte pressure
      if (hot.value !== null || !archive.value) throw Error("shared bound failed");
      put("pipelines_archive", 512, true); // exact archive cap
      if (!archive.value) throw Error("exact archive cap refused");
      put("pipelines_archive", 513, true);
      if (archive.value !== null) throw Error("oversized archive retained");
      now += 60_000;
      put("pipelines_archive", 513, true);
      const replacement = b.collectionReadCache(key("pipelines_archive", 2), true);
      b.rememberCollectionReadCache(replacement, {}, 218 * 1024 * 1024);
      if (archive.value !== null || !replacement.value) throw Error("old archive generation retained");
      for (let n = 0; n < 10; n++) put("scope-" + n, 1);
      if (!replacement.value) throw Error("slot pressure evicted archive");
      console.log("cache bounds passed");
    `;
    for (let restart = 0; restart < 2; restart++) {
      const run = path.join(root, String(restart));
      for (const directory of ["home", "xdg", "tmp", "state"]) fs.mkdirSync(path.join(run, directory), { recursive: true });
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HOME: path.join(run, "home"), XDG_CONFIG_HOME: path.join(run, "xdg"),
          TMPDIR: path.join(run, "tmp"), LLV_STATE_DIR: path.join(run, "state"),
          CACHE_MODULE_A: pathToFileURL(path.join(root, "cache-a.mjs")).href,
          CACHE_MODULE_B: pathToFileURL(path.join(root, "cache-b.mjs")).href },
        stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (exit !== 0) throw new Error(stderr);
      expect({ exit, stdout }).toEqual({ exit: 0, stdout: "cache bounds passed\n" });
      const lines = stderr.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('"collection":"pipelines"');
      expect(lines[1]).toContain('"collection":"pipelines_archive"');
      expect(stderr).not.toContain("fixture.sqlite");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
