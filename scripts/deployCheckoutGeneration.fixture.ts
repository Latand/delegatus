import fs from "node:fs";
import path from "node:path";
import { wrapAgentCommand, type AgentMemoryPlan } from "../src/lib/runtime/agentMemory";
import { CodexSocketTransport, type CodexSocketOwner } from "../src/lib/runtime/codexSocketTransport";
import { readHostExitWriterBinding } from "../src/lib/runtime/hostExit";
import { spawnNativeWaitOwner } from "../src/lib/runtime/nativeWaitOwner";
import { captureProcessIdentity, type ProcessIdentity } from "../src/lib/processIdentity";

const state = process.env.LLV_STATE_DIR!;
const plan = JSON.parse(fs.readFileSync(path.join(state, "fixture-plan.json"), "utf8"));
const hostFile = path.join(state, "fixture-hosts.json");
const ownerFile = path.join(state, "fixture-socket-owner.json");
const names = ["socket", "stdio"] as const;

function wrap(name: typeof names[number]) {
  const agent: AgentMemoryPlan = {
    mechanism: "scope", platform: "linux", limitBytes: 256 * 1024 * 1024,
    budgetBytes: 256 * 1024 * 1024, reserveBytes: 0, totalBytes: 0, score: 0,
    unit: plan.scopes[name], slice: plan.agentSlice, viewerUnit: plan.unit, systemdVersion: 255,
  };
  const args = ["--no-env-file", import.meta.path, "--engine", name];
  return wrapAgentCommand(name === "stdio" && plan.layout === "legacy" ? null : agent, process.execPath, args);
}

function row(stage: string, identity: ProcessIdentity) {
  const exitWriter = readHostExitWriterBinding(identity);
  if (!exitWriter) throw new Error("fixture engine has no writer receipt");
  return { conversationId: "fixture-" + stage, turnState: "busy", evidenceSource: "transcript",
    pipeline: { pipelineId: "fixture-pipeline", stageId: stage, attempt: 1 },
    host: { state: "alive", kind: "structured", pid: identity.pid, process: identity, exitWriter } };
}

async function ping(transport: CodexSocketTransport) {
  const message = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket turn heartbeat unavailable")), 3_000);
    transport.stdout.once("data", (data: Buffer) => { clearTimeout(timer); resolve(String(data)); });
    transport.stdin.write("fixture-turn-1\n");
  });
  fs.appendFileSync(path.join(state, "fixture-reconnect.jsonl"), message.trim() + "\n");
  transport.disconnect();
}

export async function generation() {
  if (fs.existsSync(hostFile)) {
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as CodexSocketOwner;
    if (plan.reconnect && process.cwd() === plan.releaseDir) await ping(await CodexSocketTransport.reconnect(owner));
    return;
  }
  const socket = wrap("socket");
  const transport = await CodexSocketTransport.launch(socket.command, socket.args, { detached: true, env: process.env });
  const processIdentity = captureProcessIdentity(transport.pid);
  fs.writeFileSync(ownerFile, JSON.stringify({ endpoint: transport.endpoint, process: processIdentity }), { mode: 0o600 });
  await ping(transport);
  const stdio = wrap("stdio");
  const waiter = spawnNativeWaitOwner(stdio.command, stdio.args, { env: process.env });
  waiter.stdout.resume();
  waiter.stderr.resume();
  await waiter.spawnReady;
  waiter.retainExit(true);
  const rows = [row("socket", processIdentity), row("stdio", captureProcessIdentity(waiter.pid!))];
  const temporary = hostFile + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600 });
  fs.renameSync(temporary, hostFile);
}

function engine(name: string) {
  let sequence = 0;
  const event = (kind: string) => fs.appendFileSync(path.join(state, "fixture-engine-" + name + ".jsonl"),
    JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + "\n");
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      event(signal);
      if (name === "stdio") process.exit(143);
    });
  }
  const tick = setInterval(() => { sequence++; }, 100);
  if (name === "socket") {
    const index = process.argv.indexOf("--listen");
    const unix = process.argv[index + 1]!.replace(/^unix:\/\//, "");
    Bun.serve({
      unix,
      fetch(request, server) { if (server.upgrade(request)) return; return new Response("fixture"); },
      websocket: { message(ws, turn) { ws.send(JSON.stringify({ turn, sequence, pid: process.pid })); } },
    });
    fs.chmodSync(unix, 0o600);
    process.stderr.write("fixture socket engine booted\n");
  } else {
    process.stdin.resume();
    process.stdin.on("end", () => { event("EOF"); clearInterval(tick); process.exit(0); });
  }
  event("ready");
}

if (process.argv.includes("--engine")) engine(process.argv[process.argv.indexOf("--engine") + 1]!);
