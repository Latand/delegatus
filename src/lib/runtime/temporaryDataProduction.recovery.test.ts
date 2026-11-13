import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { TemporaryDataStore } from "./temporaryDataStore";
import { AttemptTempStore } from "./attemptTempRetention";

const NOW = Date.UTC(2035, 0, 15), WEEK = 7 * 86400000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-copy-recovery-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state"), filename = path.join(state, "temporary-data.sqlite");
  const store = new TemporaryDataStore(filename); cleanups.push(() => store.close());
  const original = path.join(root, "expired-original"), sourceIdentity = "17:23";
  const name = createHash("sha256").update(original).update("\0").update(sourceIdentity).digest("hex");
  const directory = path.join(state, "evidence", "attempt-temp", name), journal = attemptTempJournalPath(directory);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = { original, identity: sourceIdentity, files: [] };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "capture.png"), "preserved capture");
  const stat = fs.statSync(directory);
  store.register({ directory, scope: path.join(state, "evidence"), kind: "ownerless-copy", owner: name,
    identity: `${stat.dev}:${stat.ino}`, adoptedAt: NOW - WEEK - 1000, checkedAt: 0, bytes: 0, reason: "fixture" });
  const run = async (mode: string, time = NOW) => {
    store.record(directory, 0, 0, "retry");
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), filename, mode, String(time)], {
      env: { ...process.env, LLV_STATE_DIR: state, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0); return output;
  };
  return { root, state, store, directory, journal, inode: stat.ino, manifest, run };
}

for (const crash of ["none", "before-rename", "after-restore"] as const) {
  test(`production copy recovery settles its real durable writer (${crash})`, async () => {
    const f = fixture();
    if (crash === "before-rename") expect(await f.run("crash-before-rename")).toBe("intent-written\n");
    if (crash === "after-restore") {
      expect(await f.run("crash")).toBe("quarantined\n");
      expect(await f.run("crash-after-restore", NOW + 60001)).toBe("restored\n");
    }
    if (crash !== "none") {
      const intent = JSON.parse(fs.readFileSync(f.journal, "utf8"));
      expect(fs.existsSync(intent.trash)).toBeFalse();
      expect(fs.statSync(f.directory).ino).toBe(f.inode);
    }
    expect(JSON.parse(await f.run("production-recover", NOW + 120002))).toMatchObject({ removed: 1, errors: 0 });
    expect(JSON.parse(await f.run("production-recover", NOW + 180003))).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.existsSync(f.directory)).toBeFalse(); expect(fs.existsSync(f.journal)).toBeFalse();
    expect(f.store.get(f.directory)).toBeNull();
  });

  for (const change of ["identity", "binding", "preservation", "ownership", "competing-trash"] as const) {
    if (crash === "none") continue;
    test(`production copy recovery preserves ${change} after ${crash}`, async () => {
      const f = fixture();
      if (crash === "before-rename") expect(await f.run("crash-before-rename")).toBe("intent-written\n");
      else {
        expect(await f.run("crash")).toBe("quarantined\n");
        expect(await f.run("crash-after-restore", NOW + 60001)).toBe("restored\n");
      }
      let preserved = f.directory;
      if (change === "identity") {
        preserved = path.join(f.root, "preserved-original"); fs.renameSync(f.directory, preserved);
        fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, "replacement"), "keep replacement");
      }
      if (change === "competing-trash") {
        const intent = JSON.parse(fs.readFileSync(f.journal, "utf8"));
        fs.mkdirSync(intent.trash); fs.writeFileSync(path.join(intent.trash, "replacement"), "keep competing trash");
      }
      if (change === "binding") fs.writeFileSync(path.join(f.directory, "manifest.json"),
        JSON.stringify({ ...f.manifest, original: path.join(f.root, "different-source") }));
      if (change === "preservation") fs.writeFileSync(path.join(f.directory, "worktree-backup.json"), "keep preservation");
      if (change === "ownership") {
        const ledger = new AttemptTempStore(path.join(f.state, "attempt-temp.sqlite"));
        try { ledger.registerCopy({ destination: f.directory, pipelineId: null, launchId: "live-owner", kind: "agent",
          createdAt: NOW, expiresAt: null, checkedAt: 0, bytes: 0 }); } finally { ledger.close(); }
        fs.writeFileSync(path.join(f.directory, "manifest.json"), JSON.stringify({ ...f.manifest, launchId: "other-owner" }));
      }
      for (const time of [NOW + 120002, NOW + 180003]) {
        const report = JSON.parse(await f.run("production-recover", time));
        expect(report.removed).toBe(0); expect(f.store.get(f.directory)).not.toBeNull();
        expect(fs.statSync(preserved).ino).toBe(f.inode);
        expect(fs.readFileSync(path.join(preserved, "capture.png"), "utf8")).toBe("preserved capture");
        if (change === "identity") expect(fs.readFileSync(path.join(f.directory, "replacement"), "utf8")).toBe("keep replacement");
        if (change === "preservation") expect(fs.readFileSync(path.join(f.directory, "worktree-backup.json"), "utf8")).toBe("keep preservation");
        if (change === "competing-trash") {
          const intent = JSON.parse(fs.readFileSync(f.journal, "utf8"));
          expect(fs.readFileSync(path.join(intent.trash, "replacement"), "utf8")).toBe("keep competing trash");
        }
      }
    });
  }
}
