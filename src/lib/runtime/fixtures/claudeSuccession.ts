import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRegistry, type StructuredHostClaimDecision } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { adoptClaudeRegistryHosts, adoptCodexRegistryHosts, demoteSkippedStructuredRegistryHosts, stopTerminalStructuredOrphan } from "../registry";

const [requestedMode, directory] = process.argv.slice(2);
const mode = requestedMode?.replace(/-held$/, "");
const file = (name: string) => path.join(directory!, name);
const key = { engine: "claude" as const, sessionId: "planned-succession" };
const waitFor = async (name: string) => {
  const deadline = performance.now() + 15_000;
  while (!fs.existsSync(file(name))) {
    if (performance.now() >= deadline) throw new Error(`fixture did not receive ${name}`);
    await Bun.sleep(5);
  }
};
const launch = (role: string) => {
  const child = spawn(process.execPath, [import.meta.path, role, directory!], {
    detached: true, stdio: ["ignore", "pipe", "inherit"], env: process.env,
  });
  fs.appendFileSync(file("processes.ndjson"), `${JSON.stringify(captureProcessIdentity(child.pid!))}\n`);
  return child;
};

if (mode === "job") {
  fs.appendFileSync(file("starts"), "started\n");
  await waitFor("finish-job");
  fs.appendFileSync(file("completions"), "completed\n");
  process.stdout.write("background-result\n");
} else if (mode === "native") {
  const job = launch("job");
  const result: Buffer[] = [];
  job.stdout!.on("data", chunk => result.push(chunk));
  const ended = new Promise<void>(resolve => job.once("close", () => resolve()));
  await waitFor("starts");
  fs.writeFileSync(file("native.json"), JSON.stringify({
    native: captureProcessIdentity(process.pid), child: captureProcessIdentity(job.pid!),
  }));
  await ended;
  // The agent consumes the native tool's output once, in the same process.
  // This fixture deliberately has no provider or live installation access.
  fs.appendFileSync(file("agent-results"), Buffer.concat(result));
  await waitFor("exit-native");
} else if (mode === "owner") {
  launch("native").unref();
  await waitFor("native.json");
  const native = JSON.parse(fs.readFileSync(file("native.json"), "utf8")).native;
  const registry = new AgentRegistry(file("registry.json"), undefined, undefined, { sqliteMode: "off" });
  registry.upsert({ key, artifactPath: file("planned-succession.jsonl"), cwd: directory!, accountId: null,
    status: "live", host: null, claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`, pendingAction: null,
    structuredHost: { kind: "claude-broker", endpoint: `stdio:${native.pid}`, process: native,
      writerClaimEpoch: 1, eventCursor: 1, activeTurnRef: "original-turn", protocolVersion: "fixture",
      pendingAttention: [], activeFlags: [] },
  });
  const conversation = registry.ensureConversation("claude", file("planned-succession.jsonl"), null);
  const snapshot = registry.readOnlySnapshot();
  // Fixed fixture identities make cross-process journal assertions deterministic.
  const raw = JSON.parse(fs.readFileSync(file("registry.json"), "utf8"));
  delete raw.conversations[conversation.id];
  raw.conversations.conversation_fixture = { ...snapshot.conversations[conversation.id], id: "conversation_fixture",
    generations: snapshot.conversations[conversation.id]!.generations.map(generation => ({ ...generation, id: key.sessionId })),
    turn: { state: "busy", source: "lifecycle", terminalAt: null, observedAt: "2026-01-01T00:00:00.000Z" } };
  fs.writeFileSync(file("registry.json"), JSON.stringify(raw));
  registry.rememberMembership("conversation_fixture", { kind: "pipeline", containerId: "pipeline_fixture",
    role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null });
  fs.writeFileSync(file("runtime-host.sock.lock"), JSON.stringify({
    ...captureProcessIdentity(process.pid), acquisitionId: "00000000-0000-0000-0000-000000000001",
  }));
  registry.close();
  fs.writeFileSync(file("owner-ready"), "ready");
  await waitFor("exit-owner");
  process.exit(0);
} else {
  if (mode === "codex-adoption") {
    const raw = JSON.parse(fs.readFileSync(file("registry.json"), "utf8"));
    const previous = raw.entries["claude:planned-succession"];
    delete raw.entries["claude:planned-succession"];
    raw.entries["codex:planned-succession"] = { ...previous, key: { ...key, engine: "codex" },
      structuredHost: { ...previous.structuredHost, kind: "codex-app-server" } };
    raw.conversations.conversation_fixture.engine = "codex";
    fs.writeFileSync(file("registry.json"), JSON.stringify(raw));
  }
  const registry = new AgentRegistry(file("registry.json"), undefined, undefined, { sqliteMode: "off" });
  fs.writeFileSync(file("runtime-host.sock.lock"), JSON.stringify({
    ...captureProcessIdentity(process.pid), acquisitionId: "00000000-0000-0000-0000-000000000002",
  }));
  if (requestedMode?.endsWith("-held")) {
    fs.writeFileSync(file("successor-ready"), "ready");
    await waitFor("recover-successor");
  }
  const claimDecision: StructuredHostClaimDecision = { refusal: null };
  let optionsCalls = 0;
  if (mode === "adoption") {
    await adoptClaudeRegistryHosts(registry, () => {
      optionsCalls++;
      throw new Error("fixture refuses a replacement engine");
    }, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" });
  } else if (mode === "codex-adoption") {
    await adoptCodexRegistryHosts(registry, () => { throw new Error("fixture refuses a replacement engine"); },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" });
  } else if (mode === "demotion") {
    await demoteSkippedStructuredRegistryHosts(registry, () => false);
  } else if (mode === "terminal") {
    registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true, decision: claimDecision });
    await stopTerminalStructuredOrphan(registry, key, {}, claimDecision);
  } else throw new Error("unknown fixture mode");
  const entry = registry.readOnlySnapshot().entries[`${mode === "codex-adoption" ? "codex" : "claude"}:planned-succession`]!;
  console.log(JSON.stringify({ optionsCalls, claimRefusal: claimDecision.refusal,
    claimEpoch: entry.claimEpoch, writerClaimEpoch: entry.structuredHost?.writerClaimEpoch,
    status: entry.status, activeTurnRef: entry.structuredHost?.activeTurnRef }));
  registry.close();
}
