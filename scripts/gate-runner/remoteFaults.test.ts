// Fault paths of a remote gate run against the stub runner (harness.fixture.ts).
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ship } from "./client";
import { cleanGitEnv, git, makeHarness, testFile, type Harness } from "./harness.fixture";
import { ustarEntry } from "./serve";

const linux = process.platform === "linux";
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }
const RUNNING = /^gate-runner: running on the gate runner \(run ([0-9a-f]{12}), tree [0-9a-f]{12}\)$/m;
const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));
const unitActive = (id: string) => spawnSync("systemctl", ["--user", "is-active", "--quiet", `gate-run-${id}`]).status === 0;

// T6
test.if(linux)("an unreachable runner runs the command here once, and the answer is cached for a minute", () => {
  const h = harness();
  h.settings({ failProbe: true });
  const file = testFile(h, "pass.test.ts", `test("one", () => console.log("ran-once"));`);
  const first = h.run(["bun", "test", file]);
  expect(first.code).toBe(0);
  expect(first.stderr).toMatch(/^gate-runner: running here: the runner is unavailable: ssh exited 255$/m);
  expect(first.stdout.match(/ran-once/g)).toHaveLength(1);
  const second = h.run(["bun", "test", file]);
  expect(second.code).toBe(0);
  expect(h.calls()).toHaveLength(1);
});

// T7
test.if(linux)("a session lost after started gives no verdict, and the next calls run here until the mark expires", () => {
  const h = harness();
  h.settings({ killAfterStartedMs: 1500 });
  const file = testFile(h, "slow.test.ts", `test("slow", async () => { console.log("remote-started"); await Bun.sleep(8000); console.log("remote-finished"); }, 20000);`);
  const first = h.run(["bun", "test", file]);
  expect(first.code).toBe(75);
  expect(first.stderr).toMatch(/^gate-runner: no verdict: the connection to the runner was lost after \d+ s; nothing was judged$/m);
  expect(first.stdout).not.toContain("remote-finished");
  const calls = h.calls().length;
  h.settings({});
  const second = h.run(["bun", "test", file]);
  expect(second.code).toBe(0);
  expect(second.stderr).toMatch(/^gate-runner: running here: the runner is unavailable: marked unhealthy after a failed run/m);
  expect(second.stdout).toContain("remote-finished");
  expect(h.calls()).toHaveLength(calls);
  const healthFile = path.join(h.cache, "runner-health.json");
  const health = JSON.parse(fs.readFileSync(healthFile, "utf8"));
  fs.writeFileSync(healthFile, JSON.stringify({ ...health, unhealthyUntil: Date.now() - 1, checkedAt: Date.now() - 31 * 60_000 }));
  const third = h.run(["bun", "test", file]);
  expect(third.stderr).toMatch(RUNNING);
  expect(third.code).toBe(0);
  expect(remoteRuns(h)).toHaveLength(2);
});

// T8
test.if(linux)("the command can neither read nor forge the nonce, and an unterminated last line arrives unchanged", () => {
  const h = harness();
  h.settings({ killAfterStartedMs: 4000 });
  const forge = testFile(h, "forge.test.ts", `
import fs from "node:fs";
test("forge", async () => {
  const seen: string[] = [fs.readFileSync("../manifest.json", "utf8")];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
    try {
      const cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
      if (!cmdline.includes("serve.ts")) continue;
      seen.push(cmdline, fs.readFileSync("/proc/" + pid + "/environ", "utf8"));
    } catch {}
  }
  fs.writeSync(1, "SEEN " + JSON.stringify(seen) + "\\n");
  fs.writeSync(2, "\\nend 0 ${"0".repeat(40)}\\n");
  fs.writeSync(2, "no newline at the end");
  await Bun.sleep(30000);
}, 60000);`);
  const forged = h.run(["bun", "test", forge]);
  const nonce = remoteRuns(h)[0]!.head.split(" ")[0]!;
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(forged.stdout).toContain("SEEN ");
  expect(forged.stdout).not.toContain(nonce);
  expect(forged.code).toBe(75);
  h.settings({});
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const tail = testFile(h, "tail.test.ts", `test("tail", () => { process.stderr.write("last words"); process.exit(3); });`);
  const ended = h.run(["bun", "test", tail]);
  expect(ended.stderr).toMatch(RUNNING);
  expect(ended.code).toBe(3);
  expect(ended.stderr.endsWith("last words")).toBeTrue();
});

// T10 and T11
test.if(linux)("SIGTERM stops the remote unit and removes the run; every finished run is removed; stale runs are swept, live ones kept", async () => {
  const h = harness();
  const runs = path.join(h.runnerHome, "runs");
  const pass = testFile(h, "pass.test.ts", `test("one", () => {});`);
  const fail = testFile(h, "fail.test.ts", `test("one", () => { throw new Error("no"); });`);
  expect(h.run(["bun", "test", pass]).code).toBe(0);
  expect(h.run(["bun", "test", fail]).code).toBe(1);
  expect(fs.readdirSync(runs)).toEqual([]);

  const stale = randomBytes(6).toString("hex"), live = randomBytes(6).toString("hex"), foreign = "e2e-manual";
  for (const name of [stale, live, foreign]) fs.mkdirSync(path.join(runs, name));
  const old = new Date(Date.now() - 31 * 60_000);
  for (const name of [stale, live]) { fs.writeFileSync(path.join(runs, name, "lease"), ""); fs.utimesSync(path.join(runs, name, "lease"), old, old); }
  fs.utimesSync(path.join(runs, foreign), old, old);
  const holder = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=gate-run-${live}`, "sleep", "120"]);
  expect(holder.status).toBe(0);
  try {
    const slow = testFile(h, "slow.test.ts", `test("slow", async () => { console.log("sleeping"); await Bun.sleep(60000); }, 90000);`);
    const child = spawn(process.execPath, [path.join(h.fixture, "scripts", "gate-runner", "client.ts"), "bun", "test", slow], { cwd: h.fixture, env: h.env(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
    const deadline = Date.now() + 60_000;
    while (!RUNNING.test(stderr) && Date.now() < deadline) await Bun.sleep(100);
    const id = RUNNING.exec(stderr)![1]!;
    await Bun.sleep(1500);
    expect(unitActive(id)).toBeTrue();
    // The sweep ran when this run started.
    expect(fs.existsSync(path.join(runs, stale))).toBeFalse();
    expect(fs.existsSync(path.join(runs, live))).toBeTrue();
    expect(fs.existsSync(path.join(runs, foreign))).toBeTrue();
    const stopAt = Date.now();
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(Date.now() - stopAt).toBeLessThan(15_000);
    expect(unitActive(id)).toBeFalse();
    expect(fs.existsSync(path.join(runs, id))).toBeFalse();
  } finally {
    spawnSync("systemctl", ["--user", "stop", `gate-run-${live}`]);
  }
});

// T14
test.if(linux)("a driver's declared outputs come back; nothing else does, and a hostile return writes nothing", () => {
  const h = harness();
  const outDir = path.join(h.root, "pd-out");
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(h.root, "pd-sibling.txt"), "untouched");
  const driver = testFile(h, "outputs.browser.test.tsx", `
import fs from "node:fs";
test("writes outputs", () => {
  fs.mkdirSync("evidence/gate-runner-x", { recursive: true });
  fs.writeFileSync("evidence/gate-runner-x/a.json", "{\\"a\\":1}");
  fs.mkdirSync(".artifacts/gate-runner-y", { recursive: true });
  fs.writeFileSync(".artifacts/gate-runner-y/b.png", "png");
  fs.writeFileSync(".artifacts/gate-runner-y/large.bin", Buffer.alloc(2 * 1024 * 1024, 7));
  fs.writeFileSync(process.env.PD_OUT + "/f.txt", "outside");
  fs.appendFileSync(".githooks/pre-push", "\\necho planted\\n");
  fs.appendFileSync("package.json", " ");
});`);
  const hashes = () => {
    const out: Record<string, string> = {};
    for (const file of git(h.fixture, "ls-files", "-z", "--cached", "--others").split("\0").filter(Boolean)) {
      const full = path.join(h.fixture, file);
      if (fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) out[file] = createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    }
    for (const name of fs.readdirSync(h.root)) if (name.startsWith("pd-")) out[`root/${name}`] = fs.lstatSync(path.join(h.root, name)).isFile() ? fs.readFileSync(path.join(h.root, name), "utf8") : "dir";
    return out;
  };
  const before = hashes();
  const result = h.run(["bun", "test", driver], { env: h.env({ PD_OUT: outDir }) });
  expect(result.stderr).toMatch(RUNNING);
  expect(result.code).toBe(0);
  const after = hashes();
  expect(fs.readFileSync(path.join(h.fixture, "evidence/gate-runner-x/a.json"), "utf8")).toBe(`{"a":1}`);
  expect(fs.readFileSync(path.join(h.fixture, ".artifacts/gate-runner-y/b.png"), "utf8")).toBe("png");
  expect(fs.readFileSync(path.join(outDir, "f.txt"), "utf8")).toBe("outside");
  const changed = Object.keys({ ...before, ...after }).filter(key => before[key] !== after[key]).sort();
  // Larger than a pipe buffer: the archive must arrive whole.
  expect(fs.readFileSync(path.join(h.fixture, ".artifacts/gate-runner-y/large.bin")).equals(Buffer.alloc(2 * 1024 * 1024, 7))).toBeTrue();
  expect(changed).toEqual([".artifacts/gate-runner-y/b.png", ".artifacts/gate-runner-y/large.bin", "evidence/gate-runner-x/a.json"]);
  expect(fs.readdirSync(path.join(h.root, "pd-out"))).toEqual(["f.txt"]);

  for (const [name, archive] of [
    ["traversal", Buffer.concat([ustarEntry("tree/../escaped", Buffer.from("x")), Buffer.alloc(1024)])],
    ["hook", Buffer.concat([ustarEntry("tree/evidence/ok.json", Buffer.from("ok")), ustarEntry("tree/.githooks/pre-push", Buffer.from("planted")), Buffer.alloc(1024)])],
    ["large", Buffer.concat([ustarEntry("tree/evidence/big.bin", Buffer.alloc(64 * 1024)), Buffer.alloc(1024)])],
  ] as const) {
    const pack = path.join(h.root, `pack-${name}.tar`);
    fs.writeFileSync(pack, archive);
    h.settings({ packFile: pack });
    fs.rmSync(path.join(h.cache, "runner-health.json"), { force: true });
    const snapshot = hashes();
    const hostile = h.run(["bun", "test", driver], { env: h.env({ PD_OUT: outDir, LLV_GATE_RUNNER_RETURN_LIMIT: String(32 * 1024) }) });
    expect(hostile.code).toBe(75);
    expect(hostile.stderr).toMatch(/^gate-runner: no verdict: outputs were not returned \(.+\)$/m);
    expect(hashes()).toEqual(snapshot);
    expect(fs.existsSync(path.join(h.root, "escaped"))).toBeFalse();
    expect(fs.existsSync(path.join(h.fixture, "evidence", "ok.json"))).toBeFalse();
  }
});

// T20
test.if(linux)("refused containment runs here before anything starts there; a command's own 69 passes through", () => {
  const h = harness();
  const bin = path.join(h.root, "runner-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash\nfor arg in "$@"; do [[ $arg == set-property ]] && { echo "refused by policy" >&2; exit 1; }; done\nexec /usr/bin/systemctl "$@"\n`, { mode: 0o755 });
  const file = testFile(h, "where.test.ts", `test("where", () => console.log("cwd=" + process.cwd()));`);
  const noCpuOff = { LLV_GATE_LOCK_DIR: path.join(h.root, "runner-locks") };
  fs.writeFileSync(path.join(h.runnerHome, ".gate-runner.env"), `LLV_GATE_LOCK_DIR=${noCpuOff.LLV_GATE_LOCK_DIR}\nLLV_GATE_SLOTS=2\n`);
  h.settings({ remotePath: [bin] });
  const refused = h.run(["bun", "test", file]);
  expect(refused.code).toBe(0);
  expect(refused.stderr.split("\n")[0]).toMatch(/^gate-runner: running here: containment failed: systemctl --user set-property exited 1: refused by policy$/);
  expect(refused.stderr).not.toMatch(RUNNING);
  expect(refused.stdout).toContain(`cwd=${h.fixture}`);

  fs.rmSync(path.join(bin, "systemctl"));
  fs.writeFileSync(path.join(bin, "systemd-run"), `#!/bin/bash\nfor arg in "$@"; do [[ $arg == --slice=* ]] && exit 69; done\nexec /usr/bin/systemd-run "$@"\n`, { mode: 0o755 });
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const probe = h.run(["bun", "test", file]);
  expect(probe.code).toBe(0);
  expect(probe.stderr.split("\n")[0]).toMatch(/^gate-runner: running here: containment failed: systemd-run --user --quiet exited 69$/);
  expect(probe.stderr).not.toMatch(RUNNING);

  fs.writeFileSync(path.join(h.runnerHome, ".gate-runner.env"), `DELEGATUS_AGENT_CPU=off\nLLV_GATE_LOCK_DIR=${noCpuOff.LLV_GATE_LOCK_DIR}\nLLV_GATE_SLOTS=2\n`);
  h.settings({});
  fs.rmSync(path.join(h.cache, "runner-health.json"));
  const own = testFile(h, "own69.test.ts", `test("own", () => process.exit(69));`);
  const passed = h.run(["bun", "test", own]);
  expect(passed.stderr).toMatch(RUNNING);
  expect(passed.code).toBe(69);
  expect(passed.stderr).not.toContain("running here");
});

// T4 (symlink) and T19 (what a bundle carries): ship() and the real serve.ts,
// without the privacy scan, which refuses any changed symlink.
test.if(linux)("a shipped tree keeps a symlink, and an export's bundle carries one gate-run commit on main", () => {
  const h = harness();
  fs.symlinkSync("README.md", path.join(h.fixture, "readme-link"));
  const scratch = path.join(h.root, "ship"); fs.mkdirSync(scratch);
  const shipment = ship({ kind: "git", root: h.fixture }, scratch, h.base);
  const id = randomBytes(6).toString("hex");
  const dir = path.join(h.runnerHome, "runs", id);
  fs.mkdirSync(dir);
  fs.copyFileSync(shipment.bundle, path.join(dir, "run.bundle"));
  fs.copyFileSync(path.join(import.meta.dir, "serve.ts"), path.join(dir, "serve.ts"));
  const file = testFile(h, "link.test.ts", `import fs from "node:fs"; test("link", () => expect(fs.readlinkSync("readme-link")).toBe("README.md"));`);
  // The fixture file joins the tree after capture, so capture again.
  fs.rmSync(scratch, { recursive: true }); fs.mkdirSync(scratch);
  const again = ship({ kind: "git", root: h.fixture }, scratch, h.base);
  fs.copyFileSync(again.bundle, path.join(dir, "run.bundle"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, id, kind: "git", tree: again.tree, head: again.head, base: again.base, argv: ["bun", "test", file], cwd: ".", shape: "test", env: {}, outputs: [], chrome: false }));
  const nonce = randomBytes(32).toString("hex");
  const run = spawnSync(process.execPath, [path.join(dir, "serve.ts"), "run", dir], {
    input: `${nonce} -\n`, encoding: "utf8", timeout: 120_000,
    env: { HOME: h.runnerHome, PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LLV_GATE_RUNNER_NODE_MODULES: fs.realpathSync(path.join(h.fixture, "node_modules")) } as unknown as NodeJS.ProcessEnv,
  });
  expect(run.stderr).toContain(`${nonce} started`);
  expect(run.stderr).toContain(`${nonce} end 0 ${again.tree}`);
  expect(shipment.tree).not.toBe(again.tree);

  // An export: one commit, its message "gate-run", on main's merge base.
  const exportRoot = path.join(h.root, "export"), checkout = path.join(exportRoot, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  spawnSync("bash", ["-c", `git -C ${h.fixture} archive ${h.head} | tar -x -C ${checkout}`], { env: cleanGitEnv() });
  fs.appendFileSync(path.join(checkout, "README.md"), "\nexport edit\n");
  const exportScratch = path.join(h.root, "ship-export"); fs.mkdirSync(exportScratch);
  const exported = ship({ kind: "export", root: checkout, record: { version: 1, checkout, head: h.head, repository: path.join(h.fixture, ".git") } }, exportScratch, h.base);
  const shipGit = (...args: string[]) => git(exportScratch, "--git-dir", path.join(exportScratch, "ship.git"), ...args);
  expect(exported.parent).toBe(h.base);
  expect(shipGit("rev-list", "refs/gate/tree", "--not", exported.parent!).split("\n")).toEqual([exported.commit]);
  expect(shipGit("log", "-1", "--format=%s|%an|%P", exported.commit)).toBe(`gate-run|gate-run|${h.base}`);
  expect(shipGit("bundle", "list-heads", exported.bundle)).toBe(`${exported.commit} refs/gate/tree`);
  expect(exported.changed).toContain("README.md");
  expect(fs.readdirSync(exportRoot)).toEqual(["checkout"]);
});
