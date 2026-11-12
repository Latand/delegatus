import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { sweepTemporaryData, temporaryDataProtection, TEMPORARY_DATA_RETENTION_MS as WEEK, type TemporaryDataPorts } from "./temporaryDataRetention";

const roots: string[] = [], stores: TemporaryDataStore[] = [];
const NOW = Date.UTC(2035, 0, 15);
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(directory = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-retention-")); roots.push(root);
  const scope = path.join(root, "evidence"), candidate = path.join(scope, "lane", directory ? "captures" : "capture.png");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  if (directory) { fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, "screen.png"), "capture"); }
  else fs.writeFileSync(candidate, "capture");
  const store = new TemporaryDataStore(path.join(root, "retention.sqlite")); stores.push(store);
  const stat = fs.lstatSync(candidate);
  const row: TemporaryDataCandidate = { directory: candidate, scope, kind: "lane-evidence", owner: "lane-fixture", identity: `${stat.dev}:${stat.ino}`,
    adoptedAt: NOW - WEEK - 1, checkedAt: 0, bytes: 0, reason: "fixture" };
  store.register(row);
  const ports: TemporaryDataPorts = { now: () => NOW, mounts: () => [], claim: async () => () => {},
    authority: async () => ({ expiresAt: NOW - 1, reason: "young", revision: "one", current: () => true }), references: async () => true };
  return { root, store, row, ports };
}

test.each([true, false])("expired evidence is removed through a journal (directory=%s)", async directory => {
  const f = fixture(directory);
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0);
  expect(fs.existsSync(f.row.directory)).toBeFalse(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
  expect(f.store.get(f.row.directory)).toBeNull();
});

test.each([true, false])("dry-run leaves every candidate and journal untouched (directory=%s)", async directory => {
  const f = fixture(directory), before = fs.lstatSync(f.row.directory);
  const report = await sweepTemporaryData(f.store, { ...f.ports, mode: "dry-run", claim: async () => { throw new Error("dry-run claimed"); } });
  expect(report.wouldRemove).toBe(1); expect(report.removed).toBe(0);
  expect(fs.lstatSync(f.row.directory).ino).toBe(before.ino); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each(["young", "open-lane", "owner-missing"])("%s authority retains evidence", async reason => {
  const f = fixture();
  const report = await sweepTemporaryData(f.store, { ...f.ports, authority: async () => ({ expiresAt: reason === "young" ? NOW + 1 : null, reason, revision: "one", current: () => true }) });
  expect(report.removed).toBe(0); expect(report.kept[reason]).toBe(1); expect(fs.existsSync(f.row.directory)).toBeTrue();
});

test.each(["ancestor", "descendant"])("a %s keep marker retains evidence", async where => {
  const f = fixture(); fs.writeFileSync(path.join(where === "ancestor" ? path.dirname(f.row.directory) : f.row.directory, ".delegatus-keep"), "keep");
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(report.kept["keep-marker"]).toBe(1);
});

test.each(["worktree", "worktree-backup.json", "bundles", ".git"])("%s preservation survives", async name => {
  const f = fixture(); fs.writeFileSync(path.join(f.row.directory, name), "only copy");
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(report.kept["preservation-record"]).toBe(1);
  expect(fs.readFileSync(path.join(f.row.directory, name), "utf8")).toBe("only copy");
});

test.each(["claim", "initial-authority", "references", "dispatch-authority"])("revocation at %s prevents removal", async seam => {
  const f = fixture(); let allowed = true, authorities = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports,
    claim: async () => { if (seam === "claim") allowed = false; return () => {}; },
    authority: async () => { authorities++; if (seam === "initial-authority" || seam === "dispatch-authority" && authorities === 2) allowed = false;
      return { expiresAt: allowed ? NOW - 1 : null, reason: "open-lane", revision: "one", current: () => allowed }; },
    references: async () => { if (seam === "references") allowed = false; return true; },
  });
  expect(report.removed).toBe(0); expect(fs.existsSync(f.row.directory)).toBeTrue();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each([true, false])("a keep marker appearing after quarantine restores the candidate (%s)", async directory => {
  const f = fixture(directory); let calls = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async (_row, target) => {
    if (++calls === 2) fs.writeFileSync(path.join(path.dirname(target), ".delegatus-keep"), "new hold"); return true;
  } });
  expect(report.removed).toBe(0); expect(fs.existsSync(f.row.directory)).toBeTrue();
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test("a replacement identity and a symlink never grant removal", async () => {
  const f = fixture(); fs.renameSync(f.row.directory, f.row.directory + "-old"); fs.symlinkSync(f.row.directory + "-old", f.row.directory);
  const report = await sweepTemporaryData(f.store, f.ports);
  expect(report.removed).toBe(0); expect(fs.readFileSync(path.join(f.row.directory, "screen.png"), "utf8")).toBe("capture");
});

test("a changed protection snapshot after a checkout observation retains the tree", async () => {
  const f = fixture();
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async () => { fs.writeFileSync(path.join(f.row.directory, "late.txt"), "late"); return true; } });
  expect(report.removed).toBe(0); expect(report.kept["fence-changed"]).toBe(1);
});

test.each([true, false])("revoking authority after quarantine restores the original identity (%s)", async directory => {
  const f = fixture(directory); let allowed = true, calls = 0;
  const report = await sweepTemporaryData(f.store, { ...f.ports,
    authority: async () => ({ expiresAt: NOW - 1, reason: "open-lane", revision: "one", current: () => allowed }),
    references: async () => { if (++calls === 2) allowed = false; return true; },
  });
  expect(report.removed).toBe(0); expect(fs.lstatSync(f.row.directory).ino.toString()).toBe(f.row.identity.split(":")[1]);
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test("live references retain evidence and later due work progresses", async () => {
  const f = fixture();
  const second = { ...f.row, directory: path.join(path.dirname(f.row.directory), "second"), owner: "second" };
  fs.mkdirSync(second.directory); const stat = fs.lstatSync(second.directory); second.identity = `${stat.dev}:${stat.ino}`; f.store.register(second);
  const report = await sweepTemporaryData(f.store, { ...f.ports, references: async row => row.owner === "second" });
  expect(report.checked).toBe(2); expect(report.removed).toBe(1); expect(fs.existsSync(f.row.directory)).toBeTrue();
});

test("young rows schedule at expiry and leave admission for later eligible work", async () => {
  const f = fixture(false);
  const expired = path.join(path.dirname(f.row.directory), "zz-expired.png");
  fs.renameSync(f.row.directory, expired); f.store.forget(f.row.directory); f.row.directory = expired; f.store.register(f.row);
  for (let i = 0; i < 40; i++) {
    const directory = path.join(path.dirname(f.row.directory), `young-${i}`); fs.writeFileSync(directory, "evidence");
    const stat = fs.lstatSync(directory); f.store.register({ ...f.row, directory, owner: "young", identity: `${stat.dev}:${stat.ino}` });
  }
  const report = await sweepTemporaryData(f.store, { ...f.ports, authority: async row => ({ expiresAt: row.owner === "young" ? NOW + WEEK : NOW - 1,
    reason: "young", revision: "fixture", current: () => true }) });
  expect(report).toMatchObject({ checked: 41, removed: 1, errors: 0 });
  expect(f.store.get(path.join(path.dirname(f.row.directory), "young-0"))?.checkedAt).toBe(NOW + WEEK);
});

test("a bounded protection walk refuses large trees and expires its budget", () => {
  const f = fixture(); let time = 0;
  expect(() => temporaryDataProtection(f.row, f.row.directory, () => ++time, 2)).toThrow("protection-budget");
});

test("a flat legacy evidence copy exceeding ten thousand captures can retire", async () => {
  const f = fixture();
  for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(f.row.directory, `capture-${i}.png`), "");
  const report = await sweepTemporaryData(f.store, { ...f.ports, budgetMs: 20000 });
  expect(report).toMatchObject({ removed: 1, errors: 0 }); expect(fs.existsSync(f.row.directory)).toBeFalse();
});

test("adoption clocks and due checkpoints survive reopening the real ledger", async () => {
  const f = fixture(); const name = f.store.filename;
  f.store.record(f.row.directory, NOW + 1, 4096, "young"); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const store = new TemporaryDataStore(name); stores.push(store);
  expect(store.get(f.row.directory)?.adoptedAt).toBe(NOW - WEEK - 1);
  expect(await sweepTemporaryData(store, f.ports)).toMatchObject({ checked: 0, removed: 0 });
  expect(await sweepTemporaryData(store, { ...f.ports, now: () => NOW + 1 })).toMatchObject({ checked: 1, removed: 1 });
});

test.each([true, false])("a new process recovers the real quarantine writer's intent (directory=%s)", async directory => {
  const f = fixture(directory);
  const run = async (mode: string, time: number) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0); return output;
  };
  expect(await run("crash", NOW)).toBe("quarantined\n");
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeTrue(); expect(fs.existsSync(f.row.directory)).toBeFalse();
  expect(JSON.parse(await run("recover", NOW + 60001))).toMatchObject({ removed: 1, errors: 0 });
  expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse(); expect(f.store.get(f.row.directory)).toBeNull();
});

test.each([true, false])("a restarted process restores evidence when authority is revoked (directory=%s)", async directory => {
  const f = fixture(directory);
  for (const [mode, time] of [["crash", NOW], ["recover-held", NOW + 60001]] as const) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0);
    if (mode === "recover-held") expect(JSON.parse(output)).toMatchObject({ removed: 0, errors: 0 });
  }
  expect(fs.existsSync(f.row.directory)).toBeTrue(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});

test.each([true, false])("a restart settles the real post-removal journal without a surviving resource (%s)", async directory => {
  const f = fixture(directory);
  for (const [mode, time] of [["crash-after-remove", NOW], ["recover", NOW + 60001]] as const) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "temporaryDataRetention.fixture.ts"), f.store.filename, mode, String(time)], { stdout: "pipe", stderr: "pipe" });
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, error).toBe(0);
    if (mode === "recover") expect(JSON.parse(output)).toMatchObject({ removed: 0, errors: 0 });
  }
  expect(f.store.get(f.row.directory)).toBeNull(); expect(fs.existsSync(attemptTempJournalPath(f.row.directory))).toBeFalse();
});
