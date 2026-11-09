import { readHostExit } from "./hostExit";
import { statePath } from "@/lib/configDir";
// An owned process boundary lets the parent independently bound startup and teardown.
import fs from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import type { AgentMemoryPlan } from "./agentMemory";

const [root, mode] = process.argv.slice(2);
const delayed = ["delayedexit", "delayedcontrol", "shortlive", "unlinked", "scheduler", "ownerloss"].includes(mode!);
const owned: Array<{ identity: ReturnType<typeof captureProcessIdentity>; closed: Promise<void> }> = [];
const fixtureIdentity = captureProcessIdentity(process.pid);
let nativeCompleted = false;
let waiterLive = false;
let initialSize: number | undefined;
if (delayed) {
  const { mock } = await import("bun:test");
  const childProcess = await import("node:child_process");
  const spawn = childProcess.spawn;
  const waitOwner = await import("./nativeWaitOwner");
  mock.module("./nativeWaitOwner", () => ({ ...waitOwner,
  nativeWaitOwnerSource: waitOwner.nativeWaitOwnerSource.replace("process.exitCode = code ??", `
    fs.writeFileSync(path.join(directory, "waiter-live"), "ready");
    const owner = JSON.parse(fs.readFileSync(path.join(process.env.DRAIN_ROOT, "fixture-owner.json"), "utf8"));
    const ownerAlive = () => {
      try {
        const stat = fs.readFileSync("/proc/" + owner.pid + "/stat", "utf8");
        const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/)[19];
        return owner.startIdentity === owner.pid + ":" + start;
      } catch { return false; }
    };
    const barrierDeadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(process.env.DRAIN_ROOT, "release-waiter"))) {
      if (Date.now() > barrierDeadline) throw new Error("waiter barrier deadline exceeded");
      if (!ownerAlive()) { fs.writeFileSync(path.join(process.env.DRAIN_ROOT, "waiter-owner-lost"), "ready"); break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    process.exitCode = code ??`),
  }));
  mock.module("node:child_process", () => ({ ...childProcess, spawn: (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    owned.push({ identity: captureProcessIdentity(child.pid!), closed: new Promise<void>(resolve => child.once("close", () => resolve())) });
    return child;
  } }));
  const bin = path.join(root!, "drain-bin"); fs.mkdirSync(bin, { recursive: true });
  const dd = Bun.which("dd")!;
  const cat = Bun.which("cat")!;
  const wc = Bun.which("wc")!;
  // Acknowledged barriers hold the drain after its first short read. The test
  // observes durable native exit and sink state before releasing either owner.
  fs.writeFileSync(path.join(bin, "dd"), `#!/bin/sh
owner_alive() {
  IFS= read -r owner_pid < "$DRAIN_ROOT/fixture-owner.pid" || return 1
  IFS= read -r owner_start < "$DRAIN_ROOT/fixture-owner.start" || return 1
  IFS= read -r stat < "/proc/$owner_pid/stat" || return 1
  stat=\${stat##*) }
  set -- $stat
  shift 19
  actual_start=$1
  printf '%s:%s:%s\n' "$owner_pid" "$owner_start" "$actual_start" > "$DRAIN_ROOT/owner-identity-check"
  [ "$owner_start" = "$actual_start" ]
}
if [ ! -e "$DRAIN_ROOT/first" ]; then
  "${dd}" "$@"
  touch "$DRAIN_ROOT/first"
else
  if [ ! -e "$DRAIN_ROOT/delayed" ]; then
    touch "$DRAIN_ROOT/delayed"
    attempts=0
    while [ ! -e "$DRAIN_ROOT/release-drain" ]; do
      if ! owner_alive; then touch "$DRAIN_ROOT/drain-owner-lost"; exit 0; fi
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 600 ]; then touch "$DRAIN_ROOT/drain-watchdog"; exit 0; fi
      sleep 0.005
    done
  fi
  exec "${dd}" "$@"
fi
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "cat"), `#!/bin/sh
touch "$DRAIN_ROOT/drain-tail"
[ "$DRAIN_BARRIER_OWNER_LOSS" = "1" ] || touch "$DRAIN_ROOT/release-waiter"
exec "${cat}" "$@"
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "wc"), `#!/bin/sh
if [ "$STDERR_WC_SEMANTICS" = "bsd" ] && [ -f /proc/self/fd/0 ]; then
  touch "$DRAIN_ROOT/wc-regular"
  /usr/bin/stat -c %s /proc/self/fd/0
else
  [ -p /proc/self/fd/0 ] && touch "$DRAIN_ROOT/wc-stream"
  exec "${wc}" "$@"
fi
`, { mode: 0o700 });
  process.env.DRAIN_ROOT = root;
  process.env.DRAIN_BARRIER_OWNER_LOSS = mode === "ownerloss" ? "1" : "0";
  const [ownerPid, ownerStart] = (fixtureIdentity.startIdentity ?? "").split(":");
  fs.writeFileSync(path.join(root!, "fixture-owner.json"), JSON.stringify({ pid: fixtureIdentity.pid, startIdentity: fixtureIdentity.startIdentity }));
  fs.writeFileSync(path.join(root!, "fixture-owner.pid"), `${ownerPid ?? ""}\n`);
  fs.writeFileSync(path.join(root!, "fixture-owner.start"), `${ownerStart ?? ""}\n`);
  if (mode === "shortlive") {
    fs.writeFileSync(path.join(root, "release-drain"), "ready");
    fs.writeFileSync(path.join(root, "release-waiter"), "ready");
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
}
const { CodexSocketTransport } = await import("./codexSocketTransport");
const { spawnManagedEngine } = await import("./agentSignalSandbox");
const { AgentMemoryCell, tickAgentMemoryWatchdogs } = await import("./agentMemory");
const launcher = mode?.startsWith("managed") || mode?.startsWith("throw") ? "managed" : mode?.startsWith("shim") ? "shim" : undefined;
const directory = fs.openSync(root!, "r");
process.env.HOME = process.env.HOST_EXIT_TEST_HOME ?? `/proc/${process.pid}/fd/${directory}`;
if (mode === "replacement-read") {
  const owner = JSON.parse(fs.readFileSync(path.join(root!, "owner.json"), "utf8"));
  const transport = await CodexSocketTransport.reconnect(owner);
  const ended = new Promise(resolve => transport.once("exit", resolve));
  process.kill(owner.process.pid, "SIGKILL");
  await ended;
  process.stdout.write(JSON.stringify(readHostExit(owner.process)));
  process.exit(0);
}
const marker = path.join(root!, "ready");
const receipts = statePath("host-exits");
const beforeReceipts = new Set(fs.existsSync(receipts) ? fs.readdirSync(receipts) : []);
const clock = Date.now;
if (mode === "timeout" || mode === "ownership" || mode === "shortlive") Date.now = () => clock() + (fs.existsSync(marker) ? 11_000 : 0);
const peer = `
  const fs = require("node:fs");
  const writes = [];
  const write = (fd, text) => { const count = fs.writeSync(fd, text); writes.push({ requested: Buffer.byteLength(text), written: count }); return count; };
  const file = process.argv.at(-1).slice("unix://".length);
  const mode = process.env.PEER_MODE.replace(/^(managed|shim)/, "");
  write(2, "EADDRINUSE: callback bind refused\\n");
  if (["delayedexit", "delayedcontrol", "shortlive", "unlinked", "scheduler", "ownerloss"].includes(mode)) {
    const until = Date.now() + 3000;
    while (!fs.existsSync(process.env.DRAIN_ROOT + "/first")) {
      if (Date.now() > until) throw new Error("first drain read did not settle");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  write(2, "Bearer " + "private".repeat(8) + "\\n");
  write(2, process.env.HOME + "/private/file\\n");
  if (mode === "unlinked" || mode === "delayedexit" || mode === "delayedcontrol" || mode === "scheduler" || mode === "ownerloss" || mode === "exit" || mode === "large" || mode === "boundary" || mode === "secret") {
    if (mode === "large" || mode === "unlinked" || mode === "delayedexit" || mode === "delayedcontrol" || mode === "scheduler" || mode === "ownerloss") write(2, "x".repeat(20000) + "\\n");
    if (mode === "boundary") write(2, "Bearer " + "private".repeat(3000));
    if (mode === "secret") {
      // The key header and the first payload lines are visible; the footer is past the retained bytes.
      for (let line = 0; line < 6; line++) write(2, "x".repeat(100) + "\\n");
      write(2, "-----BEGIN PRIVATE KEY-----\\n");
      for (let line = 0; line < 150; line++) write(2, "KEYPAYLOAD" + String(line).padStart(3, "0") + "A".repeat(50) + "\\n");
      write(2, "-----END PRIVATE KEY-----\\n");
    }
    if (["delayedexit", "delayedcontrol", "unlinked", "scheduler", "ownerloss"].includes(mode)) fs.writeFileSync(process.env.DRAIN_ROOT + "/writes.json", JSON.stringify(writes));
    process.exit(23);
  }
  if (mode === "signal" || mode === "wrappedsignal") process.kill(process.pid, "SIGTERM");
  if (mode === "success" || mode === "chatty" || mode.startsWith("observed") || mode === "replacement-launch") {
    const server = Bun.serve({ unix: file,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response("fixture"); },
      websocket: { message(socket, message) {
        if (String(message) === "exit23") process.exit(23);
        if (String(message) === "flood") {
          // A chatty listener: far more than any storage bound.
          const chunk = "f".repeat(65536);
          for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) write(2, chunk);
          socket.send("flooded");
        } else socket.send(message);
      } },
    });
    fs.chmodSync(file, 0o600);
  }
  if (mode === "ownership") {
    const server = Bun.serve({ unix: file, fetch() { return new Response("fixture"); } });
    fs.chmodSync(file, 0o777);
  }
  fs.writeFileSync(process.env.PEER_MARKER, "ready");
  if (mode === "chatty") setInterval(() => {
    if (!fs.existsSync(process.env.PEER_MARKER + ".flood") || fs.existsSync(process.env.PEER_MARKER + ".flooded")) return;
    const chunk = "g".repeat(65536);
    for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) write(2, chunk);
    fs.writeFileSync(process.env.PEER_MARKER + ".flooded", "done");
  }, 10);
  if (mode === "wrapped") setInterval(() => {
    if (fs.existsSync(process.env.PEER_MARKER + ".release")) process.exit(23);
  }, 10);
  setInterval(() => {}, 1000);
`;
let sink: number | undefined;
let releaseDrainTimer: ReturnType<typeof setTimeout> | undefined;
let peerProcess: ChildProcessWithoutNullStreams | undefined;
let peerClosed = false;
const memory = mode === "observedmemory" ? new AgentMemoryCell({ mechanism: "watchdog", platform: "linux", unit: null,
  limitBytes: 1024 ** 3, budgetBytes: 1024 ** 3, reserveBytes: 0, totalBytes: 1024 ** 3, score: 500 } as AgentMemoryPlan) : null;
try {
  let command0 = mode === "missing" ? path.join(root!, "missing-binary") : process.execPath;
  const env0: NodeJS.ProcessEnv = { ...process.env, PEER_MODE: mode, PEER_MARKER: marker };
  if (launcher) for (const name of ["LLV_GATE_SLOT_LEASE", "LLV_SIGNAL_SANDBOX"]) delete env0[name];
  if (mode?.startsWith("throw")) {
    // A launcher whose setup fails after printing a key block: complete, or clipped past the retained bytes.
    const bin = path.join(root!, "launcher-bin"); fs.mkdirSync(bin, { recursive: true });
    const body = Array.from({ length: mode === "throwclipped" ? 300 : 20 }, (_, line) => `KEYPAYLOAD${String(line).padStart(3, "0")}${"A".repeat(50)}`).join("\n");
    fs.writeFileSync(path.join(root!, "launcher.stderr"), `EADDRINUSE: callback bind refused\nBearer ${"private".repeat(8)}\n${root}/private/file\n-----BEGIN PRIVATE KEY-----\n${body}\n${mode === "throwclipped" ? "" : "-----END PRIVATE KEY-----\n"}`);
    fs.writeFileSync(path.join(bin, "python3"), `#!/bin/sh\ncat '${path.join(root!, "launcher.stderr")}' > "$LLV_SIGNAL_DIAGNOSTIC"\nexit 9\n`, { mode: 0o755 });
    env0.PATH = `${bin}:${process.env.PATH}`;
  }
  if (launcher === "shim") {
    // The container's host CLI shim from the Dockerfile with python3 absent, so its own fallback runs.
    const bin = path.join(root!, "shim-bin"); fs.mkdirSync(bin, { recursive: true });
    const enter = path.join(root!, "enter"); fs.writeFileSync(enter, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o700 });
    const source = fs.readFileSync(path.resolve("Dockerfile"), "utf8").match(/make_nsenter_shim\(\) \{[\s\S]*?\n\}/)![0]
      .replace(/nsenter -t 1 -m -p -C --no-fork -- \/usr\/bin\/setpriv --reuid="\\\$uid" --regid="\\\$gid" --groups="\\\$groups" --/, `"${enter}"`)
      .replaceAll('"/usr/local/bin/$name"', `"${bin}/$name"`).replaceAll("/usr/bin/python3", path.join(root!, "absent", "python3"));
    const made = spawnSync("bash", ["-c", `${source}\nmake_nsenter_shim engine '${process.execPath}'`], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`shim fixture failed: ${made.stderr}`);
    command0 = path.join(bin, "engine");
    env0.LLV_DOCKER_NSENTER_SHIMS = "1";
  }
  const transport = await CodexSocketTransport.launch(command0, ["-e", peer], {
    detached: true, env: env0,
  }, undefined, async (command, args, options, base) => {
    // The production adapter the Codex host passes.
    if (launcher) return spawnManagedEngine(command, args, options, null, undefined, options.env ?? process.env, base);
    const diagnostic = path.join(root!, "wrapper.stderr");
    fs.rmSync(diagnostic, { force: true });
    peerProcess = (memory?.wrapSpawn(base) ?? base)(command, args, mode === "wrapped" || mode === "chatty" || delayed
      ? { ...options, env: { ...options.env, NODE_ENV: options.env?.NODE_ENV ?? "test", LLV_SIGNAL_DIAGNOSTIC: diagnostic } } : options);
    peerProcess.once("close", () => { peerClosed = true; });
    // The retained descriptor outlives the diagnostic name the transport unlinks.
    if (mode === "chatty" || delayed) sink = fs.openSync(fs.readlinkSync(diagnostic), "r");
    if (delayed) {
      const startup = path.dirname(args.at(-1)!.slice("unix://".length));
      const until = performance.now() + 3000;
      const completion = path.join(startup, "native-exit.json");
      if (mode === "delayedexit" || mode === "delayedcontrol" || mode === "unlinked" || mode === "scheduler" || mode === "ownerloss") {
        while (!fs.existsSync(completion)) {
          if (performance.now() > until) throw new Error("native exit did not become durable");
          await Bun.sleep(5);
        }
        while (!fs.existsSync(path.join(startup, "waiter-live")) || !fs.existsSync(path.join(root!, "delayed"))) {
          if (performance.now() > until) throw new Error("drain and waiter barriers did not become ready");
          await Bun.sleep(5);
        }
        initialSize = fs.fstatSync(sink!).size;
        nativeCompleted = JSON.parse(fs.readFileSync(completion, "utf8")).code === 23;
        waiterLive = peerProcess.exitCode === null && peerProcess.signalCode === null;
        if (mode === "ownerloss") {
          fs.writeFileSync(path.join(root!, "owned.json"), JSON.stringify(owned.map(child => child.identity)));
          fs.writeFileSync(path.join(root!, "ownerloss-ready"), "ready");
          await new Promise<void>(() => {});
        }
        if (mode === "scheduler") await Bun.sleep(250); // Simulate a delayed readiness observer while both owners are held.
        releaseDrainTimer = setTimeout(() => fs.writeFileSync(path.join(root!, "release-drain"), "ready"), mode === "scheduler" ? 500 : 250);
      }
      if (mode === "unlinked") {
        // Exercise successful-startup sink unlink while the collector is held.
        fs.unlinkSync(fs.readlinkSync(diagnostic));
      }
    }
    if (mode === "wrapped") {
      while (!fs.existsSync(marker)) await Bun.sleep(10);
      fs.unlinkSync(diagnostic);
      return new Proxy(peerProcess, { get(target, key) {
        if (key === "exitCode") fs.writeFileSync(`${marker}.release`, "release");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    if (mode === "wrappedsignal") await new Promise<void>(resolve => peerProcess!.once("close", () => resolve()));
    return peerProcess;
  });
  try {
    memory?.setExitProcess({ pid: transport.pid, startIdentity: transport.startIdentity, bootEpoch: transport.bootEpoch });
    if (mode === "replacement-launch") {
      const owner = { endpoint: transport.endpoint, process: { pid: transport.pid, startIdentity: transport.startIdentity, bootEpoch: transport.bootEpoch } };
      fs.writeFileSync(path.join(root!, "owner.json"), JSON.stringify(owner));
      transport.disconnect();
      process.stdout.write(JSON.stringify(owner));
      process.exit(0);
    }
    if (fs.existsSync(path.join(path.dirname(transport.endpoint.slice("codex-unix:".length)), "startup.stderr"))) {
      throw new Error("startup diagnostic name survived successful connection");
    }
    const echoed = new Promise<string>(resolve => transport.stdout.once("data", chunk => resolve(String(chunk).trim())));
    transport.stdin.write("probe\n");
    let detail = `connected: ${await echoed}`;
    if (mode === "chatty") {
      const flooded = new Promise<string>(resolve => transport.stdout.once("data", chunk => resolve(String(chunk).trim())));
      transport.stdin.write("flood\n");
      detail += `; ${await flooded}`;
      const sinkSize = () => fs.fstatSync(sink!).size;
      const afterConnected = sinkSize();
      transport.disconnect();
      fs.writeFileSync(`${marker}.flood`, "flood");
      while (!fs.existsSync(`${marker}.flooded`)) await Bun.sleep(10);
      // Let the drain settle on what it kept.
      await Bun.sleep(300);
      detail += `; sink ${afterConnected}/${sinkSize()}`;
    }
    if (mode?.startsWith("observed")) {
      const reader = transport as unknown as { processEnded(): void };
      const processEnded = reader.processEnded;
      if (mode === "observedreclaimed") reader.processEnded = () => {};
      const exited = new Promise<{code:number|null; signal:string|null}>(resolve => transport.once("exit", (code, signal) => resolve({code, signal})));
      if (mode === "observedmemory") { memory!.plan.limitBytes = 1; tickAgentMemoryWatchdogs([memory!]); }
      else if (mode === "observedsignal" || mode === "observedreclaimed") process.kill(transport.pid, "SIGKILL");
      else transport.stdin.write("exit23\n");
      const identity = { pid: transport.pid, startIdentity: transport.startIdentity, bootEpoch: transport.bootEpoch };
      let before: ReturnType<typeof readHostExit> | undefined;
      if (mode === "observedreclaimed") {
        if (!peerClosed) await new Promise<void>(resolve => peerProcess!.once("close", () => resolve()));
        before = readHostExit(identity);
        (await import("./hostExit")).reclaimHostExit(identity);
        reader.processEnded = processEnded;
        reader.processEnded();
      }
      const observed = await exited;
      const evidence = readHostExit(identity);
      detail = JSON.stringify({ observed, evidence, before });
    }
    process.stdout.write(JSON.stringify({ error: detail }));
  } finally {
    transport.disconnect();
    if (!peerClosed) {
      const stopped = new Promise<void>(resolve => peerProcess!.once("close", () => resolve()));
      if (peerProcess!.exitCode === null && peerProcess!.signalCode === null) transport.kill("SIGKILL");
      await stopped;
    }
  }
} catch (error) {
  let collection: object | undefined;
  if (delayed) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(owned.map(child => child.closed)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("owned startup children did not close")), 3000);
      })]);
      collection = { nativeCompleted, waiterLive, initialSize, size: fs.fstatSync(sink!).size,
        writes: mode === "shortlive" ? [] : JSON.parse(fs.readFileSync(path.join(root!, "writes.json"), "utf8")),
        ownerIdentityCheck: fs.existsSync(path.join(root!, "owner-identity-check"))
          ? fs.readFileSync(path.join(root!, "owner-identity-check"), "utf8") : null,
        children: owned.map(child => ({ identity: child.identity, status: processIdentityStatus(child.identity) })),
        childrenDead: owned.length === 2 && owned.every(child => processIdentityStatus(child.identity) === "dead") };
      if (process.env.STDERR_TEST_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.STDERR_TEST_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.STDERR_TEST_EVIDENCE_DIR, `${mode}.json`), JSON.stringify(collection));
      }
    } finally { clearTimeout(timer); }
  }
  const orphanReceipts = fs.existsSync(receipts) ? fs.readdirSync(receipts).filter(file => !beforeReceipts.has(file)).length : 0;
  process.stdout.write(JSON.stringify({ error: (error as Error).message, orphanReceipts, collection }));
} finally {
  clearTimeout(releaseDrainTimer);
  if (sink !== undefined) fs.closeSync(sink);
  memory?.close();
  Date.now = clock;
  fs.closeSync(directory);
}
