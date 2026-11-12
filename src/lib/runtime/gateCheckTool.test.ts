import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindGateCheckRoot, runGateCheckTool } from "./gateCheckTool";
import * as gateWait from "./gateWait";
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
  const binding = bindGateCheckRoot(root);
  const call = (signal = new AbortController().signal) => runGateCheckTool({ log, reason: "fixture check" }, binding, signal);
  return { root, binding, log, dir, call };
}
function finish(dir: string, exit: number) {
  fs.writeFileSync(path.join(dir, "exit.tmp"), `${exit}\n`);
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
}

// Drop only completion notifications, while driving the wait's clock explicitly.
function missedNotifications(directory: string) {
  let now = 0;
  let watcher: fs.FSWatcher;
  let notify!: () => void;
  const pending = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout, watch = fs.watch;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    const timer = schedule(() => {}, 3_600_000);
    pending.set(timer, { at: now + ms, callback });
    return timer;
  }) as typeof setTimeout);
  const cancellations = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    const ownedTimer = timer as ReturnType<typeof setTimeout>;
    pending.delete(ownedTimer); cancel(ownedTimer);
  });
  const notifications = spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    if (args[0] === directory) {
      const listener = args[args.length - 1] as (event: string, filename: string) => void;
      notify = () => listener("rename", "exit");
      watcher = watch(directory, () => {}); return watcher;
    }
    return watch(...args);
  }) as typeof fs.watch);
  return {
    pending,
    get watcher() { return watcher; },
    notify() { notify(); },
    advance(ms: number) {
      now += ms;
      for (const [timer, entry] of [...pending]) if (entry.at <= now) {
        pending.delete(timer); cancel(timer); entry.callback();
      }
    },
    restore() {
      for (const timer of pending.keys()) cancel(timer);
      notifications.mockRestore(); cancellations.mockRestore(); timers.mockRestore(); clock.mockRestore();
    },
  };
}

test.each([0, 37, 124])("a missed completion notification still settles exit %s within one second", async exit => {
  const f = fixture(), clock = missedNotifications(f.dir), abort = new AbortController();
  try {
    let answer: Awaited<ReturnType<typeof f.call>> | undefined;
    const held = f.call(abort.signal).then(result => { answer = result; });
    clock.advance(1000); await Promise.resolve();
    expect(answer).toBeUndefined();
    finish(f.dir, exit);
    clock.advance(1000);
    expect(clock.pending.size).toBe(0);
    await held;
    expect(answer?.success).toBe(true);
    expect(JSON.parse(answer!.contentItems[0].text)).toMatchObject({ terminal: true, code: exit });
    expect(clock.pending.size).toBe(0);
  } finally { abort.abort(); clock.restore(); }
});

test.each(["cancel", "watcher-error", "malformed-exit", "owner", "ticket", "directory"])("missed notifications preserve the %s refusal and release the wait", async fault => {
  const f = fixture(), clock = missedNotifications(f.dir), abort = new AbortController();
  try {
    const held = f.call(abort.signal);
    const close = spyOn(clock.watcher, "close");
    try {
      if (fault === "cancel") abort.abort();
      if (fault === "watcher-error") clock.watcher.emit("error", new Error("fixture watcher failed"));
      if (fault === "directory") {
        fs.renameSync(f.dir, `${f.dir}.retained`);
        fs.mkdirSync(f.dir);
        for (const file of ["owner.json", "completion.json"]) fs.copyFileSync(path.join(`${f.dir}.retained`, file), path.join(f.dir, file));
      }
      if (fault === "owner") fs.writeFileSync(path.join(f.dir, "owner.json"), JSON.stringify({ ...cpuOwnerIdentity(process.pid), startIdentity: "changed" }));
      if (fault === "ticket") fs.writeFileSync(path.join(f.dir, "completion.json"), "{}");
      finish(f.dir, 0);
      if (fault === "malformed-exit") fs.writeFileSync(path.join(f.dir, "exit"), "partial");
      clock.advance(1000);
      expect(clock.pending.size).toBe(0);
      const answer = await held;
      expect(answer.success).toBe(false);
      expect(answer.contentItems[0].text).toContain(fault === "cancel" ? "cancelled"
        : fault === "watcher-error" ? "fixture watcher failed"
        : fault === "malformed-exit" ? "invalid gate exit record" : "identity changed");
      expect(close).toHaveBeenCalledTimes(1);
      clock.notify();
      clock.advance(1000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(clock.pending.size).toBe(0);
    } finally { close.mockRestore(); }
  } finally { abort.abort(); clock.restore(); }
});

test("completion notifications still settle immediately and cancel recovery", async () => {
  const f = fixture(), clock = missedNotifications(f.dir), abort = new AbortController();
  try {
    const held = f.call(abort.signal);
    finish(f.dir, 0);
    clock.notify();
    expect(clock.pending.size).toBe(0);
    expect((await held).success).toBe(true);
  } finally { abort.abort(); clock.restore(); }
});

test("recovery reads no output before completion and keeps the original deadline through progress", async () => {
  const f = fixture(), clock = missedNotifications(f.dir), abort = new AbortController();
  const open = spyOn(fs, "openSync");
  try {
    const held = f.call(abort.signal);
    clock.advance(30_000);
    fs.appendFileSync(f.log, "progress\n");
    clock.advance(30_000);
    expect(open.mock.calls.filter(args => args[0] === f.log)).toHaveLength(0);
    // The fixture pins 60 seconds plus the recorder's 65-second cleanup bound.
    clock.advance(65_000);
    expect(clock.pending.size).toBe(0);
    const answer = await held;
    expect(JSON.parse(answer.contentItems[0].text)).toMatchObject({ terminal: false, code: 124 });
    expect(open.mock.calls.filter(args => args[0] === f.log)).toHaveLength(1);
    expect(fs.existsSync(path.join(f.dir, "exit"))).toBe(false);
  } finally { abort.abort(); open.mockRestore(); clock.restore(); }
});

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
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
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
    expect(scheduled).toBe(1000);
    now = minutes * 60_000 + 65_000;
    expire();
    const result = await held;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ terminal: false, code: 124 });
    expect(fs.existsSync(path.join(f.dir, "exit"))).toBe(false);
  } finally { clearTimeout(ownedTimer); timer.mockRestore(); clock.mockRestore(); }
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
  expect((await runGateCheckTool(args, f.binding, new AbortController().signal)).success).toBe(false);
  fs.symlinkSync(other.root, path.join(f.root, "indirect"), "dir");
  expect((await runGateCheckTool({ ...args, log: path.join(f.root, "indirect/check.log") }, f.binding, new AbortController().signal)).success).toBe(false);
  expect((await runGateCheckTool({ log: f.log }, f.binding, new AbortController().signal)).success).toBe(false);
});

test("a temporary-root alias retains its physical ownership", async () => {
  const f = fixture(), alias = fixture(); finish(f.dir, 0);
  const link = path.join(alias.root, "temporary-root"); fs.symlinkSync(f.root, link, "dir");
  expect((await runGateCheckTool({ log: path.join(link, "check.log"), reason: "aliased root" }, bindGateCheckRoot(link), new AbortController().signal)).success).toBe(true);
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
  const result = await runGateCheckTool({ log, reason: "owned check" }, bindGateCheckRoot(root), new AbortController().signal);
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
  const result = await runGateCheckTool({ log, reason: "foreign check" }, bindGateCheckRoot(root), new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.contentItems[0].text).toContain(`root=${JSON.stringify(root)}`);
  expect(result.contentItems[0].text).toContain(`log=${JSON.stringify(log)}`);
  const owned = shape === "prefix" ? log : other.log;
  expect((await runGateCheckTool({ log: owned, reason: "owner control" }, bindGateCheckRoot(path.dirname(owned)), new AbortController().signal)).success).toBe(true);
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
  const result = await runGateCheckTool({ log, reason: "missing path" }, bindGateCheckRoot(root), new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.contentItems[0].text).toContain(`root=${missing === "root" ? "null" : JSON.stringify(root)}`);
  expect(result.contentItems[0].text).toContain(`log=${JSON.stringify(log)}`);
});

for (const shape of ["symlink", "directory", "alias", "moved-root-link"] as const) test(`a bound root replaced by ${shape} refuses before reading a recording`, async () => {
  const f = fixture(), foreign = fixture(); finish(f.dir, 0); finish(foreign.dir, 0);
  let root = f.root;
  if (shape === "alias") {
    root = path.join(foreign.root, "stage-alias");
    fs.symlinkSync(f.root, root, "dir");
  }
  const binding = bindGateCheckRoot(root);
  const args = { log: path.join(root, "check.log"), reason: "bound check" };
  const wait = spyOn(gateWait, "waitForGateCompletion");
  try {
    expect((await runGateCheckTool(args, binding, new AbortController().signal)).success).toBe(true);
    expect(wait).toHaveBeenCalledTimes(1);
    wait.mockClear();
    if (shape === "alias") fs.unlinkSync(root);
    else { fs.renameSync(root, `${root}.retained`); roots.push(`${root}.retained`); }
    if (shape === "directory") fs.renameSync(foreign.root, root);
    else fs.symlinkSync(shape === "moved-root-link" ? `${root}.retained` : foreign.root, root, "dir");
    const answer = await runGateCheckTool(args, binding, new AbortController().signal);
    expect(answer.success).toBe(false);
    expect(answer.contentItems[0].text).toContain("root identity changed");
    expect(wait).not.toHaveBeenCalled();
  } finally { wait.mockRestore(); }
});

test("a root replaced after the asynchronous wait refuses the result", async () => {
  const f = fixture(); finish(f.dir, 0);
  const original = gateWait.waitForGateCompletion;
  const wait = spyOn(gateWait, "waitForGateCompletion").mockImplementation(async (...args) => {
    const result = await original(...args);
    fs.renameSync(f.root, `${f.root}.retained`); roots.push(`${f.root}.retained`);
    fs.mkdirSync(f.root);
    return result;
  });
  try {
    const answer = await f.call();
    expect(answer.success).toBe(false);
    expect(answer.contentItems[0].text).toContain("root identity changed");
  } finally { wait.mockRestore(); }
});
