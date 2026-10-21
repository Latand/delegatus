import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { removeTreeViaTrash } from "@/lib/tempSweep";
import { adoptLegacyTrash, quarantineTree, settleGatedTrash, type GatedTrashRow } from "./gatedTrash";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", root]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-gated-trash-"))); roots.push(root);
  const directory = path.join(root, "releases", "npm-1.0.0");
  fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), "{}");
  fs.writeFileSync(path.join(directory, "lib/index.js"), "module.exports = 1;");
  return { root, directory, journal: path.join(root, "package-trash-fixture.json") };
}
const gateMode = (row: GatedTrashRow) => fs.statSync(row.gate).mode & 0o777;
const outsiderCanEnter = (directory: string) => spawnSync("sh", ["-c", 'cd "$1"', "sh", directory]).status === 0;

test("the gate is closed to other processes during the observation and removal starts from inside it", async () => {
  const h = tree(); const cwd = process.cwd();
  const row = quarantineTree(h.directory, h.journal)!;
  expect(fs.existsSync(h.directory)).toBeFalse();
  let observed: { mode: number; cwd: string; enter: boolean } | undefined;
  const removed: string[] = [];
  const outcome = await settleGatedTrash(h.journal, row, {
    observe: async trash => { observed = { mode: gateMode(row), cwd: process.cwd(), enter: outsiderCanEnter(trash) }; return null; },
    first: ["lib/index.js"],
    remove: async entry => { removed.push(entry); await fs.promises.rm(entry, { recursive: true, force: true }); },
  });
  expect(outcome).toEqual({ removed: true });
  expect(observed).toEqual({ mode: 0, cwd: row.trash, enter: false });
  expect(removed).toEqual(["lib/index.js", "lib", "package.json"]);
  expect(process.cwd()).toBe(cwd);
  expect(fs.existsSync(row.gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
});

test.each(["hold", "beforeGate", "invalid", "throw"])("a %s outcome restores the tree to its path", async kind => {
  const h = tree(); const cwd = process.cwd();
  const row = quarantineTree(h.directory, h.journal)!;
  const settled = settleGatedTrash(h.journal, row, {
    beforeGate: async () => kind === "beforeGate" ? "uncommitted" : null,
    observe: async () => { if (kind === "throw") throw new Error("scan unavailable"); return kind === "hold" ? "rollback" : null; },
    validate: () => kind !== "invalid",
    remove: async () => { throw new Error("must not remove"); },
  });
  if (kind === "throw") await expect(settled).rejects.toThrow("scan unavailable");
  else expect(await settled).toEqual({ removed: false, reason: kind === "hold" ? "rollback" : kind === "beforeGate" ? "uncommitted" : "changed" });
  expect(fs.readFileSync(path.join(h.directory, "lib/index.js"), "utf8")).toBe("module.exports = 1;");
  expect(fs.existsSync(row.gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
  expect(process.cwd()).toBe(cwd);
});

test("an interrupted removal keeps its partial tree behind the gate, never restores it, and a later settle finishes it", async () => {
  const h = tree(); const cwd = process.cwd();
  const row = quarantineTree(h.directory, h.journal)!;
  await expect(settleGatedTrash(h.journal, row, { observe: async () => null, first: ["lib/index.js"],
    remove: async entry => { if (entry !== "lib/index.js") throw new Error("interrupted"); await fs.promises.rm(entry); } })).rejects.toThrow("interrupted");
  expect(process.cwd()).toBe(cwd); expect(gateMode(row)).toBe(0o700);
  const replay = JSON.parse(fs.readFileSync(h.journal, "utf8")) as GatedTrashRow;
  expect(replay.deleting).toBeTrue();
  expect(await settleGatedTrash(h.journal, replay, { observe: async () => "in-flight" })).toEqual({ removed: false, reason: "in-flight" });
  expect(fs.existsSync(h.directory)).toBeFalse(); expect(fs.existsSync(path.join(row.trash, "package.json"))).toBeTrue();
  expect(await settleGatedTrash(h.journal, replay, { observe: async () => null })).toEqual({ removed: true });
  expect(fs.existsSync(row.gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
});

test.each(["journal-only", "gate-made", "gate-left"])("recovery settles an intent interrupted at %s", async stage => {
  const h = tree();
  const gate = path.join(path.dirname(h.directory), ".delegatus-trash-npm-1.0.0-fixture");
  const row: GatedTrashRow = { directory: h.directory, gate, trash: path.join(gate, "npm-1.0.0"), identity: "0:0", uid: process.getuid?.() ?? 0,
    ...(stage === "gate-left" ? { deleting: true } : {}) };
  fs.writeFileSync(h.journal, JSON.stringify(row));
  if (stage !== "journal-only") fs.mkdirSync(gate, { mode: 0 });
  if (stage === "gate-left") fs.rmSync(h.directory, { recursive: true });
  const outcome = await settleGatedTrash(h.journal, row, { observe: async () => { throw new Error("never observed"); } });
  expect(outcome).toEqual(stage === "gate-left" ? { removed: true } : { removed: false, reason: "changed" });
  if (stage !== "gate-left") expect(fs.readFileSync(path.join(h.directory, "package.json"), "utf8")).toBe("{}");
  expect(fs.existsSync(gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
});

test("legacy trash is adopted behind a gate and returns with its own journal when held", async () => {
  const h = tree();
  await expect(removeTreeViaTrash(h.directory, { journal: h.journal, held: () => false, remove: async () => { throw new Error("interrupted"); } }))
    .rejects.toThrow("interrupted");
  const legacy = JSON.parse(fs.readFileSync(h.journal, "utf8"));
  const adopted = adoptLegacyTrash(h.journal, legacy, () => true)!;
  expect(fs.existsSync(legacy.trash)).toBeFalse(); expect(fs.existsSync(path.join(adopted.trash, "package.json"))).toBeTrue();
  expect(await settleGatedTrash(h.journal, adopted, { observe: async () => "process" })).toEqual({ removed: false, reason: "process" });
  expect(fs.existsSync(path.join(legacy.trash, "package.json"))).toBeTrue(); expect(fs.existsSync(h.directory)).toBeFalse();
  expect(JSON.parse(fs.readFileSync(h.journal, "utf8"))).toEqual(legacy);
  expect(fs.existsSync(adopted.gate)).toBeFalse();
  // A changed legacy tree is left exactly where it was.
  expect(adoptLegacyTrash(h.journal, legacy, () => false)).toBeNull();
  expect(fs.existsSync(path.join(legacy.trash, "package.json"))).toBeTrue();
  const again = adoptLegacyTrash(h.journal, legacy, () => true)!;
  expect(await settleGatedTrash(h.journal, again, { observe: async () => null })).toEqual({ removed: true });
  expect(fs.existsSync(legacy.trash)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
});

test("an adoption interrupted before its gate existed resumes from the legacy path", async () => {
  const h = tree();
  await expect(removeTreeViaTrash(h.directory, { journal: h.journal, held: () => false, remove: async () => { throw new Error("interrupted"); } }))
    .rejects.toThrow("interrupted");
  const legacy = JSON.parse(fs.readFileSync(h.journal, "utf8"));
  const stat = fs.lstatSync(legacy.trash);
  const gate = path.join(path.dirname(h.directory), ".delegatus-trash-npm-1.0.0-adopting");
  const row: GatedTrashRow = { directory: h.directory, gate, trash: path.join(gate, "npm-1.0.0"), identity: `${stat.dev}:${stat.ino}`, uid: stat.uid,
    legacyTrash: legacy.trash, legacyRow: legacy };
  fs.writeFileSync(h.journal, JSON.stringify(row));
  expect(await settleGatedTrash(h.journal, row, { observe: async () => null })).toEqual({ removed: true });
  expect(fs.existsSync(legacy.trash)).toBeFalse(); expect(fs.existsSync(gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
});

test("a tree replaced at its quarantine path is never removed", async () => {
  const h = tree();
  const row = quarantineTree(h.directory, h.journal)!;
  fs.renameSync(row.trash, path.join(h.root, "moved-away")); fs.mkdirSync(row.trash); fs.writeFileSync(path.join(row.trash, "foreign"), "keep");
  expect(await settleGatedTrash(h.journal, row, { observe: async () => null })).toEqual({ removed: false, reason: "changed" });
  expect(fs.readFileSync(path.join(row.trash, "foreign"), "utf8")).toBe("keep");
});

test.skipIf(process.platform !== "linux")("no process of the installation user can enter the trash through the remover's /proc links while the gate is closed", async () => {
  const h = tree();
  const row = quarantineTree(h.directory, h.journal)!;
  const entries: Record<string, boolean> = {};
  const outcome = await settleGatedTrash(h.journal, row, {
    observe: async () => {
      for (const link of [`/proc/${process.pid}/cwd`, `/proc/self/../${process.pid}/cwd`]) entries[link] = outsiderCanEnter(link);
      return null;
    },
  });
  expect(entries).toEqual({ [`/proc/${process.pid}/cwd`]: false, [`/proc/self/../${process.pid}/cwd`]: false });
  expect(outcome).toEqual({ removed: true });
  // Outside the window the process is ordinary again.
  expect(outsiderCanEnter(`/proc/${process.pid}/cwd`)).toBeTrue();
});

test.each(["edited", "added", "replaced"] as const)("a replayed deletion preserves a partial tree %s after the interruption", async change => {
  const h = tree();
  fs.writeFileSync(path.join(h.directory, "lib/other.js"), "module.exports = 2;");
  const row = quarantineTree(h.directory, h.journal)!;
  await expect(settleGatedTrash(h.journal, row, { observe: async () => null, first: ["lib/index.js"],
    remove: async entry => { if (entry !== "lib/index.js") throw new Error("interrupted"); await fs.promises.rm(entry); } })).rejects.toThrow("interrupted");
  const replay = JSON.parse(fs.readFileSync(h.journal, "utf8")) as GatedTrashRow;
  expect(replay.deleting).toBeTrue();
  const other = path.join(row.trash, "lib/other.js");
  if (change === "edited") fs.writeFileSync(other, "new operator bytes");
  if (change === "added") fs.writeFileSync(path.join(row.trash, "lib/new.js"), "new operator bytes");
  if (change === "replaced") { fs.rmSync(path.join(row.trash, "lib"), { recursive: true }); fs.mkdirSync(path.join(row.trash, "lib")); fs.writeFileSync(other, "new operator bytes"); }
  expect(await settleGatedTrash(h.journal, replay, { observe: async () => null })).toEqual({ removed: false, reason: "changed" });
  const kept = change === "added" ? path.join(row.trash, "lib/new.js") : other;
  expect(fs.readFileSync(kept, "utf8")).toBe("new operator bytes");
  expect(fs.existsSync(h.journal)).toBeTrue();
});

test("a replayed deletion of an unchanged partial tree finishes", async () => {
  const h = tree();
  fs.writeFileSync(path.join(h.directory, "lib/other.js"), "module.exports = 2;");
  const row = quarantineTree(h.directory, h.journal)!;
  await expect(settleGatedTrash(h.journal, row, { observe: async () => null, first: ["lib/index.js"],
    remove: async entry => { if (entry !== "lib/index.js") throw new Error("interrupted"); await fs.promises.rm(entry); } })).rejects.toThrow("interrupted");
  const replay = JSON.parse(fs.readFileSync(h.journal, "utf8")) as GatedTrashRow;
  expect(await settleGatedTrash(h.journal, replay, { observe: async () => null })).toEqual({ removed: true });
  expect(fs.existsSync(row.gate)).toBeFalse(); expect(fs.existsSync(h.journal)).toBeFalse();
  expect(fs.readdirSync(h.root).filter(name => name.startsWith("package-trash"))).toEqual([]);
});
