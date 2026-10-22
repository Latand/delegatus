import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../local-gate";
import { applyReturn, configFile, type Env, Demux, health, mapArguments, markUnhealthy, parseControl, parseProbe, readUstar, remoteEnvironment, resolveTarget, returnPlan, shapeOf, UNHEALTHY_MS, type Control, type Tree } from "./client";
import { envClass } from "./env-classes";
import { ISOLATED_KEYS, PERSISTENT_KEYS, ustarEntry } from "./serve";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-unit-")));
  made.push(dir);
  return dir;
}
const REPO = path.resolve(import.meta.dir, "..", "..");

test("the target comes from LLV_GATE_RUNNER, then the configured file; off and malformed values stay here", () => {
  const dir = scratch();
  const config = path.join(dir, "gate-runner.json");
  expect(resolveTarget({ LLV_GATE_RUNNER: "off", LLV_GATE_RUNNER_CONFIG: config })).toEqual({ off: "LLV_GATE_RUNNER=off" });
  expect(resolveTarget({ LLV_GATE_RUNNER: "runner-a", LLV_GATE_RUNNER_CONFIG: config })).toEqual({ alias: "runner-a" });
  expect(resolveTarget({ LLV_GATE_RUNNER_CONFIG: config })).toBeNull();
  fs.writeFileSync(config, JSON.stringify({ ssh: "runner-b" }));
  expect(resolveTarget({ LLV_GATE_RUNNER_CONFIG: config })).toEqual({ alias: "runner-b" });
  fs.writeFileSync(config, JSON.stringify({ ssh: "-oProxyCommand=x" }));
  expect(resolveTarget({ LLV_GATE_RUNNER_CONFIG: config })).toHaveProperty("off");
  expect(resolveTarget({ LLV_GATE_RUNNER: "a b" })).toHaveProperty("off");
});

// T23: an agent's private HOME and XDG_CONFIG_HOME must not hide the file.
test("the client and the wrapper both look for the runner file under the passwd home", () => {
  const dir = scratch();
  const passwd = spawnSync("getent", ["passwd", String(process.getuid!())], { encoding: "utf8" }).stdout.split(":")[5]!;
  const probe = spawnSync(process.execPath, ["-e", `import("${path.join(import.meta.dir, "client.ts")}").then(m => process.stdout.write(m.configFile({})))`], {
    env: { PATH: process.env.PATH, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") } as unknown as NodeJS.ProcessEnv, encoding: "utf8",
  });
  expect(probe.stdout).toBe(path.join(passwd, ".config", "delegatus", "gate-runner.json"));
  expect(configFile({ LLV_GATE_RUNNER_CONFIG: "/x.json" })).toBe("/x.json");

  // The wrapper's branch: a stub getent names a passwd home that holds the
  // file, while HOME names another that does not; and the reverse.
  const bin = path.join(dir, "bin"), passwdHome = path.join(dir, "passwd-home"), home = path.join(dir, "home");
  fs.mkdirSync(bin); fs.mkdirSync(path.join(passwdHome, ".config", "delegatus"), { recursive: true }); fs.mkdirSync(path.join(home, ".config", "delegatus"), { recursive: true });
  fs.writeFileSync(path.join(bin, "getent"), `#!/bin/sh\necho "user:x:1:1::${passwdHome}:/bin/sh"\n`, { mode: 0o755 });
  const marker = path.join(dir, "client-started");
  // A stand-in Bun: the reuse probe answers "no inherited slot", the client
  // records that it started and decides "here", and the local run is a no-op.
  fs.writeFileSync(path.join(bin, "fake-bun"), `#!/bin/bash\ncase "$1" in\n  */cpu-admission.ts) exit 75 ;;\n  */gate-runner/client.ts) echo started > ${marker}; echo here > "$LLV_GATE_RUNNER_DECISION"; exit 0 ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
  const wrapper = path.join(REPO, "scripts", "gate-slot.sh");
  const run = () => spawnSync("/bin/bash", [wrapper, "/bin/true"], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LLV_GATE_BUN: path.join(bin, "fake-bun"), DELEGATUS_AGENT_CPU: "off", LLV_GATE_LOCK_DIR: dir, LLV_GATE_POLL_SECONDS: "0" } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8", timeout: 20_000,
  });
  fs.writeFileSync(path.join(home, ".config", "delegatus", "gate-runner.json"), "{}");
  run();
  expect(fs.existsSync(marker)).toBeFalse();
  fs.writeFileSync(path.join(passwdHome, ".config", "delegatus", "gate-runner.json"), "{}");
  run();
  expect(fs.readFileSync(marker, "utf8")).toBe("started\n");
});

function gitTree(): Tree { return { kind: "git", root: REPO }; }
function exportTree(): Tree { return { kind: "export", root: REPO, record: { version: 1, checkout: REPO, head: "0".repeat(40), repository: "/r" } }; }

test("only the declared command shapes go remote, and an export takes only the history-free ones", () => {
  const git = gitTree(), exported = exportTree();
  const shape = (argv: string[], tree = git, env: Env = {}) => shapeOf(argv, tree, REPO, env);
  expect(shape(["/opt/bun", "scripts/local-gate.ts", "pre-push", "--admitted"])).toMatchObject({ name: "pre-push" });
  expect(shape(["bun", "scripts/local-gate.ts", "pre-push"])).toHaveProperty("reason");
  expect(shape(["bun", "test", "src/x.test.ts"])).toMatchObject({ name: "test", driver: false });
  expect(shape(["bun", "test", "src/components/kanban/kanbanBoard.browser.test.tsx"])).toMatchObject({ name: "test", driver: true });
  expect(shape(["bun", "run", "test", "src/x.test.ts"])).toMatchObject({ name: "test" });
  expect(shape(["bunx", "tsc", "--noEmit"])).toMatchObject({ name: "tsc" });
  expect(shape(["bun", "scripts/local-gate-tests.ts", "a.test.ts"])).toMatchObject({ name: "local-gate-tests" });
  expect(shape(["bun", "scripts/eslint-changes.ts"])).toMatchObject({ name: "eslint-changes" });
  expect(shape(["bun", "run", "build"])).toHaveProperty("reason");
  expect(shape(["node", "test"])).toHaveProperty("reason");
  expect(shape(["bun", "scripts/capture-board-geometry.ts"])).toHaveProperty("reason");
  expect(shape(["bun", "scripts/capture-board-geometry.ts"], git, { BOARD_CAPTURE_DIR: path.join(REPO, "evidence") })).toHaveProperty("reason");
  expect(shape(["bun", "scripts/capture-board-geometry.ts"], git, { BOARD_CAPTURE_DIR: os.tmpdir() })).toMatchObject({ name: "board-geometry", driver: true });
  expect(shape(["bun", "scripts/local-gate.ts", "pre-push", "--admitted"], exported)).toHaveProperty("reason");
  expect(shape(["bun", "scripts/local-gate-tests.ts"], exported)).toHaveProperty("reason");
  expect(shape(["bun", "test", "src/x.test.ts"], exported)).toMatchObject({ name: "test" });
  expect(shape(["bunx", "tsc"], exported)).toMatchObject({ name: "tsc" });
});

// T21 (manifest side): absolute in-tree paths travel relative to the working directory.
test("absolute in-tree arguments become relative; anything leaving the tree runs here", () => {
  const cwd = path.join(REPO, "src");
  expect(mapArguments(["/opt/tools/bun", "test", path.join(REPO, "src/x.test.ts"), "--timeout=600"], REPO, cwd)).toEqual(["bun", "test", "./x.test.ts", "--timeout=600"]);
  expect(mapArguments(["bunx", "tsc", `--project=${path.join(REPO, "tsconfig.json")}`], REPO, cwd)).toEqual(["bunx", "tsc", "--project=../tsconfig.json"]);
  expect(mapArguments(["bun", "test", REPO], REPO, cwd)).toEqual(["bun", "test", ".."]);
  expect(mapArguments(["bun", "test", "/etc/passwd"], REPO, cwd)).toHaveProperty("reason");
  expect(mapArguments(["bun", "test", "../../outside.test.ts"], REPO, cwd)).toHaveProperty("reason");
  expect(mapArguments(["bun", "test", "../scripts/a.test.ts"], REPO, cwd)).toEqual(["bun", "test", "../scripts/a.test.ts"]);
});

// T12 (selection side) and the output map.
test("only classified variables travel; credentials and local paths never do", () => {
  const out = scratch();
  const result = remoteEnvironment({
    GH_TOKEN: "t", LLV_TOKEN: "t", OPENROUTER_API_KEY: "k", LLV_PRIVACY_KNOWN_VALUES_FILE: "/secret", HOME: "/srv/x", SOME_UNKNOWN: "1",
    LLV_KANBAN_BROWSER_TEST: "1", NODE_OPTIONS: "--max-old-space-size=6144", PD_OUT: out, LLV_REPORTS_OUT: ".artifacts/r",
    BOARD_POLL_BASE_FILE: path.join(REPO, "fixtures", "x.json"),
  }, REPO, REPO);
  expect(result).toEqual({
    env: { LLV_KANBAN_BROWSER_TEST: "1", NODE_OPTIONS: "--max-old-space-size=6144", LLV_REPORTS_OUT: ".artifacts/r", BOARD_POLL_BASE_FILE: "./fixtures/x.json" },
    outputs: { PD_OUT: out },
  });
  expect(remoteEnvironment({ OVERVIEW_BASELINE_BUNDLE: "/var/tmp/bundle.js" }, REPO, REPO)).toHaveProperty("reason");
  expect(remoteEnvironment({ KANBAN_PROTOTYPE_URL: "http://127.0.0.1:3000" }, REPO, REPO)).toHaveProperty("reason");
  expect(remoteEnvironment({ LLV_HISTORY_BASE: "/abs/outside" }, REPO, REPO)).toHaveProperty("reason");
});

// T13: every variable the drivers and the local gate read has a class.
test("every environment variable the four drivers and scripts/local-gate*.ts read is classified", () => {
  const sources = [
    "src/components/kanban/kanbanBoard.browser.test.tsx", "src/components/mobile/issue1671Evidence.browser.test.tsx",
    "src/components/conversation/conversationWindow.browser.test.tsx", "scripts/capture-board-geometry.ts",
    ...fs.readdirSync(path.join(REPO, "scripts")).filter(name => /^local-gate.*\.ts$/.test(name) && !name.includes(".test.")).map(name => `scripts/${name}`),
  ];
  const names = new Set<string>();
  for (const file of sources) for (const match of fs.readFileSync(path.join(REPO, file), "utf8").matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\["([A-Z_][A-Z0-9_]*)"\])/g)) names.add(match[1] ?? match[2]!);
  expect(names.size).toBeGreaterThan(100);
  expect([...names].filter(name => !envClass(name)).sort()).toEqual([]);
});

// T18: the runner gives every key the local gate isolates a fresh or a persistent directory.
test("serve.ts isolates every key isolatedEnvironment replaces", () => {
  const dir = scratch();
  const isolated = isolatedEnvironment(dir, {} as NodeJS.ProcessEnv);
  const replaced = Object.keys(isolated).filter(key => isolated[key]?.startsWith(dir) && key !== "CLAUDE_CODE_TMPDIR");
  expect(replaced.length).toBeGreaterThan(8);
  expect(replaced.filter(key => !ISOLATED_KEYS.includes(key) && !PERSISTENT_KEYS.includes(key))).toEqual([]);
  // T17: an isolated check never goes remote.
  expect(isolated.LLV_GATE_RUNNER).toBe("off");
});

// T8 (stream side).
test("control records are removed with their leading newline, across chunk boundaries, and a forged record without the nonce passes through", () => {
  const nonce = "a".repeat(64);
  const out: Buffer[] = [], records: (Control | null)[] = [];
  const demux = new Demux(nonce, bytes => out.push(Buffer.from(bytes)), record => records.push(record));
  const stream = Buffer.from(`\n${nonce} started\nline one\nend 0 ${"b".repeat(40)}\npartial without newline\n${nonce} end 3 ${"c".repeat(40)}\n`);
  for (let index = 0; index < stream.length; index += 7) demux.push(stream.subarray(index, index + 7));
  demux.end();
  expect(Buffer.concat(out).toString()).toBe(`line one\nend 0 ${"b".repeat(40)}\npartial without newline`);
  expect(records).toEqual([{ kind: "started" }, { kind: "end", code: 3, tree: "c".repeat(40) }]);
  expect(parseControl("setup-failed tree check the runner checked out tree x for y")).toEqual({ kind: "setup-failed", step: "tree check", detail: "the runner checked out tree x for y" });
  expect(parseControl("setup-failed containment systemctl exited 1")).toEqual({ kind: "setup-failed", step: "containment", detail: "systemctl exited 1" });
});

// T14 (archive side).
test("a returned archive is refused whole unless every entry is a regular file under an output root", () => {
  const root = scratch(), out = scratch();
  const regular = (name: string) => ustarEntry(name, Buffer.from(name));
  const end = Buffer.alloc(1024);
  // An entry of another type with a valid checksum.
  const typed = (name: string, type: string) => {
    const entry = Buffer.from(ustarEntry(name, Buffer.alloc(0)));
    entry[156] = type.charCodeAt(0);
    entry.fill(" ", 148, 156);
    let sum = 0; for (let index = 0; index < 512; index++) sum += entry[index]!;
    entry.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return entry;
  };
  const good = Buffer.concat([regular("tree/evidence/x/a.json"), regular("tree/.artifacts/y/b.png"), regular("out/PD_OUT/f.txt"), end]);
  const plan = returnPlan(readUstar(good), root, { PD_OUT: out });
  applyReturn(plan);
  expect(fs.readFileSync(path.join(root, "evidence/x/a.json"), "utf8")).toBe("tree/evidence/x/a.json");
  expect(fs.readFileSync(path.join(out, "f.txt"), "utf8")).toBe("out/PD_OUT/f.txt");
  for (const hostile of [
    Buffer.concat([regular("tree/../x"), end]),
    Buffer.concat([regular("/etc/x"), end]),
    Buffer.concat([typed("tree/evidence/l", "2"), regular("tree/evidence/l/f"), end]),
    Buffer.concat([typed("tree/evidence/h", "1"), end]),
    Buffer.concat([typed("tree/evidence/d", "5"), end]),
    Buffer.concat([typed("tree/evidence/p", "x"), end]),
    Buffer.concat([regular("tree/scripts/gate-slot.sh"), end]),
    Buffer.concat([regular("tree/.githooks/pre-push"), end]),
    Buffer.concat([regular("out/OTHER/f"), end]),
    Buffer.concat([regular("tree/evidence/../../x"), end]),
  ]) expect(() => returnPlan(readUstar(hostile), root, { PD_OUT: out })).toThrow();
  const corrupt = Buffer.from(regular("tree/evidence/h")); corrupt[156] = "1".charCodeAt(0);
  expect(() => readUstar(Buffer.concat([corrupt, end]))).toThrow("checksum");
  expect(() => readUstar(Buffer.concat([typed("tree/evidence/h", "1"), end]))).toThrow("not a regular file");
  // A local symlink on the way is refused before anything is written.
  fs.symlinkSync("/", path.join(root, "evidence", "escape"));
  expect(() => returnPlan(readUstar(Buffer.concat([regular("tree/evidence/escape/f"), end])), root, {})).toThrow("other than a directory");
});

// T6/T7 (cache side).
test("a probe answer is cached for a minute, and a failed run keeps every caller here for 30 minutes", () => {
  const cache = scratch();
  const ssh = path.join(cache, "ssh"), calls = path.join(cache, "calls");
  fs.writeFileSync(ssh, `#!/bin/sh\necho x >> ${calls}\necho "bun=${Bun.version}"; echo disk=99999999; echo manager=ok; echo main=${"a".repeat(40)}; echo runs=0\n`, { mode: 0o755 });
  const env = { LLV_GATE_RUNNER_CACHE: cache, LLV_GATE_RUNNER_SSH: ssh };
  const count = () => fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
  const now = 1_800_000_000_000;
  expect(health(env, "r", now)).toMatchObject({ healthy: true, main: "a".repeat(40) });
  expect(health(env, "r", now + 30_000)).toMatchObject({ healthy: true });
  expect(count()).toBe(1);
  expect(health(env, "r", now + 61_000)).toMatchObject({ healthy: true });
  expect(count()).toBe(2);
  markUnhealthy(env, "a run lost its verdict", now + 62_000);
  expect(health(env, "r", now + 62_000 + 15 * 60_000 + 1)).toMatchObject({ healthy: false });
  expect(count()).toBe(2);
  expect(health(env, "r", now + 62_000 + UNHEALTHY_MS + 1)).toMatchObject({ healthy: true });
  expect(count()).toBe(3);
  expect(parseProbe(`bun=0.0.1\ndisk=1\nmain=\n`, "1.4.0")).toMatchObject({ healthy: false });
});

// T22
test("provision.sh derives slots from the smaller of the CPU and memory bounds", () => {
  const settings = (cpus: number, kb: number) => spawnSync("/bin/bash", [path.join(import.meta.dir, "provision.sh"), "--print-settings"], {
    env: { PATH: process.env.PATH, LLV_PROVISION_CPUS: String(cpus), LLV_PROVISION_MEMTOTAL_KB: String(kb) } as unknown as NodeJS.ProcessEnv, encoding: "utf8",
  }).stdout;
  expect(settings(16, 32_083_512)).toBe(`LLV_GATE_SLOTS=3\nMemoryHigh=${32_083_512 - 4 * 1024 * 1024}K\n`);
  expect(settings(32, 128 * 1024 * 1024)).toBe(`LLV_GATE_SLOTS=8\nMemoryHigh=${124 * 1024 * 1024}K\n`);
  expect(settings(4, 8 * 1024 * 1024)).toBe(`LLV_GATE_SLOTS=1\nMemoryHigh=${4 * 1024 * 1024}K\n`);
});
