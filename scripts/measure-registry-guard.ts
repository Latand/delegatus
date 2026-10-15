import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
const root = process.env.LLV_STATE_DIR;
if (!root || process.env.NODE_ENV !== "test" || process.env.LLV_STATE_OWNER) {
    throw new Error("Use a fresh LLV_STATE_DIR with NODE_ENV=test and no LLV_STATE_OWNER");
}
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.readdirSync(root).length !== 0) throw new Error("The measurement requires an empty LLV_STATE_DIR");
// Validate the sandbox before importing any module that can resolve state.
const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor(value?: string | number) { super(value ?? "2026-01-01T00:00:00.000Z"); }
    static now() { return 1_767_225_600_000; }
} as DateConstructor;
const { AgentRegistry, setAgentRegistryForTests } = await import("../src/lib/agent/registry");
const { emptyLaunchProfile } = await import("../src/lib/accounts/migration/contracts");
const { defaultPipelinePorts } = await import("../src/lib/pipelines/engine");
const { recordLiveObservation } = await import("../src/lib/accounts/liveLimits");
const { enforceAccountCreditGuard } = await import("../src/lib/runtime/accountCreditGuard");
const { interruptionObligationDirectory } = await import("../src/lib/runtime/interruptionObligations");
const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("../src/lib/blockingWaits");
let registry!: InstanceType<typeof AgentRegistry>;
let launches!: string[];
let directory!: string;
const uuid = crypto.randomUUID;
const bytes = crypto.randomBytes;
let fixtureSequence = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${(++fixtureSequence).toString(16).padStart(12, "0")}`;
crypto.randomBytes = ((size: number) => Buffer.alloc(size, ++fixtureSequence % 256)) as typeof crypto.randomBytes;
try {
registry = new AgentRegistry(path.join(root, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
directory = interruptionObligationDirectory(registry.filename);
const index = `${directory}.account-guard-pending`;
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(index, { recursive: true });
fs.writeFileSync(path.join(index, "ready"), '{"version":1}');
for (let n = 0; n < 128; n++) {
    const id = `interruption-continuation-${n.toString(16).padStart(32, "0")}`;
    const cut = { version: 1, id, conversationId: `conversation_fixture_${n}`, engine: "codex", hostKey: `codex:fixture-${n}`, path: `/fixture/${n}.jsonl`, owner: null, claimEpoch: 1, turnRef: "fixture-turn", boundary: "paid-credit-guard", reason: "account-guard", recordedAt: "2026-01-01T00:00:00.000Z", checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null, state: "owed", operationId: null, attempts: 0, resolvedAt: null, resolution: null };
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(cut));
    fs.writeFileSync(path.join(index, `${id}.json`), JSON.stringify({ id }));
}
launches = Array.from({ length: 4 }, (_, n) => {
    const { receipt } = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: null,
        launchProfile: emptyLaunchProfile({ cwd: "/fixture", title: `Fixture ${n}` }) });
    if (receipt.admissionOwner) registry.releaseStartingStructuredSpawn(receipt.launchId, receipt.admissionOwner);
    registry.failStructuredSpawn(receipt.launchId, "fixture admission failure", { announce: false });
    return receipt.launchId;
});
} finally {
    globalThis.Date = RealDate;
    crypto.randomUUID = uuid;
    crypto.randomBytes = bytes;
}
const fixtureSha256 = crypto.createHash("sha256").update(JSON.stringify(registry.snapshot())).digest("hex");
fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(registry.snapshot()));
setAgentRegistryForTests(registry);
const ports = defaultPipelinePorts();
const filename = registry.filename.replace(/\.json$/, ".sqlite");
const child = Bun.spawn([process.execPath, "-e", `import { Database } from "bun:sqlite"; const db=new Database(process.argv[1]); for await(const line of Bun.stdin.stream()){ const command=new TextDecoder().decode(line); if(command.includes("exit"))break; db.exec("BEGIN IMMEDIATE"); console.log("locked"); await Bun.sleep(200); db.exec("ROLLBACK"); console.log("free"); } db.close();`, filename], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env } });
const reader = child.stdout.getReader();
let buffer = "";
async function line(expected: string) { for (;;) {
    const lines = buffer.split("\n");
    if (lines.length > 1) {
        buffer = lines.slice(1).join("\n");
        if (lines[0] === expected)
            return;
    }
    else {
        const r = await reader.read();
        if (r.done)
            throw Error("holder exited");
        buffer += new TextDecoder().decode(r.value);
    }
} }
let last = performance.now(), maxDelay = 0;
const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - last - 5); last = now; }, 5);
const ticksPerSecond = Number(new TextDecoder().decode(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout).trim());
if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0)
    throw new Error("could not read Linux clock ticks");
const cpu = () => { const stat = fs.readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return (Number(fields[11]) + Number(fields[12])) * 1000 / ticksPerSecond; };
let guardStoreCalls = 0, guardMaxSlice = 0, writeMaxSlice = 0;
const claim = registry.claimFailedSpawnForRetry.bind(registry);
registry.claimFailedSpawnForRetry = (...args) => {
    const start = performance.now();
    try { return claim(...args); }
    finally { writeMaxSlice = Math.max(writeMaxSlice, performance.now() - start); }
};
const original = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { const start = performance.now(); try {
    return Reflect.apply(original, fs, args);
}
finally {
    if (String(args[0]).startsWith(directory)) {
        guardStoreCalls++;
        guardMaxSlice = Math.max(guardMaxSlice, performance.now() - start);
    }
} }) as typeof fs.readFileSync;
resetBlockingWaitsForTests(() => { });
// Exclude first-boot backfill and drain both initial pages before steady ticks.
for (let n = 0; n < 3; n++)
    await enforceAccountCreditGuard(registry, [], async () => true, async () => false, async () => null, { onlyIfChanged: true });
guardStoreCalls = 0;
guardMaxSlice = 0;
maxDelay = 0;
last = performance.now();
const start = performance.now(), before = cpu();
try {
    for (let n = 0; n < 4; n++) {
        child.stdin.write("hold\n");
        child.stdin.flush();
        await line("locked");
        const outcome = await ports.claimSpawnRetry(launches[n]!, `fixture-claim-${n}`);
        if (outcome !== "claimed") throw new Error(`unexpected retry admission: ${outcome}`);
        await line("free");
    }
    const tickTimes = [];
    for (let n = 0; n < 4; n++) {
        await Bun.sleep(1000);
        const t = performance.now();
        await enforceAccountCreditGuard(registry, [], async () => true, async () => false, async () => null, { onlyIfChanged: true });
        tickTimes.push(performance.now() - t);
    }
    let unmigratedCaller: { caller: string; synchronousMs: number; timerAdvancedAtReturn: boolean } | null = null;
    if (process.env.MEASURE_UNMIGRATED === "1") {
        child.stdin.write("hold\n"); child.stdin.flush(); await line("locked");
        let advanced = false;
        const progress = setTimeout(() => { advanced = true; }, 5);
        const beforeCall = performance.now();
        try {
            recordLiveObservation({ engine: "codex", accountId: "fixture-account", authenticated: true,
                observedAt: 1_767_225_600_000, provenance: { source: "live", reason: null, staleSince: null },
                limits: { session: null, weekly: { usedPercent: 1, resetsAt: null }, plan: "pro", capturedAt: 1_767_225_600,
                    credits: { hasCredits: false, balance: "0", unlimited: false } } }, "managed", { registry });
            unmigratedCaller = { caller: "accounts.recordLiveObservation", synchronousMs: performance.now() - beforeCall,
                timerAdvancedAtReturn: advanced };
        } finally { clearTimeout(progress); }
        await line("free");
    }
    await Bun.sleep(10);
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ sourceRevision: process.env.MEASURE_SOURCE_REVISION ?? "uncommitted", asyncAdmission: process.env.MEASURE_ASYNC === "1", fixtureSha256, unmigratedCaller, load: { registryWrites: 4, peerHoldMs: 200, guardTicks: 4, tickMs: 1000, pendingObligations: 128 }, elapsedMs: elapsed, mainThreadCpuMs: cpu() - before, mainThreadCorePercent: 100 * (cpu() - before) / elapsed, maxTimerDelayMs: maxDelay, maxWriteSyncSliceMs: writeMaxSlice, maxGuardFileReadSyncSliceMs: guardMaxSlice, guardStoreReads: guardStoreCalls, guardTickElapsedMs: tickTimes, waits: blockingWaitDiagnostics().sites }));
}
finally {
    fs.readFileSync = original;
    clearInterval(timer);
    child.stdin.write("exit\n");
    child.stdin.flush();
    await child.exited;
    reader.releaseLock();
    setAgentRegistryForTests(null);
    registry.close();
}
