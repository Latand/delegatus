import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { signalFixtureIdentity, stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { tryLockFenceExclusive } from "../src/runtime-host/fenceLock";
import { createPublicationFixtures } from "./publicationHook.fixture";

const root = path.resolve(import.meta.dir, "..");
const systemctl = (...args: string[]) => Bun.spawnSync(["systemctl", "--user", ...args], {
  stdout: "pipe", stderr: "pipe", timeout: 5_000,
});
const managed = process.platform === "linux" && systemctl("show-environment").exitCode === 0
  && (() => {
    const uid = process.getuid?.();
    try {
      return fs.readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, "utf8").split(/\s+/).includes("cpu");
    } catch { return false; }
  })();
const groupOf = (pid: number) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
const terminal = (identity: ReturnType<typeof captureProcessIdentity>) => processIdentityStatus(identity) === "dead";

async function until<T>(read: () => T | undefined, reason: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await Bun.sleep(25);
  }
  throw new Error(reason);
}

function member(pid: number, group: string, match: (argv: string[]) => boolean) {
  const members = fs.readFileSync(path.join("/sys/fs/cgroup", group, "cgroup.procs"), "utf8").trim().split("\n");
  for (const entry of members) {
    const id = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${id}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== pid) continue;
      const argv = fs.readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0");
      if (match(argv)) return { identity: captureProcessIdentity(id), argv };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

test.skipIf(!managed).each([
  ["off", "viewer exit"], ["auto", "viewer exit"], ["off", "cancellation"],
] as const)("publication client lifetime with CPU placement %s and %s", async (mode, ending) => {
  const roots: string[] = [];
  const f = createPublicationFixtures(root, roots);
  const fixture = f.fixture();
  const { dir, env, receipt } = fixture;
  const config = path.join(dir, ".git");
  const release = path.join(config, "release-check");
  const ready = path.join(config, "check-ready");
  const outer = path.join(config, "publication-pid");
  const outcome = path.join(config, "publication-outcome");
  const controller = path.join(config, "viewer.ts");
  const scopeFile = path.join(config, "publication-scope");
  const locks = ["publication-lock", "publication-run-lock"].map(name => path.join(config, name));
  const availableFences = () => locks.map(filename => {
    const fd = fs.openSync(filename, "r");
    try {
      const held = tryLockFenceExclusive({ fd, filename });
      held?.release();
      return !!held;
    } finally { fs.closeSync(fd); }
  });
  const unit = `delegatus-publication-test-${randomUUID()}.service`;
  const slice = `llvpublicationtest${randomUUID().slice(0, 8)}.slice`;
  const viewerEnv: Partial<NodeJS.ProcessEnv> = {
    // A fresh Viewer has its own inputs and no outer runner's receipt or slot.
    ...Object.fromEntries(Object.entries(env).filter(([name]) => /^(?:HOOK_.+|LLV_GATE_PUBLICATION_.+|LLV_GATE_(?:BUN|CHECK_ENV|CHECK_ADMISSION_FILE|EXECUTION|LOCK_DIR|PUSH_HEAD)|PATH|HOME|XDG_CONFIG_HOME|TMPDIR|LLV_STATE_DIR|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(name))),
    DELEGATUS_AGENT_CPU: mode, DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_SLICE: slice, LLV_GATE_RUNNER: "off",
    XDG_CACHE_HOME: path.join(config, "cache"), LLV_OWNED_RUN_TIMEOUT_MS: "25000", PUBLICATION_PID_FILE: outer,
  };
  // Freeze a check inside the admitted gate. The bootstrap, runner and wait
  // client must all be present when the Viewer stops.
  fs.appendFileSync(path.join(dir, "record.ts"), `
if (process.argv[2] === "tsc") {
  const fs = await import("node:fs");
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  const until = Date.now() + 20000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) await Bun.sleep(25);
  if (!fs.existsSync(${JSON.stringify(release)})) process.exit(19);
}
`);
  const shim = path.join(dir, "shims", "bun");
  fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replace("#!/bin/bash\n", () =>
    '#!/bin/bash\nif [[ "${3:-}" == --publication-prepare && -z "${LLV_GATE_SANDBOX_RECORD:-}" ]]; then printf "%s" "$$" > "$PUBLICATION_PID_FILE"; fi\n'));
  f.commitFixtureInputs(fixture);
  viewerEnv.LLV_GATE_PUSH_HEAD = fixture.head;
  for (const name of Object.keys(env)) delete env[name];
  Object.assign(env, viewerEnv);
  fs.writeFileSync(controller, `
import fs from "node:fs";
const env = ${JSON.stringify(viewerEnv)};
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);
process.env.LLV_STATE_OWNER = "viewer";
const { setCpuPortsForTests, wrapPublicationCommand } = await import(${JSON.stringify(path.join(root, "src/lib/runtime/cpuPlacement.ts"))});
const { realExec } = await import(${JSON.stringify(path.join(root, "src/lib/workflows/provision.ts"))});
const { tryLockFenceExclusive } = await import(${JSON.stringify(path.join(root, "src/runtime-host/fenceLock.ts"))});
setCpuPortsForTests({ probe: () => ({ kind: "available", systemdVersion: Number(Bun.spawnSync(["systemd-run", "--version"]).stdout.toString().split(" ")[1]) }), workSlice: ${JSON.stringify(slice)}, runner: () => "" });
process.on("SIGTERM", () => process.exit(0));
const abort = new AbortController();
process.on("SIGUSR2", () => abort.abort());
const args = ["scripts/local-gate.ts", "pre-push", "--publication-prepare"];
const launch = await wrapPublicationCommand("bun", args, "publish-checks");
const scope = launch.command === "systemd-run" ? launch.args.find(arg => arg.startsWith("--unit="))?.slice(7) : undefined;
if (scope) fs.writeFileSync(${JSON.stringify(scopeFile)}, scope);
const locks = ${JSON.stringify(locks)}.map(filename => {
  const fd = fs.openSync(filename, "w");
  if (!tryLockFenceExclusive({ fd, filename })) throw new Error("fixture could not hold both publication fences");
  return fd;
});
const result = await realExec(launch.command, launch.args, process.cwd(), { ...env, LLV_STATE_OWNER: undefined },
  { signal: abort.signal, timeoutMs: 30000, inheritFd: locks[0], additionalInheritedFds: [locks[1]] });
fs.writeFileSync(${JSON.stringify(outcome)}, JSON.stringify(result));
process.exit(result.code ?? 1);
`);
  const viewer = Bun.spawn(["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    "-p", "KillMode=process", "-p", "RuntimeMaxSec=35s", `--working-directory=${dir}`, "--", process.execPath, controller],
    { stdout: "ignore", stderr: "pipe" });
  const waitOwner = captureProcessIdentity(viewer.pid);
  const stderr = new Response(viewer.stderr).text();
  const clients: ReturnType<typeof captureProcessIdentity>[] = [];
  let group: string | undefined, gateUnit: string | undefined;
  try {
    const servicePid = await until(() => {
      const pid = Number(systemctl("show", unit, "-p", "MainPID", "--value").stdout.toString().trim());
      return pid > 0 ? pid : undefined;
    }, "Viewer fixture did not start");
    const oldGroup = groupOf(servicePid);
    const viewerIdentity = captureProcessIdentity(servicePid);
    const pid = await until(() => {
      if (fs.existsSync(outcome)) throw new Error(fs.readFileSync(outcome, "utf8"));
      const found = fs.existsSync(outer) ? fs.readFileSync(outer, "utf8") : "";
      if (found && !/^\d+$/.test(found)) throw new Error("invalid publication preparation PID");
      return found ? Number(found) : undefined;
    }, "publication preparation did not start");
    group = groupOf(pid);
    clients.push(captureProcessIdentity(pid));
    const supervisor = await until(() => member(pid, group!, argv => argv.some(arg => arg.endsWith("/owned-runner.ts"))), "owned runner did not start");
    clients.push(supervisor.identity);
    const wait = await until(() => member(supervisor.identity.pid, group!, argv => argv[0]?.endsWith("systemd-run") === true && argv.includes("--wait")), "systemd-run wait client did not start");
    clients.push(wait.identity);
    gateUnit = wait.argv.find(arg => arg.startsWith("--unit="))?.slice(7);
    expect(gateUnit).toMatch(/^delegatus-gate-[\da-f-]+\.service$/);
    await until(() => {
      if (fs.existsSync(outcome)) throw new Error(fs.readFileSync(outcome, "utf8"));
      return fs.existsSync(ready) ? true : undefined;
    }, "publication check did not reach its barrier");
    const gatePid = Number(systemctl("show", gateUnit!, "-p", "MainPID", "--value").stdout.toString().trim());
    expect(gatePid).toBeGreaterThan(0);
    const gate = captureProcessIdentity(gatePid);
    const gateGroup = groupOf(gatePid);
    expect(gateGroup).not.toBe(group);
    const cpuMax = fs.readFileSync(path.join("/sys/fs/cgroup", group, "cpu.max"), "utf8").trim();
    expect(cpuMax).toMatch(mode === "auto" ? /^60000 20000$/ : /^max /);
    console.log(JSON.stringify({ mode, ending, viewer: { ...viewerIdentity, group: oldGroup }, clients, publicationGroup: group, cpuMax, gate: { ...gate, group: gateGroup, unit: gateUnit } }));

    if (ending === "cancellation") {
      expect(signalFixtureIdentity(viewerIdentity, "SIGUSR2")).toBeTrue();
      expect(await viewer.exited, await stderr).toBe(1);
      expect(JSON.parse(fs.readFileSync(outcome, "utf8"))).toMatchObject({ code: null, signal: "SIGKILL", stderr: expect.stringContaining("command cancelled") });
      await until(() => [...clients, gate].every(terminal) ? true : undefined, "publication clients or the gate survived cancellation");
      expect(availableFences()).toEqual([true, true]);
      expect(fs.existsSync(receipt)).toBeFalse();
      console.log(JSON.stringify({ mode, ending, clientsExited: clients.map(terminal), checkReceipt: false }));
      return;
    }

    expect(systemctl("stop", unit).exitCode).toBe(0);
    expect(await viewer.exited, await stderr).toBe(0);
    const verifier = Bun.spawnSync(["python3", "-B", "-c", `
import pathlib, runpy, sys
ns = runpy.run_path(sys.argv[1])
checkout = object.__new__(ns["Checkout"])
checkout.cgroup_root = pathlib.Path("/sys/fs/cgroup")
checkout.unit = sys.argv[2]
checkout.command = ns["command"]
assert checkout.await_release(sys.argv[3], 2), checkout.group_state(sys.argv[3])
`, path.join(root, "scripts/deploy-checkout.py"), unit, oldGroup], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    expect(verifier.exitCode, verifier.stderr.toString()).toBe(0);
    expect(group).toMatch(/\/delegatus-work-publish-checks-.+\.scope$/);
    expect(processIdentityStatus(gate)).toBe("alive");
    for (const identity of clients) {
      expect(processIdentityStatus(identity)).toBe("alive");
      expect(groupOf(identity.pid)).toBe(group);
    }
    expect(availableFences()).toEqual([false, false]);
    expect(fs.existsSync(receipt)).toBeFalse();
    fs.writeFileSync(release, "");
    await until(() => [...clients, gate].every(terminal) ? true : undefined, "publication clients or the gate survived completion");
    expect(availableFences()).toEqual([true, true]);
    expect(fs.existsSync(receipt)).toBeTrue();
    const hook = fixture.run(false);
    expect(hook.status, hook.stderr).toBe(0);
    expect(fs.existsSync(receipt)).toBeFalse();
    console.log(JSON.stringify({ mode, viewerExit: 0, verifierExit: verifier.exitCode, clientsExited: clients.map(terminal), receiptConsumed: true }));
  } catch (error) {
    console.error("publication fixture", { group, gateUnit, status: fs.existsSync(outcome) ? fs.readFileSync(outcome, "utf8") : null });
    systemctl("stop", unit);
    console.error(await stderr);
    throw error;
  } finally {
    fs.writeFileSync(release, "");
    systemctl("stop", unit);
    if (gateUnit) systemctl("stop", gateUnit);
    const scope = fs.existsSync(scopeFile) ? fs.readFileSync(scopeFile, "utf8") : "";
    if (/^delegatus-work-publish-checks-[\da-f-]+\.scope$/.test(scope)) systemctl("stop", scope);
    await stopFixtureIdentity(waitOwner);
    await viewer.exited;
    for (const identity of clients.reverse()) await stopFixtureIdentity(identity);
    systemctl("stop", slice);
    systemctl("revert", slice);
    for (const folder of roots.reverse()) fs.rmSync(folder, { force: true, recursive: true });
  }
}, 45_000);
