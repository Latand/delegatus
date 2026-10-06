import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll } from "bun:test";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { stopFixtureProcess } from "./fixtureProcess";

/** The preload owns real subprocess handles before spawn returns. This covers
 * imported aliases, fork/execFile and product helpers exercised by a test, too.
 * A separate guardian retains the identities if the test runner is SIGKILLed.
 */
export function beginTestChildOwnership(root: string): void {
  const owner = captureProcessIdentity(process.pid);
  const supervisor = captureProcessIdentity(process.ppid);
  const cgroup = process.platform === "linux" ? process.env.LLV_OWNED_TEST_RUN_CGROUP : undefined;
  if (cgroup && (Number(process.env.LLV_OWNED_TEST_RUNNER_PID) !== process.pid
    || !fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").includes(`0::${cgroup}`))) {
    throw new Error("test cleanup has no verified owning cgroup");
  }
  const scopeChildren = () => cgroup
    ? fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number)
      .filter(pid => pid > 0 && pid !== owner.pid && !(pid === supervisor.pid && processIdentityStatus(supervisor) === "alive") && !procBackend.processExited(pid))
    : [];
  const ledger = path.join(root, "owned-test-children.jsonl");
  fs.writeFileSync(ledger, "", { mode: 0o600 });
  const rawBunSpawn = Bun.spawn;
  // Linux already owns the complete tree in the test's private service. The
  // portable guardian is a fallback, rather than a second polling supervisor.
  const guardian = process.platform === "linux" ? null : rawBunSpawn([process.execPath, path.resolve(import.meta.dir, "../../../scripts/test-child-guardian.ts"), ledger, JSON.stringify(owner)], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  guardian?.unref();
  const nodeChildren = new Map<ChildProcess, ProcessIdentity>();
  const bunChildren = new Map<ReturnType<typeof Bun.spawn>, ProcessIdentity>();
  const record = (pid: number) => {
    const identity = captureProcessIdentity(pid);
    if (identity.startIdentity && identity.bootEpoch) fs.appendFileSync(ledger, `${JSON.stringify(identity)}\n`);
    return identity;
  };
  const prototype = ChildProcess.prototype as ChildProcess & { spawn(...args: unknown[]): unknown };
  const rawNodeSpawn = prototype.spawn;
  prototype.spawn = function (...args: unknown[]) {
    const options = args[0] as { envPairs?: string[] };
    if (options.envPairs && !options.envPairs.some(pair => pair.startsWith("LLV_FIXTURE_PARENT_IDENTITY="))) {
      options.envPairs = [...options.envPairs, `LLV_FIXTURE_PARENT_IDENTITY=${JSON.stringify(owner)}`];
    }
    const result = Reflect.apply(rawNodeSpawn, this, args);
    if (this.pid !== undefined) nodeChildren.set(this, record(this.pid));
    return result;
  };
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const index = Array.isArray(args[0]) ? 1 : 0;
    const options = args[index] as { env?: NodeJS.ProcessEnv } | undefined;
    // Bun's default spawn environment is its startup snapshot, rather than
    // process.env as changed by the preload. Supply the binding explicitly in
    // both overloads, including calls with no options object.
    const inherited = options?.env ?? process.env;
    args[index] = { ...options, env: { ...inherited, LLV_FIXTURE_PARENT_IDENTITY: inherited.LLV_FIXTURE_PARENT_IDENTITY || JSON.stringify(owner) } } as never;
    const child = Reflect.apply(rawBunSpawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    bunChildren.set(child, record(child.pid));
    return child;
  }) as typeof Bun.spawn;
  // Fixtures bind to this recorded runner, including a parent that exits
  // before the fixture's first import. Explicit fixture env overrides win.
  process.env.LLV_FIXTURE_PARENT_IDENTITY = JSON.stringify(owner);
  afterAll(async () => {
    prototype.spawn = rawNodeSpawn; Bun.spawn = rawBunSpawn;
    const survivors = [...nodeChildren].filter(([, identity]) => processIdentityStatus(identity) === "alive").map(([child]) => child);
    const bunSurvivors = [...bunChildren].filter(([, identity]) => processIdentityStatus(identity) === "alive").map(([child]) => child);
    for (const child of survivors) await stopFixtureProcess(child);
    for (const child of bunSurvivors) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 500);
      try { await Promise.race([child.exited, Bun.sleep(2_000).then(() => { throw new Error(`owned test child ${child.pid} survived cleanup`); })]); }
      finally { clearTimeout(force); }
    }
    fs.writeFileSync(`${ledger}.done`, "done");
    if (guardian) await Promise.race([guardian.exited, Bun.sleep(3_000).then(() => {
      guardian.kill("SIGKILL"); throw new Error("owned test child guardian did not finish");
    })]);
    const identities = fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (identities.some(identity => processIdentityStatus(identity) === "alive")) throw new Error("owned test child survived the final identity check");
    // Native CLIs can fork their own protocol servers. Keep the test runner
    // alive while those kernel-owned children finish shutdown, then fail with
    // identities if they exceed the bound. The service reaps persistent tails.
    const scopeDeadline = Date.now() + 2_000;
    let remaining = scopeChildren();
    while (remaining.length && Date.now() < scopeDeadline) {
      await Bun.sleep(20);
      remaining = scopeChildren();
    }
    if (remaining.length) throw new Error(`owned test scope children survived teardown: ${remaining.map(pid => `${pid} (${procBackend.processIdentity(pid)})`).join(", ")}`);
    if (survivors.length || bunSurvivors.length || (guardian && guardian.exitCode !== 0)) {
      throw new Error(`owned test children survived teardown: ${[...survivors, ...bunSurvivors].map(child => child.pid).join(", ")}; guardian=${guardian?.exitCode ?? "kernel"}`);
    }
  });
}
