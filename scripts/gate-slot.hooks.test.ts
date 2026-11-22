import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { redactBounded } from "../src/lib/monitor/redact";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";
import { CPU_QUEUE_SPACING_MS } from "../src/lib/runtime/cpuAdmission";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { realExec } from "../src/lib/workflows/provision";
import { fixture, legacyGateTree, pathWithoutFlock, queuedTickets, until } from "./gate-slot.queue.fixture";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { createPublicationFixtures } from "./publicationHook.fixture";

const systemctl = process.platform === "linux" ? Bun.which("systemctl") : null;
const hasUserManager = systemctl !== null && Bun.spawnSync([systemctl, "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!hasUserManager)("a pre-commit service and its client cannot fence their own queued ESLint", async () => {
  const f = fixture(), roots: string[] = [], control = new AbortController();
  const log = path.join(f.dir, "pre-commit.stderr");
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    const hook = createHookFixture(process.cwd(), roots);
    const hookEnv: NodeJS.ProcessEnv = hook.env;
    fs.mkdirSync(path.join(hook.dir, "scripts/gate-runner"));
    for (let i = 0; i < 41; i++) fs.writeFileSync(path.join(hook.dir, `input-${i}.ts`), "export {};\n");
    hook.git("add", ".");
    const env = { ...hookEnv, ...f.env, PATH: hookEnv.PATH, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: "6",
      LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_SANDBOX_RECORD: undefined,
      CPU_SLOT_STDERR: log, FIXTURE_HOOK_PID: path.join(f.dir, "hook.pid") };
    withoutInheritedGate(env);
    const previous = Date.now() - CPU_QUEUE_SPACING_MS;
    f.db.query("UPDATE admission SET last = ?").run(previous);
    // The publication comparator can reach this test after the original push
    // deadline. realExec snapshots its environment before returning.
    const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
    process.env.LLV_GATE_PUSH_DEADLINE = "1";
    try {
      pending = realExec("bash", ["-c", 'echo $$ > "$FIXTURE_HOOK_PID"; exec "$@" 2>"$CPU_SLOT_STDERR"', "pre-commit-fixture", "bun", "scripts/local-gate.ts", "pre-commit"],
        hook.dir, env, { timeoutMs: 18_000, signal: control.signal });
    } finally {
      if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
      else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
    }
    const diagnostics = () => new Error(redactBounded(fs.readFileSync(log, "utf8"), 2_000));
    await until(() => f.count() === 1, 8_000, diagnostics);
    const ticket = f.db.query<{ key: string; owner: string }, []>(`SELECT key, owner ${queuedTickets}`).get()!;
    const waiter = JSON.parse(ticket.owner).pid;
    const group = fs.readFileSync(`/proc/${waiter}/cgroup`, "utf8");
    const unit = /\/(delegatus-gate-[\da-f-]+\.service)(?:\/|\n)/.exec(group)?.[1];
    expect(unit).toBeDefined();
    const service = execFileSync(systemctl!, ["--user", "show", "-p", "MainPID", "--value", unit!], { encoding: "utf8" }).trim();
    const argv = fs.readFileSync(`/proc/${service}/cmdline`, "utf8").split("\0");
    expect(argv[2]).toBe("--service");
    expect(fs.existsSync(argv[3]!)).toBe(false);
    const children = (pid: string) => fs.readdirSync(`/proc/${pid}/task`).flatMap(thread =>
      fs.readFileSync(`/proc/${pid}/task/${thread}/children`, "utf8").trim().split(/\s+/).filter(Boolean));
    const original = fs.readFileSync(env.FIXTURE_HOOK_PID, "utf8").trim();
    const clients = children(original).filter(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("owned-runner.ts"));
    expect(clients).toHaveLength(1);
    expect(children(clients[0]!).map(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))
      .some(command => command.includes("systemd-run\0") && command.includes(`--unit=${unit}\0`) && command.includes(argv[3]!))).toBe(true);
    expect(fs.readFileSync(`/proc/${waiter}/cmdline`, "utf8")).toContain("scripts/eslint-changes.ts");
    expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'gate_slots'").get()).toBeNull();
    expect(f.db.query("SELECT last FROM admission").get()).toEqual({ last: previous });
    for (let i = 1; i <= 6; i++) {
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, `llv-heavy-gate.slot${i}.lock`), "true"]).exitCode).toBe(0);
    }
    f.age();
    await until(() => fs.existsSync(hookEnv.HOOK_LOG!), 5_000, diagnostics);
    const result = await pending;
    expect(result.code, redactBounded(result.stderr, 2_000)).toBe(0);
    const lint = hook.calls().filter(call => call.args[0] === "scripts/eslint-changes.ts");
    expect(lint).toHaveLength(1);
    expect(lint[0]!.deadline).toBeUndefined();
    expect(f.count()).toBe(0);
  } finally {
    control.abort();
    await pending;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 22_000);

for (const portable of [false, true]) test.skipIf(process.platform !== "linux" || !portable && !hasUserManager)(
  `a pre-exemption ${portable ? "portable runner" : "service"} holds its cap-one grant until the ordinary hook exits`, async () => {
  const f = fixture(), control = new AbortController(), pending: ReturnType<typeof realExec>[] = [];
  const release = path.join(f.dir, "release"), entered = path.join(f.dir, "entered");
  const finish = path.join(f.dir, "finish");
  const env = { ...f.env, LLV_GATE_SLOTS: "1", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_RUNNER: "off",
    LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_BUN: process.execPath };
  const last = () => f.db.query<{ last: number }, []>("SELECT last FROM admission").get()!.last;
  try {
    const legacy = legacyGateTree(f.dir, portable ? "3e570adfba80059eaba26a978402a2e73a02978e" : "bf1c00247d496184b51c598a92e7cf4501185ae5");
    if (portable) withoutInheritedGate(env);
    execFileSync("git", ["init", "--quiet", legacy], { env: fixtureGitEnv() });
    const bin = pathWithoutFlock(f.dir);
    if (portable) fs.rmSync(path.join(bin, "systemctl"), { force: true });
    // Hold the real legacy hook in its fetch after it has consumed its ticket.
    // The empty repository then ends the hook at merge-base.
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
if [[ $1 != fetch ]]; then command -p git "$@"; exit $?; fi
echo "$PPID" > "$FIXTURE_ENTERED"
while [[ ! -f "$FIXTURE_RELEASE" ]]; do sleep 0.02; done
`, { mode: 0o755 });
    const holderRun = realExec("bash", ["scripts/gate-slot.sh", "bun", "scripts/local-gate.ts", "pre-push"], legacy,
      { ...env, PATH: bin, FIXTURE_ENTERED: entered, FIXTURE_RELEASE: release },
      { timeoutMs: 25_000, signal: control.signal });
    pending.push(holderRun);
    await Promise.race([until(() => fs.existsSync(entered), 10_000), Promise.resolve(holderRun).then(result => {
      throw new Error(`historical hook exited before fetch (${result.code}): ${redactBounded(result.stderr, 2000)}`);
    })]);
    const hook = fs.readFileSync(entered, "utf8").trim();
    const parent = fs.readFileSync(`/proc/${hook}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1];
    const service = fs.readFileSync(`/proc/${parent}/cmdline`, "utf8").split("\0");
    expect(service[2]).toBe(portable ? "--portable" : "--service");
    if (!portable) expect(fs.existsSync(service[3]!)).toBe(false);
    expect(f.count()).toBe(0);
    const held = last();
    expect(held).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(f.dir, "llv-heavy-gate.slot1.lock"))).toBe(false);

    // Count every subsequent grant, including one that exits between polls.
    f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
    pending.push(realExec("bash", ["scripts/gate-slot.sh", "bash", "-c",
      'if read -r stat < "/proc/$FIXTURE_HOOK/stat" 2>/dev/null; then [[ ${stat##*) } == Z\\ * ]] || exit 23; fi; echo entrant >> "$CPU_QUEUE_OUTPUT"; while [[ ! -f "$FIXTURE_FINISH" ]]; do sleep 0.02; done'],
      process.cwd(), { ...env, FIXTURE_HOOK: hook, FIXTURE_FINISH: finish }, { timeoutMs: 25_000, signal: control.signal }));
    const polled = () => f.db.query<{ polled: number }, []>(`SELECT polled ${queuedTickets}`).get()?.polled ?? 0;
    await until(() => last() !== held || polled() > held + CPU_QUEUE_SPACING_MS + 1000, 10_000);
    expect(f.db.query("SELECT * FROM grants").all()).toEqual([]);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    fs.writeFileSync(release, "release");
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT), 10_000);
    expect(f.db.query("SELECT slot, cap FROM gate_slots").all()).toEqual([{ slot: 1, cap: 1 }]);
    fs.writeFileSync(finish, "finish");
    const [holder, entrant] = await Promise.all(pending);
    expect(holder!.code).toBe(1);
    expect(holder!.stderr).toContain("git merge-base failed");
    expect(entrant!.code, entrant!.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("entrant\n");
    expect(f.db.query("SELECT at FROM grants").all()).toEqual([{ at: last() }]);
    expect(f.count()).toBe(0);
  } finally {
    fs.writeFileSync(release, "release"); fs.writeFileSync(finish, "finish"); control.abort();
    await Promise.allSettled(pending);
    f.close();
  }
}, 45_000);

for (const upgraded of [false, true]) test.skipIf(!hasUserManager)(
  `a native hook that consumed admission keeps it after queuing its nested gate (upgrade during fetch: ${upgraded})`, async () => {
  const f = fixture(), roots: string[] = [], holder = new AbortController(), entrant = new AbortController();
  const pending: ReturnType<typeof realExec>[] = [];
  const entered = path.join(f.dir, "fetch"), resume = path.join(f.dir, "resume");
  const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
  try {
    const legacy = legacyGateTree(f.dir, "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1");
    const publication = createPublicationFixtures(legacy, roots).fixture();
    fs.mkdirSync(path.join(publication.dir, "scripts/gate-runner"));
    const bin = pathWithoutFlock(f.dir);
    for (const name of ["sh", "cat", "cut", "id", "ps", "awk", "sed", "chmod", "python3", "basename", "nproc", "env", "readlink"]) {
      const executable = Bun.which(name);
      if (executable) fs.symlinkSync(executable, path.join(bin, name));
    }
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash
if [[ $1 == fetch ]]; then
  echo "$PPID" > "$FIXTURE_FETCH"
  while [[ ! -f "$FIXTURE_RESUME" ]]; do sleep 0.02; done
fi
command -p git "$@"
`, { mode: 0o755 });
    const env = { ...publication.env, ...f.env, PATH: path.join(publication.dir, "shims") + path.delimiter + bin,
      LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off", LLV_GATE_PUSH_DEADLINE: undefined, LLV_GATE_PUBLICATION_RECEIPT: undefined,
      LLV_GATE_BUN: process.execPath, FIXTURE_FETCH: entered, FIXTURE_RESUME: resume, GIT_DIR: ".git", DELEGATUS_CPU_PRESSURE: "off" };
    withoutInheritedGate(env);
    f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
    if (upgraded) f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
    pending.push(realExec("bash", ["scripts/gate-slot.sh", ".githooks/pre-push"], publication.dir, env, { timeoutMs: 30_000, signal: holder.signal }));
    await until(() => fs.existsSync(entered), 10_000);
    const hook = fs.readFileSync(entered, "utf8").trim();
    const supervisor = fs.readFileSync(`/proc/${hook}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1];
    const args = fs.readFileSync(`/proc/${supervisor}/cmdline`, "utf8").split("\0");
    expect(args[2]).toBe("--service");
    expect(fs.existsSync(args[3]!)).toBe(false);
    expect(fs.existsSync(path.join(f.dir, "llv-heavy-gate.slot1.lock"))).toBe(false);
    expect(grants()).toHaveLength(1);
    expect(f.count()).toBe(0);
    const entrantEnv = { ...f.env, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off" };
    withoutInheritedGate(entrantEnv);
    pending.push(realExec("bash", f.command("entrant").slice(1), process.cwd(), entrantEnv, { timeoutMs: 30_000, signal: entrant.signal }));
    await until(() => f.count() === 1);
    const head = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!.owner;
    fs.writeFileSync(resume, "continue");
    await until(() => f.count() === 2);
    const nested = f.db.query<{ owner: string }, [string]>(`SELECT owner ${queuedTickets} AND owner != ?`).get(head)!;
    expect(fs.readFileSync(`/proc/${JSON.parse(nested.owner).pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[1]).toBe(hook);
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
    const held = f.db.query<{ last: number }, []>("SELECT last FROM admission").get()!.last;
    const polls = new Set<number>();
    await until(() => {
      const polled = f.db.query<{ polled: number }, [string]>("SELECT polled FROM tickets WHERE owner = ?").get(head)?.polled;
      if (polled && polled > held + CPU_QUEUE_SPACING_MS) polls.add(polled);
      return polls.size >= 6 || grants().length !== 1;
    }, 10_000);
    expect(grants()).toEqual([{ at: held }]);
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    holder.abort();
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT), 10_000);
    expect((await pending[1]!).code).toBe(0);
    expect(grants()).toHaveLength(2);
  } finally {
    fs.writeFileSync(resume, "continue"); holder.abort(); entrant.abort();
    await Promise.allSettled(pending);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    f.close();
  }
}, 50_000);

for (const mode of ["portable hooks first-open", "service hooks first-open", "portable prepare", "portable hooks", "service prepare", "service hooks", "historical service hook", "older helper head"] as const) test.skipIf(
  process.platform !== "linux" || !mode.startsWith("portable") && !hasUserManager
)(`FIFO publication admits the first check while the peer waits (${mode})`, async () => {
    const useService = !mode.startsWith("portable");
    const historical = mode === "historical service hook", olderHead = mode === "older helper head";
    const ordinary = mode.includes("hooks") || historical || olderHead;
    const firstOpen = mode.endsWith("first-open");
    const f = fixture(), control = new AbortController(), roots: string[] = [];
    const pending: ReturnType<typeof realExec>[] = [];
    const { fixture: publicationFixture, commitFixtureInputs } = createPublicationFixtures(process.cwd(), roots);
    const release = path.join(f.dir, "release"), started = path.join(f.dir, "started");
    const last = () => f.db.query<{ last: number | null }, []>("SELECT last FROM admission").get()!.last;
    const log = (name: string) => path.join(f.dir, `${name}.stderr`);
    const stderr = (name: string) => fs.existsSync(log(name)) ? fs.readFileSync(log(name), "utf8") : "";
    const launch = (publication: ReturnType<typeof publicationFixture>, name: string) => {
      // realExec merges process.env back in. Explicitly mask the enclosing
      // publication deadline so this private publication gets its own budget.
      const env: NodeJS.ProcessEnv = { ...publication.env, LLV_GATE_LOCK_DIR: f.dir, LLV_GATE_SLOTS: "1", LLV_GATE_RUNNER: "off",
        LLV_GATE_PSI_FILE: f.env.LLV_GATE_PSI_FILE, LLV_GATE_POLL_SECONDS: f.env.LLV_GATE_POLL_SECONDS,
        LLV_GATE_PSI_RELEASE_SECONDS: "0", DELEGATUS_CPU_PRESSURE: "on", DELEGATUS_AGENT_CPU: "off", CPU_SLOT_STDERR: log(name),
        LLV_GATE_PUBLICATION_ID: name, LLV_OWNED_RUN_TIMEOUT_MS: "25000", LLV_GATE_SANDBOX_RECORD: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
      if (olderHead) {
        // Route through the same host-only PATH binding supplied by the
        // launcher. The fixture's Bun shim still stands in for the check.
        const bun = path.join(publication.dir, "shims", "bun");
        fs.writeFileSync(bun, fs.readFileSync(bun, "utf8").replace("#!/bin/bash\n", `#!/bin/bash
case "$1" in */cpu-admission.ts|*/owned-runner.ts) exec "$HOOK_BUN" "$@" ;; esac
`));
        env.LLV_GATE_BUN = undefined;
        Object.assign(env, installedGateAdmissionEnv(env));
      }
      withoutInheritedGate(env, { keepSandbox: useService });
      let command = ["bun", "scripts/local-gate.ts", "pre-push", "--publication-prepare"];
      if (ordinary) {
        env.LLV_GATE_PUBLICATION_RECEIPT = undefined;
        command = ["bun", "scripts/local-gate.ts", "pre-push"];
        if (name === "peer" && historical) {
          command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
        } else if (name === "peer" && !useService) {
          command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
        } else if (name === "peer") {
          // Enter the service exactly as gate-slot's placed native hook does.
          // Supply its quota readback privately, without configuring a host slice.
          const group = "/fixture.slice/gate.service";
          fs.mkdirSync(path.join(f.dir, group), { recursive: true });
          for (const node of [group, path.dirname(group)]) fs.writeFileSync(path.join(f.dir, node, "cpu.max"), "100000 100000");
          const membership = path.join(f.dir, "placement");
          fs.writeFileSync(membership, `0::${group}\n`);
          Object.assign(env, { LLV_GATE_CGROUP_FILE: membership, LLV_GATE_CGROUP_ROOT: f.dir, LLV_GATE_SLICE: "fixture.slice" });
          command = [process.execPath, "scripts/owned-runner.ts", "/bin/bash", "scripts/gate-slot.sh", "--in-cpu-scope", ".githooks/pre-push"];
        }
      }
      let outcome: Awaited<ReturnType<typeof realExec>> | undefined;
      // Reproduce an exhausted comparator's enclosing deadline on every run.
      // realExec snapshots the environment synchronously when spawning.
      const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
      process.env.LLV_GATE_PUSH_DEADLINE = "1";
      try {
        pending.push(Promise.resolve(realExec("bash", ["-c", 'exec "$@" 2>"$CPU_SLOT_STDERR"', "publication-fixture", ...command], publication.dir, env, { timeoutMs: 30_000, signal: control.signal }))
          .then(result => { outcome = result; return result; }));
      } finally {
        if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
        else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
      }
      const waitFor = (barrier: string, reached: () => boolean) => {
        const failure = () => {
          const status = outcome ? `exited (code=${outcome.code}, signal=${outcome.signal ?? "none"})` : "still running";
          return new Error(`${name} ${status} at ${barrier}\n${redactBounded([stderr(name), outcome?.stderr].filter(Boolean).join("\n"), 2_000)}`);
        };
        return until(() => {
          if (outcome) throw failure();
          return reached();
        }, 10_000, failure);
      };
      return { env, waitFor };
    };
    try {
      const first = publicationFixture();
      const peer = historical
        ? createPublicationFixtures(legacyGateTree(f.dir, "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1"), roots).fixture()
        : publicationFixture();
      if (olderHead) {
        // The exact older admission implementation observed at the FIFO head.
        const historicalTree = legacyGateTree(f.dir, "36b68a986862c5391cadf0c8c162aeea73012447");
        for (const entry of ["cpu-admission.ts", "gate-slot.sh"]) {
          const target = path.join(first.dir, "scripts", entry);
          fs.unlinkSync(target);
          fs.symlinkSync(path.join(historicalTree, "scripts", entry), target);
        }
      }
      for (const publication of [first, peer]) {
        if (!useService) fs.writeFileSync(path.join(publication.dir, "shims/systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        fs.mkdirSync(path.join(publication.dir, "scripts/gate-runner"));
      }
      fs.appendFileSync(path.join(first.dir, "record.ts"), `\nif (process.argv[2] === "tsc") {
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(started)}, "started");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
      }\n`);
      commitFixtureInputs(first);
      if (!useService) commitFixtureInputs(peer);
      // The first-open supervisor must have a clear post-grant birth time;
      // leave more than the procfs clock's conservative uncertainty window.
      const previous = Date.now() - (firstOpen ? 5_000 : CPU_QUEUE_SPACING_MS);
      f.db.query("UPDATE admission SET last = ?").run(previous);
      f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
      if (firstOpen) {
        // Keep the old queue's prior-grant boundary while removing the new
        // observer metadata. The first nested gate installs it with both
        // ordinary hook supervisors already alive.
        f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
      }
      const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
      const firstRun = launch(first, "first");
      await firstRun.waitFor("its first private ticket", () => f.count() === 1);
      const firstTicket = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!;
      const peerRun = launch(peer, "peer");
      await peerRun.waitFor("the second private ticket", () => f.count() === 2);
      expect(last()).toBe(previous);
      fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
      await firstRun.waitFor("the admitted check starting", () => fs.existsSync(started));
      const admitted = last()!;
      expect(admitted).toBeGreaterThan(previous);
      expect(grants()).toEqual([{ at: admitted }]);
      expect(f.count()).toBe(1);
      expect(f.db.query(`SELECT owner ${queuedTickets}`).get()).not.toEqual(firstTicket);
      expect(f.db.query("SELECT slot, cap, owner FROM gate_slots JOIN tickets USING (key)").all()).toEqual([{ slot: 1, cap: 1, ...firstTicket }]);
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.lock"), "true"]).exitCode).toBe(1);
      expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.cap1.lock"), "true"]).exitCode).toBe(1);
      expect(fs.existsSync(peer.receipt)).toBe(false);
      fs.writeFileSync(release, "release");
      const results = await Promise.all(pending);
      expect(results.map(result => result.code), redactBounded(stderr("first") + stderr("peer"), 4_000)).toEqual([0, 0]);
      if (useService) expect(stderr("first")).toMatch(/gate-slot: delegatus-gate-[\da-f-]+\.service:/);
      else expect(stderr("first")).toContain("using the documented portable cleanup fallback");
      expect(last()).toBeGreaterThan(admitted);
      expect(grants()).toEqual([{ at: admitted }, { at: last() }]);
      for (const [publication, { env }] of [[first, firstRun], [peer, peerRun]] as const) {
        if (ordinary) expect(publication.calls().filter(call => call.args[0] === "tsc")).toHaveLength(1);
        else expect(readPublicationCheckReceipt(publication.receipt, publicationCheckBinding(env)).completedAt).toBeGreaterThanOrEqual(admitted);
      }
      expect(f.count()).toBe(0);
    } finally {
      fs.writeFileSync(release, "release"); control.abort();
      await Promise.allSettled(pending);
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      f.close();
    }
  }, 60_000);
