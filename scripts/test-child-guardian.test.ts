import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

const guardian = path.join(import.meta.dir, "test-child-guardian.ts");
async function until(check: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("guardian fixture did not reach its barrier");
    await Bun.sleep(10);
  }
}

test.skipIf(process.platform !== "linux")("a restarted guardian replays the same ledger and owns its newly appended worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-replay-"));
  const ledger = path.join(root, "children.jsonl");
  fs.writeFileSync(ledger, "");
  try {
    for (const generation of [1, 2]) {
      const worker = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
      const identity = captureProcessIdentity(worker.pid!);
      fs.appendFileSync(ledger, JSON.stringify(identity) + "\n");
      fs.writeFileSync(`${ledger}.done`, "done");
      const monitor = spawn(process.execPath, [guardian, ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdio: ["ignore", "ignore", "pipe"] });
      let diagnostic = ""; monitor.stderr!.on("data", value => { diagnostic += String(value); });
      try {
        expect(await new Promise<number | null>(resolve => monitor.once("close", resolve)), `generation ${generation}: ${diagnostic}`).toBe(1);
        expect(processIdentityStatus(identity)).toBe("dead");
      } finally {
        await stopFixtureProcess(monitor); await stopFixtureProcess(worker);
        fs.rmSync(`${ledger}.done`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

for (const round of [1, 2]) for (const malformed of [false, true]) test.skipIf(process.platform !== "linux")(`guardian restart ${round} consumes appended records and retires completed history malformed=${malformed}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-append-"));
  const retired = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const retiredIdentity = captureProcessIdentity(retired.pid!);
  await stopFixtureProcess(retired);
  const worker = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const identity = captureProcessIdentity(worker.pid!);
  const ledger = path.join(root, "children.jsonl"), preload = path.join(root, "preload.ts");
  const ready = path.join(root, "ready"), observed = path.join(root, "observed"), visits = path.join(root, "visits");
  fs.writeFileSync(ledger, JSON.stringify(retiredIdentity) + "\n");
  fs.writeFileSync(preload, `import fs from "node:fs";
const exists = fs.existsSync, read = fs.readFileSync;
let ticks = 0;
fs.existsSync = function(file) {
  if (String(file) === ${JSON.stringify(`/proc/${retiredIdentity.pid}`)}) fs.appendFileSync(${JSON.stringify(visits)}, "visit\\n");
  if (String(file) === ${JSON.stringify(`${ledger}.done`)} && ++ticks === 2) fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  return exists(file);
};
fs.readFileSync = function(file, ...args) {
  if (String(file) === ${JSON.stringify(`/proc/${identity.pid}/stat`)}) fs.writeFileSync(${JSON.stringify(observed)}, "observed");
  return Reflect.apply(read, fs, [file, ...args]);
};`);
  const monitor = spawn(process.execPath, ["--preload", preload, guardian, ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = ""; monitor.stderr!.on("data", value => { diagnostic += String(value); });
  const closed = new Promise<number | null>(resolve => monitor.once("close", resolve));
  try {
    await until(() => fs.existsSync(ready));
    fs.appendFileSync(ledger, malformed ? "invalid record\n" : JSON.stringify(identity) + "\n");
    if (!malformed) {
      await until(() => fs.existsSync(observed));
      fs.writeFileSync(`${ledger}.done`, "done");
    }
    expect(await closed, diagnostic).toBe(1);
    expect(fs.readFileSync(visits, "utf8").trim().split("\n")).toHaveLength(1);
    expect(processIdentityStatus(identity)).toBe(malformed ? "alive" : "dead");
    if (malformed) {
      expect(diagnostic).toContain("SyntaxError");
      expect(fs.existsSync(`${ledger}.cleanup.json`)).toBe(false);
    }
  } finally {
    await stopFixtureProcess(monitor); await stopFixtureProcess(worker);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

for (const round of [1, 2]) test.skipIf(process.platform !== "linux" || !Bun.which("strace"))(`guardian restart ${round} discovers a worker-thread child without reading a bystander`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-tree-"));
  const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  const worker = spawn("python3", ["-I", "-c", `import os,signal,threading,time
def fork():
 pid=os.fork()
 if pid == 0:
  while True: time.sleep(300)
 print(pid,flush=True)
 os.waitpid(pid,0)
threading.Thread(target=fork).start()
signal.pause()
`], { stdio: ["ignore", "pipe", "inherit"] });
  const workerIdentity = captureProcessIdentity(worker.pid!);
  let output = ""; worker.stdout!.on("data", value => { output += String(value); });
  let child: ReturnType<typeof captureProcessIdentity> | undefined;
  let monitor: ReturnType<typeof spawn> | undefined;
  try {
    await until(() => output.includes("\n"));
    child = captureProcessIdentity(Number(output.trim()));
    const ledger = path.join(root, "children.jsonl"), trace = path.join(root, "trace");
    fs.writeFileSync(ledger, JSON.stringify(workerIdentity) + "\n");
    monitor = spawn("strace", ["-f", "-e", "trace=%file", "-P", `/proc/${other.pid}/stat`, "-P", `/proc/${child.pid}/stat`, "-o", trace,
      process.execPath, guardian, ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; monitor.stderr!.on("data", value => { diagnostic += String(value); });
    const closed = new Promise<number | null>(resolve => monitor!.once("close", resolve));
    await until(() => fs.existsSync(trace) && fs.readFileSync(trace, "utf8").split(`/proc/${child!.pid}/stat`).length > 2);
    fs.writeFileSync(`${ledger}.done`, "done");
    expect(await closed, diagnostic).toBe(1);
    await until(() => processIdentityStatus(child!) === "dead" && processIdentityStatus(workerIdentity) === "dead");
    expect(processIdentityStatus(other)).toBe("alive");
    expect(fs.readFileSync(trace, "utf8")).not.toContain(`/proc/${other.pid}/stat`);
  } finally {
    if (monitor) await stopFixtureProcess(monitor);
    await stopFixtureProcess(worker);
    if (child) signalFixtureIdentity(child, "SIGKILL");
    await stopFixtureProcess(bystander);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("an unreadable owned child snapshot refuses cleanup without a success receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-refusal-"));
  const worker = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const identity = captureProcessIdentity(worker.pid!);
  const ledger = path.join(root, "children.jsonl"), preload = path.join(root, "preload.ts");
  fs.writeFileSync(ledger, JSON.stringify(identity) + "\n");
  fs.writeFileSync(`${ledger}.done`, "done");
  fs.writeFileSync(preload, `import fs from "node:fs";
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file) === ${JSON.stringify(`/proc/${identity.pid}/task/${identity.pid}/children`)}) throw Object.assign(new Error("fixture snapshot refused"), { code: "EACCES" });
  return Reflect.apply(read, fs, [file, ...args]);
};`);
  const monitor = spawn(process.execPath, ["--preload", preload, guardian, ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = ""; monitor.stderr!.on("data", value => { diagnostic += String(value); });
  try {
    expect(await new Promise<number | null>(resolve => monitor.once("close", resolve))).toBe(1);
    expect(diagnostic).toContain("EACCES");
    expect(processIdentityStatus(identity)).toBe("alive");
    expect(fs.existsSync(`${ledger}.cleanup.json`)).toBe(false);
  } finally {
    await stopFixtureProcess(monitor); await stopFixtureProcess(worker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
