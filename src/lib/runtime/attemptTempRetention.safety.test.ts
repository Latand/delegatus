import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, spyOn } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { attemptReferencesClear } from "./attemptTempFilesystem";
import { attemptTempAuthority } from "./attemptTempProduction";
import { scanProcesses } from "../tempSweep";
import { savePipelines } from "../pipelines/store";
import { finishedLane } from "./attemptTempRetention.testSupport";
import * as removal from "./attemptTempRemoval";
const NOW = Date.parse("2030-01-20T00:00:00Z");
function fixture() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-safety-"));
    const directory = path.join(parent, "llv-stage-safety");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), "protected payload");
    const lane = finishedLane(parent, new Date(NOW - 3600000).toISOString());
    savePipelines([lane]);
    const store = new AttemptTempStore(path.join(parent, "attempt-temp.sqlite"));
    store.register({ directory, pipelineId: lane.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
    store.measure(directory, 12288);
    const authority: NonNullable<AttemptTempSweepOptions["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => NOW);
    const options: AttemptTempSweepOptions = { now: () => NOW, capBytes: 0, availableBytes: () => 1e12, authority,
        state: async (owner, inventory) => (await authority(owner, inventory)).state,
        scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
    return { parent, directory, lane, store, options, close() { store.close(); fs.rmSync(parent, { recursive: true, force: true }); savePipelines([]); } };
}
for (const mode of ["flag-alias", "plain-symlink-dotdot", "relative-flag-alias", "relative-symlink-dotdot", "flag-alias-spaces", "flag-hop-outside", "flag-dotdot-outside"] as const)
    test.skipIf(process.platform !== "linux")(`a pending live command input survives (${mode})`, async () => {
        const f = fixture();
        let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
        try {
            const consumer = path.join(f.parent, "consumer");
            fs.mkdirSync(consumer);
            const script = path.join(consumer, "reader.py");
            fs.writeFileSync(script, 'import sys\np=sys.argv[1]\np=p.split("=",1)[1] if p.startswith("--input=") else p\nprint(open(p).read(),flush=True)\nsys.stdin.read()\n');
            const alias = path.join(consumer, mode.endsWith("spaces") ? "external alias" : "external-alias");
            let input: string;
            let outside: string | undefined;
            if (mode === "flag-hop-outside") {
                const target = path.join(consumer, "external-data"); fs.mkdirSync(target);
                outside = path.join(target, "data"); fs.writeFileSync(outside, "protected payload");
                fs.symlinkSync(f.directory, alias); fs.symlinkSync(target, path.join(f.directory, "forward"));
                input = "--input=" + alias + "/forward/data";
            }
            else if (mode === "flag-dotdot-outside") {
                outside = path.join(f.parent, "outside-data"); fs.writeFileSync(outside, "protected payload");
                fs.symlinkSync(f.directory, alias); input = "--input=" + alias + "/../outside-data";
            }
            else if (mode.includes("flag")) {
                fs.symlinkSync(f.directory, alias);
                input = "--input=" + alias + "/data";
            }
            else {
                fs.mkdirSync(path.join(f.directory, "sub"));
                fs.symlinkSync(path.join(f.directory, "sub"), alias);
                input = alias + "/../data";
            }
            if (mode.startsWith("relative")) input = input.replace(consumer + path.sep, "");
            child = Bun.spawn([Bun.which("python3")!, script, input], { cwd: consumer, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            const reader = child.stdout.getReader();
            try {
                expect(new TextDecoder().decode((await reader.read()).value)).toBe("protected payload\n");
            }
            finally {
                reader.releaseLock();
            }
            const proc = path.join(f.parent, "proc");
            fs.mkdirSync(proc);
            fs.symlinkSync('/proc/' + child.pid, path.join(proc, String(child.pid)));
            fs.symlinkSync('/proc/self', path.join(proc, "self"));
            const scan = () => scanProcesses(proc, [f.directory]);
            expect(scan().processes).toHaveLength(1);
            const report = await sweepAttemptTemps(f.store, { ...f.options, scan,
                references: (original, current, observed) => attemptReferencesClear(original, current, observed, async () => true) });
            expect(report.removed).toBe(0);
            expect(fs.readFileSync(path.join(f.directory, "data"), "utf8")).toBe("protected payload");
            child.stdin.end();
            expect(await child.exited).toBe(0);
            child = undefined;
            const released = await sweepAttemptTemps(f.store, { ...f.options, scan,
                references: (original, current, observed) => attemptReferencesClear(original, current, observed, async () => true) });
            expect(released.removed).toBe(1);
            if (outside) expect(fs.readFileSync(outside, "utf8")).toBe("protected payload");
        }
        finally {
            if (child) {
                child.stdin.end();
                expect(await child.exited).toBe(0);
            }
            f.close();
        }
    }, 60000);
test.skipIf(process.platform !== "linux")("a finished lane cannot reopen while its native removal is in flight", async () => {
    const f = fixture();
    f.lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "retention-launch",
        effectiveRole: f.lane.stages[0]!.effectiveRole, conversationId: "fixture", sessionId: null, agentPath: null,
        paneId: null, flowId: null, startedAt: new Date(NOW - 7200_000).toISOString(),
        completedAt: new Date(NOW - 3600_000).toISOString(), input: null, activatedBy: null,
        output: null, verdict: { status: "pass", findings: [] }, error: null }] }];
    const native = removal.removeTreeWithinAttemptBudget;
    let reopened = false, refused = false, removerStarted = false;
    const hook = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (directory, started) => {
        // Keep the native wrapper and actual child deletion. An IPC barrier holds
        // the child after spawn, where a separate Viewer writer can reopen the lane.
        return native(directory, started, (async (command: string, args: string[]) => {
            const script = '(async()=>{process.stdout.write("ready\\n");for await(const chunk of process.stdin){break;}' + args[1] + '})().catch(error=>{console.error(error);process.exitCode=1})';
            const child = Bun.spawn([command, args[0]!, script, ...args.slice(2)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            try {
                const reader = child.stdout.getReader();
                expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
                removerStarted = true;
                try {
                    f.lane.state = "running";
                    f.lane.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
                    const prior = f.lane.runs[0]!.attempts[0]!;
                    f.lane.runs[0]!.attempts.push({ ...prior, n: 2, state: "running", launchId: "reopened-launch",
                        startedAt: new Date(NOW).toISOString(), completedAt: null, verdict: null });
                    savePipelines([f.lane]);
                    reopened = true;
                }
                catch (error) {
                    expect(String(error)).toContain("retirement pending");
                    refused = true;
                }
                if (reopened) expect((await attemptTempAuthority(f.store.owner(f.directory)!, undefined, () => NOW)).state).toBe("live");
                child.stdin.write("go");
                child.stdin.end();
                const drain = (async () => { try {
                    while (!(await reader.read()).done) { }
                    return "";
                }
                finally {
                    reader.releaseLock();
                } })();
                const [stdout, stderr, exit] = await Promise.all([drain, new Response(child.stderr).text(), child.exited]);
                if (exit !== 0)
                    throw Object.assign(new Error(stderr), { stderr });
                return { stdout, stderr };
            }
            finally {
                child.stdin.end();
                await child.exited;
            }
        }) as never);
    });
    try {
        savePipelines([f.lane]);
        const report = await sweepAttemptTemps(f.store, f.options);
        expect(removerStarted).toBeTrue();
        expect(report.errors).toBe(0);
        expect(reopened).toBeFalse();
        expect(refused).toBeTrue();
        expect(report.removed).toBe(1);
        // The same writer and record are admitted once the remover settles.
        savePipelines([f.lane]);
    }
    finally {
        hook.mockRestore();
        f.close();
    }
}, 60000);
test.skipIf(process.platform !== "linux").each(["before-sweep", "reference-await"])("an ancestor rebound beneath protected evidence survives (%s)", async phase => {
    const f = fixture();
    const { statePath } = await import("../configDir");
    const evidence = statePath("evidence", "rebound-protected");
    try {
        f.store.forget(f.directory);
        const container = path.join(f.parent, "container");
        fs.mkdirSync(container);
        const directory = path.join(container, "llv-stage-safety");
        fs.renameSync(f.directory, directory);
        fs.unlinkSync(path.join(directory, ".delegatus-attempt-owner"));
        f.store.register({ directory, pipelineId: f.lane.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
        f.store.measure(directory, 12288);
        fs.mkdirSync(path.dirname(evidence), { recursive: true });
        let rebound = false;
        const rebind = () => {
            if (rebound) return;
            fs.renameSync(container, evidence);
            fs.symlinkSync(evidence, container);
            rebound = true;
        };
        if (phase === "before-sweep") rebind();
        const report = await sweepAttemptTemps(f.store, { ...f.options, references: async () => { rebind(); return true; } });
        const physical = fs.realpathSync(directory);
        expect(physical.startsWith(statePath("evidence") + path.sep)).toBeTrue();
        expect(report.removed).toBe(0);
        expect(fs.readFileSync(path.join(physical, "data"), "utf8")).toBe("protected payload");
    }
    finally {
        f.close();
        fs.rmSync(evidence, { recursive: true, force: true });
    }
}, 60000);

test.skipIf(process.platform !== "linux")("a stable ancestor alias still admits an eligible root", async () => {
    const f = fixture();
    try {
        f.store.forget(f.directory);
        fs.unlinkSync(path.join(f.directory, ".delegatus-attempt-owner"));
        const alias = path.join(f.parent, "stable-alias"); fs.symlinkSync(f.parent, alias);
        const directory = path.join(alias, path.basename(f.directory));
        f.store.register({ directory, pipelineId: f.lane.id, launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
        f.store.measure(directory, 12288);
        const report = await sweepAttemptTemps(f.store, f.options);
        expect(report).toMatchObject({ removed: 1, errors: 0 });
        expect(fs.existsSync(f.directory)).toBeFalse();
    } finally { f.close(); }
}, 60000);
