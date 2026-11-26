import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { redactBounded } from "../src/lib/monitor/redact";
import { captureProcessIdentity } from "../src/lib/processIdentity";
import { installedGateAdmissionEnv } from "../src/lib/runtime/agentSignalSandbox";
import { CPU_QUEUE_SPACING_MS, CpuAdmissionQueue, PUBLICATION_LAUNCH_PROOF_ENV, publicationLaunchDigest } from "../src/lib/runtime/cpuAdmission";
import { newPublicationLaunchProof, stampPublicationPreparer, type PublicationPreparerStamp } from "../src/lib/runtime/publicationLaunch";
import { hostProcessIdentity, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { realExec } from "../src/lib/workflows/provision";
import { fixture, legacyGateTree, queuedTickets, until } from "./gate-slot.queue.fixture";
import { fixtureGitEnv } from "./local-gate.fixture";
import { createPublicationFixtures, stubOlderPublicationChecks } from "./publicationHook.fixture";

/**
 * The FIFO publication case, shared by the test files that register its
 * modes: scripts/gate-slot.fifo.test.ts, scripts/gate-slot.fifoOlder.test.ts
 * and scripts/gate-slot.publicationLaunch.test.ts. Each case starts two real
 * publications, so the modes are spread over files that each stay inside the
 * touched-test budget per file.
 */

const systemctl = process.platform === "linux" ? Bun.which("systemctl") : null;
const hasUserManager = systemctl !== null && Bun.spawnSync([systemctl, "--user", "show-environment"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
// #4376 (`b0de5fb1ef`) is the last main revision of local-gate.ts and gate-slot.sh before this protocol.
const MAIN_ERA_REVISION = "b0de5fb1ef6b500853e53b587e63a13a91b3e0dd";
// #4251 (`d8c5ffb9a6`): an older lane checkout's local-gate.ts, without the
// dispatch marker and outside the pinned dispatcher hashes. A lane republished
// from it in production stalled the queue with free slots.
const UNPINNED_REVISION = "d8c5ffb9a6000e4868aed1b686a5cadf5b8881ed";

/** Publications whose current preparers and hooks carry their own launch proof. */
export const QUEUE_FIFO_MODES = ["portable hooks first-open", "service hooks first-open", "portable prepare", "portable hooks", "service prepare", "mixed service prepare", "mixed service prepare first-open"] as const;
/** Publications through older hooks, helpers and the main-era dispatcher. */
export const OLDER_LAUNCHER_FIFO_MODES = ["service hooks", "historical service hook", "older helper head", "main-era service prepare", "main-era service hook", "main-era service hook first-open", "main-era portable hooks"] as const;
/** Publications from an older lane checkout, recognised only by the Viewer's launch record. */
export const LAUNCH_RECORD_FIFO_MODES = ["unpinned service prepare", "unpinned portable prepare", "unpinned service prepare forged",
  "packaged portable prepare", "packaged portable prepare forged"] as const;
type FifoPublicationMode = (typeof QUEUE_FIFO_MODES)[number] | (typeof OLDER_LAUNCHER_FIFO_MODES)[number] | (typeof LAUNCH_RECORD_FIFO_MODES)[number];

export function registerFifoPublicationCases(modes: readonly FifoPublicationMode[]) {
  for (const mode of modes) test.skipIf(
    process.platform !== "linux" || !mode.startsWith("portable") && !hasUserManager
  )(`FIFO publication admits the first check while the peer waits (${mode})`, async () => {
      const useService = !mode.includes("portable");
      // An older wrapper takes the same bypass on the portable cleanup fallback,
      // and its launch can fall on the journal's cutover tick.
      const historical = mode === "historical service hook" || mode.startsWith("main-era service hook") || mode === "main-era portable hooks", olderHead = mode === "older helper head";
      // The Viewer launches the first preparer from an older lane checkout. Its
      // launch record is the only evidence; a forged run first shows records
      // that name the wrong process or operation granting nothing.
      const unpinned = mode.startsWith("unpinned"), forged = mode.endsWith("forged");
      const packaged = mode.startsWith("packaged");
      const recordLaunch = unpinned || packaged;
      const mixedPrepare = mode.startsWith("mixed service prepare") || mode === "main-era service prepare" || unpinned;
      // Main after #4376 is the release deployed when this queue protocol lands.
      // Its dispatcher and wrapper carry no launch marker of their own.
      const mainEra = mode.startsWith("main-era");
      const deployedRevision = mainEra ? MAIN_ERA_REVISION : unpinned ? UNPINNED_REVISION : "43fab846adb9a443384d30540cf7e318a12a6198";
      const historicalRevision = mainEra ? MAIN_ERA_REVISION : "c0ceb7ff5eb064b1d9d29a9aef2540edd15d5dd1";
      const ordinary = mode.includes("hooks") || historical || olderHead;
      const firstOpen = mode.endsWith("first-open");
      const f = fixture(), control = new AbortController(), roots: string[] = [];
      const packagedRoot = path.join(f.dir, "packaged");
      const pending: ReturnType<typeof realExec>[] = [];
      const stamps: PublicationPreparerStamp[] = [];
      const launchProof = newPublicationLaunchProof();
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
          LLV_GATE_PUBLICATION_ID: name, CPU_SLOT_ROOT_PID: path.join(f.dir, name + ".pid"), LLV_OWNED_RUN_TIMEOUT_MS: "25000", LLV_GATE_SANDBOX_RECORD: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
        // The Viewer hands the preparer it launches a secret in its exec
        // environment; its launch record carries the secret's digest.
        if (recordLaunch && name === "first") env[PUBLICATION_LAUNCH_PROOF_ENV] = launchProof;
        if (olderHead) {
          // Route through the same host-only interpreter binding supplied by the
          // launcher. The fixture's Bun shim still stands in for the check.
          const bun = publication.writablePath("shims/bun");
          fs.writeFileSync(bun, fs.readFileSync(bun, "utf8").replace("#!/bin/bash\n", `#!/bin/bash
  case "$1" in */cpu-admission.ts|*/owned-runner.ts) exec "$HOOK_BUN" "$@" ;; esac
  `));
          env.LLV_GATE_BUN = process.execPath;
        }
        withoutInheritedGate(env, { keepSandbox: useService });
        // The reset unroutes an inherited launcher, so route afterwards.
        if (olderHead) Object.assign(env, installedGateAdmissionEnv(env));
        let command = ["bun", "scripts/local-gate.ts", "pre-push", "--publication-prepare"];
        if (packaged && name === "first") {
          env.LLV_GATE_CANONICAL_TOOLS = "1";
          command[1] = path.join(packagedRoot, command[1]!);
        }
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
            // Only the outer launcher exercises placement. The publication
            // checks themselves use the fixture's ordinary isolated environment.
            const hookFile = publication.writablePath(".githooks/pre-push");
            fs.writeFileSync(hookFile, fs.readFileSync(hookFile, "utf8").replace("\n", "\nexport DELEGATUS_AGENT_CPU=off\n"));
            const systemctlShim = publication.writablePath("shims/systemctl");
            fs.writeFileSync(systemctlShim, '#!/bin/bash\nif [[ $1 == --user && $2 == set-property ]]; then exit 0; fi\nexec "$FIXTURE_SYSTEMCTL" "$@"\n', { mode: 0o755 });
            Object.assign(env, { LLV_GATE_CGROUP_FILE: membership, LLV_GATE_CGROUP_ROOT: f.dir, LLV_GATE_SLICE: "fixture.slice",
              DELEGATUS_AGENT_CPU: "on", FIXTURE_SYSTEMCTL: systemctl, LLV_GATE_BUN: process.execPath });
            command = ["bash", "scripts/gate-slot.sh", ".githooks/pre-push"];
          }
        }
        let outcome: Awaited<ReturnType<typeof realExec>> | undefined;
        // Reproduce an exhausted comparator's enclosing deadline on every run.
        // realExec snapshots the environment synchronously when spawning.
        const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
        process.env.LLV_GATE_PUSH_DEADLINE = "1";
        try {
          // The Viewer stamps its preparer as it spawns it (git.ts). Each wrapper
          // here execs in place, as systemd-run --scope and the Bun shims do.
          const onSpawn = recordLaunch && !forged && name === "first"
            ? (pid: number) => { stamps.push(stampPublicationPreparer(pid, env.LLV_GATE_PUBLICATION_ID, env, publication.dir)); } : undefined;
          pending.push(Promise.resolve(realExec("bash", ["-c", 'echo "$$" > "$CPU_SLOT_ROOT_PID"; exec "$@" 2>"$CPU_SLOT_STDERR"', "publication-fixture", ...command], publication.dir, env, { timeoutMs: 30_000, signal: control.signal, onSpawn }))
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
          // The barrier outlasts the run's own 30 s deadline, so a slow host
          // reaches it late and a stuck run fails with its exit, never with a
          // race between this wait and a loaded scheduler.
          return until(() => {
            if (outcome) throw failure();
            return reached();
          }, 35_000, failure);
        };
        return { env, waitFor };
      };
      try {
        if (packaged) {
          fs.mkdirSync(packagedRoot);
          fs.cpSync(path.resolve("scripts"), path.join(packagedRoot, "scripts"), { recursive: true });
          fs.copyFileSync(path.resolve("tsconfig.json"), path.join(packagedRoot, "tsconfig.json"));
          for (const directory of ["src", "node_modules"]) {
            fs.symlinkSync(path.resolve(directory), path.join(packagedRoot, directory), "dir");
          }
        }
        const first = (() => {
          if (!mixedPrepare) return publicationFixture();
          const deployed = legacyGateTree(f.dir, deployedRevision);
          execFileSync("git", ["init", "--quiet", deployed], { env: fixtureGitEnv() });
          return createPublicationFixtures(deployed, roots).fixture();
        })();
        const peer = historical
          ? createPublicationFixtures(legacyGateTree(f.dir, historicalRevision), roots).fixture()
          : publicationFixture();
        if (mixedPrepare) {
          // The deployed hook supplies only the cleanup owner's parent identity.
          // Its own gate wrapper gets the admission helper from the new release.
          const helper = path.join(first.writablePath("scripts"), "cpu-admission.ts");
          fs.unlinkSync(helper);
          fs.symlinkSync(path.resolve("scripts/cpu-admission.ts"), helper);
        }
        if (olderHead) {
          // The exact older admission implementation observed at the FIFO head.
          const historicalTree = legacyGateTree(f.dir, "36b68a986862c5391cadf0c8c162aeea73012447");
          for (const entry of ["cpu-admission.ts", "gate-slot.sh"]) {
            const target = path.join(first.writablePath("scripts"), entry);
            fs.unlinkSync(target);
            fs.symlinkSync(path.join(historicalTree, "scripts", entry), target);
          }
        }
        const comparator = path.resolve("scripts/local-gate-tests.ts");
        const comparatorBefore = olderHead ? fs.readFileSync(comparator) : undefined;
        for (const publication of [first, peer]) {
          if (!useService) fs.writeFileSync(publication.writablePath("shims/systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          fs.mkdirSync(publication.writablePath("scripts/gate-runner"));
          if (olderHead) stubOlderPublicationChecks(publication);
        }
        if (comparatorBefore) expect(fs.readFileSync(comparator).equals(comparatorBefore)).toBeTrue();
        fs.appendFileSync(first.writablePath("record.ts"), `\nif (process.argv[2] === "tsc") {
          const fs = require("node:fs");
          fs.writeFileSync(${JSON.stringify(started)}, "started");
          while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
        }\n`);
        commitFixtureInputs(first);
        if (!useService) commitFixtureInputs(peer);
        // Start the first hook immediately after a prior grant. Its cleanup
        // runner and original hook are both live before the first queue open.
        const previous = Date.now() - (mode === "main-era service hook first-open" ? 8_000 : firstOpen ? 0 : CPU_QUEUE_SPACING_MS);
        f.db.query("UPDATE admission SET last = ?").run(previous);
        f.db.exec("CREATE TABLE grants (at INTEGER); CREATE TRIGGER count_grant AFTER UPDATE OF last ON admission BEGIN INSERT INTO grants VALUES (NEW.last); END");
        if (firstOpen) {
          // The nested gate installs the journal after the outer hook and its
          // cleanup client have already started.
          f.db.exec("DROP TRIGGER IF EXISTS legacy_gate_retired; DROP TABLE IF EXISTS legacy_gate_cutover; DROP TABLE IF EXISTS legacy_gate_retirements");
        }
        const grants = () => f.db.query("SELECT at FROM grants ORDER BY rowid").all();
        if (mixedPrepare) {
          const orphan = Bun.spawn(["bash", "-c", "read -r line"], { stdin: "pipe" });
          try {
            const owner = hostProcessIdentity(captureProcessIdentity(orphan.pid));
            f.db.query("INSERT INTO tickets (key, since, owner) VALUES (?, ?, ?)")
              .run("command:dead-head", previous, JSON.stringify(owner));
          } finally {
            orphan.stdin.end();
            await orphan.exited;
          }
        }
        const firstRun = launch(first, "first");
        await firstRun.waitFor("its first private ticket", () =>
          f.count() === 1 && (!mixedPrepare || stderr("first").includes("removed command:dead-head:")));
        const firstTicket = f.db.query<{ owner: string }, []>(`SELECT owner ${queuedTickets}`).get()!;
        if (mixedPrepare) {
          expect(stderr("first")).toContain("removed command:dead-head:");
          expect(fs.readlinkSync(path.join(signalSandboxContext()?.hostProc ?? "/proc", String(JSON.parse(firstTicket.owner).pid), "cwd"))).toBe(first.dir);
        }
        const peerRun = launch(peer, "peer");
        await peerRun.waitFor("the second private ticket", () => f.count() === 2);
        expect(last()).toBe(previous);
        expect(grants()).toEqual([]);
        expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'gate_slots'").get()).toBeNull();
        expect(Bun.spawnSync(["flock", "-n", path.join(f.dir, "llv-heavy-gate.slot1.lock"), "true"]).exitCode).toBe(0);
        if (mode === "service hooks first-open" || mode === "main-era service hook first-open") {
          const pid = fs.readFileSync(peerRun.env.CPU_SLOT_ROOT_PID!, "utf8").trim();
          const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
          expect(argv[1]).toContain("owned-runner.ts");
          if (!historical && !fs.existsSync("/.dockerenv") && peerRun.env.LLV_DOCKER_NSENTER_SHIMS !== "1") expect(argv).toContain("--in-cpu-scope");
          const born = Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]);
          const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
          // Place the journal boundary on the peer's exact kernel birth tick.
          let uptime = born / ticks - 0.01;
          if ((uptime + 0.01) * ticks < born) uptime += Number.EPSILON * uptime;
          expect((uptime + 0.01) * ticks).toBeGreaterThanOrEqual(born);
          expect(Math.round((uptime + 0.01) * ticks)).toBe(born);
          f.db.query("UPDATE legacy_gate_cutover SET uptime = ?").run(uptime);
        }
        if (firstOpen) f.age();
        const launchRows = () => f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'publication_launch_proofs'").get()
          ? f.db.query<{ identity: string; operation: string; proof: string }, []>("SELECT identity, operation, proof FROM publication_launch_proofs ORDER BY rowid").all() : [];
        const root = Number(fs.readFileSync(firstRun.env.CPU_SLOT_ROOT_PID!, "utf8").trim());
        const genuine = captureProcessIdentity(root);
        const digest = publicationLaunchDigest(launchProof);
        const launched = { identity: JSON.stringify(genuine), operation: "first", proof: digest };
        if (recordLaunch && !forged) {
          await Promise.all(stamps.map(stamp => stamp.recorded));
          expect(launchRows()).toEqual([launched]);
        }
        fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "some avg10=0.00 total=1\n");
        if (forged) {
          // No record, then records that are each wrong in one respect: another
          // operation, a reused PID's older start, an exited process, the
          // cleanup runner instead of the preparer the Viewer spawned, and a
          // record any process of this user can write for the live preparer
          // with its operation, without the secret the Viewer handed it.
          const client = fs.readdirSync(`/proc/${root}/task`).flatMap(task => fs.readFileSync(`/proc/${root}/task/${task}/children`, "utf8").trim().split(/\s+/))
            .find(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1]?.endsWith("owned-runner.ts"));
          expect(client).toBeDefined();
          const exited = Bun.spawn(["true"]);
          const gone = captureProcessIdentity(exited.pid);
          await exited.exited;
          const start = Number(genuine.startIdentity!.split(":")[1]);
          const forgedRows = [[genuine, "peer", digest], [{ ...genuine, startIdentity: `${root}:${start - 1}` }, "first", digest],
            [gone, "first", digest], [captureProcessIdentity(Number(client)), "first", digest]] as const;
          const head = f.db.query<{ key: string }, [string]>(`SELECT key ${queuedTickets} AND owner = ?`).get(firstTicket.owner)!.key;
          const drains = async (barrier: string) => {
            const held = last(), polls = new Set<number>();
            await firstRun.waitFor(barrier, () => {
              // A grant here is the defect itself: say so at once.
              if (grants().length || fs.existsSync(started)) throw new Error(`the first check was admitted at ${barrier}`);
              const polled = f.db.query<{ polled: number }, [string]>("SELECT polled FROM tickets WHERE key = ?").get(head)?.polled;
              if (polled && polled > (held ?? 0) + CPU_QUEUE_SPACING_MS) polls.add(polled);
              return polls.size >= 3;
            });
            expect(stderr("first")).toContain("Waiting for legacy heavy commands to drain");
            expect(grants()).toEqual([]);
            expect(fs.existsSync(started)).toBe(false);
          };
          await drains("a legacy drain without a launch record");
          const queue = new CpuAdmissionQueue(path.join(f.dir, "admission.sqlite"));
          try {
            queue.recordPublicationLaunch(genuine, "first", publicationLaunchDigest(newPublicationLaunchProof()));
            expect(launchRows()).toEqual([{ ...launched, proof: expect.not.stringMatching(digest) }]);
            await drains("a legacy drain under a launch record without the launch secret");
            queue.recordPublicationLaunch(forgedRows[0][0], forgedRows[0][1], forgedRows[0][2]);
          } finally { queue.close(); }
          // Write the rest directly: a later record would prune the dead ones.
          for (const [identity, operation, proof] of forgedRows.slice(1)) {
            f.db.query("INSERT INTO publication_launch_proofs VALUES (?, ?, ?, ?)").run(JSON.stringify(identity), operation, proof, Date.now());
          }
          expect(launchRows().map(row => row.operation)).toEqual(["peer", "first", "first", "first"]);
          await drains("a legacy drain under forged launch records");
          const stamp = stampPublicationPreparer(root, "first", firstRun.env, first.dir);
          stamps.push(stamp);
          await stamp.recorded;
          // The genuine record replaces the row for the same process and prunes
          // the rows of processes that are gone.
          expect(launchRows()).toEqual([{ identity: JSON.stringify(captureProcessIdentity(Number(client))), operation: "first", proof: digest }, launched]);
        }
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
        if (unpinned) {
          await Promise.all(stamps.map(stamp => stamp.release()));
          expect(launchRows()).not.toContainEqual(launched);
        }
      } finally {
        fs.writeFileSync(release, "release"); control.abort();
        await Promise.allSettled(pending);
        await Promise.allSettled(stamps.map(stamp => stamp.release()));
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
        f.close();
      }
    }, 120_000);
}
