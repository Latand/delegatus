import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGateCheckTool } from "./gateCheckTool";
import { cpuOwnerIdentity } from "./signalSandboxContext";
import { custodyClock, physical } from "../recordedChecks/wire";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-tool-")); roots.push(root);
  const log = path.join(root, "check.log"), dir = `${log}.gate`;
  fs.mkdirSync(dir); fs.writeFileSync(log, "working\n");
  const recorder = cpuOwnerIdentity(process.pid);
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(recorder));
  fs.writeFileSync(path.join(dir, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(dir), deadlineUptimeMs: custodyClock() + 60_000 }));
  const call = (signal = new AbortController().signal) => runGateCheckTool({ log, reason: "fixture check" }, root, signal);
  return { root, log, dir, call };
}
function finish(dir: string, exit: number) {
  fs.writeFileSync(path.join(dir, "exit.tmp"), `${exit}\n`);
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
}

test.each([0, 37, 124])("one callback spans progress and preserves terminal exit %s", async exit => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.dir, "completion.json"));
  let settled = false;
  const held = f.call().then(result => { settled = true; return result; });
  for (let i = 0; i < 1000; i++) fs.appendFileSync(f.log, `progress ${i}\n`);
  await Promise.resolve(); expect(settled).toBe(false);
  finish(f.dir, exit);
  const result = await held;
  expect(result.success).toBe(true);
  expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: true, code: exit });
  expect(fs.readFileSync(path.join(f.dir, "completion.json"))).toEqual(before);
  expect(await f.call()).toEqual(result);
});

test.each([94, 360])("the original %s-minute deadline expires once and stays nonterminal", async minutes => {
  const f = fixture(); let expire!: () => void, timers = 0, scheduled = 0;
  const ticket = JSON.parse(fs.readFileSync(path.join(f.dir, "completion.json"), "utf8"));
  fs.writeFileSync(path.join(f.dir, "completion.json"), JSON.stringify({ ...ticket, deadlineUptimeMs: custodyClock() + minutes * 60_000 }));
  const schedule = globalThis.setTimeout;
  let ownedTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    timers++; scheduled = ms; expire = callback; ownedTimer = schedule(() => {}, ms); return ownedTimer;
  }) as typeof setTimeout);
  try {
    const held = f.call();
    expect(timers).toBe(1);
    expect(scheduled).toBeGreaterThan((minutes - 1) * 60_000);
    expire();
    const result = await held;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: false, code: 124 });
    expect(fs.existsSync(path.join(f.dir, "exit"))).toBe(false);
  } finally { clearTimeout(ownedTimer); timer.mockRestore(); }
});

test("cancellation closes the wait and leaves the original recording intact", async () => {
  const f = fixture(), abort = new AbortController();
  const held = f.call(abort.signal); abort.abort();
  expect(await held).toMatchObject({ success: false });
  expect(fs.readFileSync(f.log, "utf8")).toBe("working\n");
  finish(f.dir, 0); expect((await f.call()).success).toBe(true);
});

test.each(["missing", "malformed", "owner", "directory"])("unusable %s proof remains unknown", async kind => {
  const f = fixture();
  if (kind === "missing") fs.unlinkSync(path.join(f.dir, "completion.json"));
  if (kind === "malformed") fs.writeFileSync(path.join(f.dir, "completion.json"), "{}");
  if (kind === "owner") fs.writeFileSync(path.join(f.dir, "owner.json"), "{}");
  if (kind === "directory") {
    const ticket = JSON.parse(fs.readFileSync(path.join(f.dir, "completion.json"), "utf8"));
    fs.writeFileSync(path.join(f.dir, "completion.json"), JSON.stringify({ ...ticket, directoryIdentity: "0:0" }));
  }
  finish(f.dir, 0);
  expect((await f.call()).success).toBe(false);
});

test.each(["owner.json", "completion.json"])("proof %s replaced during the wait refuses its late result", async file => {
  const f = fixture(), held = f.call();
  fs.writeFileSync(path.join(f.dir, file), "{}"); finish(f.dir, 0);
  expect((await held).success).toBe(false);
});

test("foreign and indirect logs refuse before reading a result", async () => {
  const f = fixture(), other = fixture(); finish(other.dir, 0);
  const args = { log: other.log, reason: "foreign check" };
  expect((await runGateCheckTool(args, f.root, new AbortController().signal)).success).toBe(false);
  fs.symlinkSync(other.root, path.join(f.root, "indirect"), "dir");
  expect((await runGateCheckTool({ ...args, log: path.join(f.root, "indirect/check.log") }, f.root, new AbortController().signal)).success).toBe(false);
  expect((await runGateCheckTool({ log: f.log }, f.root, new AbortController().signal)).success).toBe(false);
});

test("a temporary-root alias retains its physical ownership", async () => {
  const f = fixture(), alias = fixture(); finish(f.dir, 0);
  const link = path.join(alias.root, "temporary-root"); fs.symlinkSync(f.root, link, "dir");
  expect((await runGateCheckTool({ log: path.join(link, "check.log"), reason: "aliased root" }, link, new AbortController().signal)).success).toBe(true);
});

for (const shape of ["internal-link", "physical-root", "normalized-child"] as const) test(`owned log waits through ${shape}`, async () => {
  const f = fixture(), alias = fixture(); finish(f.dir, 0);
  let root = f.root, log = f.log;
  if (shape === "internal-link") {
    fs.symlinkSync(f.root, path.join(f.root, "nested"), "dir");
    log = path.join(f.root, "nested", "check.log");
  } else if (shape === "physical-root") {
    root = path.join(alias.root, "alias"); fs.symlinkSync(f.root, root, "dir");
  } else {
    fs.mkdirSync(path.join(f.root, "child"));
    log = `${f.root}/child/../check.log`;
  }
  const result = await runGateCheckTool({ log, reason: "owned check" }, root, new AbortController().signal);
  expect(result.success).toBe(true);
  expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: true, code: 0 });
});

for (const shape of ["absolute", "parent", "symlink", "prefix"] as const) test(`foreign ${shape} log names both paths and stays refused`, async () => {
  const f = fixture(), other = fixture(); finish(other.dir, 0);
  const root = f.root; let log = other.log;
  if (shape === "parent") log = `${f.root}/../${path.basename(other.root)}/check.log`;
  if (shape === "symlink") {
    fs.symlinkSync(other.root, path.join(f.root, "foreign"), "dir");
    log = path.join(f.root, "foreign", "check.log");
  }
  if (shape === "prefix") {
    const sibling = `${f.root}-sibling`; fs.renameSync(other.root, sibling); roots.push(sibling);
    log = path.join(sibling, "check.log");
  }
  const result = await runGateCheckTool({ log, reason: "foreign check" }, root, new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.contentItems[0].text).toContain(`root=${JSON.stringify(root)}`);
  expect(result.contentItems[0].text).toContain(`log=${JSON.stringify(log)}`);
  const owned = shape === "prefix" ? log : other.log;
  expect((await runGateCheckTool({ log: owned, reason: "owner control" }, path.dirname(owned), new AbortController().signal)).success).toBe(true);
});

test("unknown stage root never adopts a caller-supplied log", async () => {
  const f = fixture(); finish(f.dir, 0);
  const result = await runGateCheckTool({ log: f.log, reason: "unknown owner" }, null, new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.contentItems[0].text).toContain("root=null");
  expect(result.contentItems[0].text).toContain(JSON.stringify(f.log));
});

test.each(["root", "parent"])("a missing %s diagnoses both paths without waiting", async missing => {
  const f = fixture();
  const root = missing === "root" ? path.join(f.root, "absent") : f.root;
  const log = missing === "parent" ? path.join(f.root, "absent/check.log") : f.log;
  const result = await runGateCheckTool({ log, reason: "missing path" }, root, new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.contentItems[0].text).toContain(`root=${JSON.stringify(root)}`);
  expect(result.contentItems[0].text).toContain(`log=${JSON.stringify(log)}`);
});
