import "@/lib/testing/fixtureLifetime";
import { spawnSync } from "node:child_process";
import { AgentRegistry, RegistryWriterBusyError } from "@/lib/agent/registry";
import { processIdentityMayOwn } from "@/lib/processIdentity";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHostUnavailableError, type RuntimeHostClient } from "../client";
import { DeliveryProgressStore } from "../deliveryProgress";
import { enqueueStructuredMessage } from "../structuredMessageDelivery";

const [registryFile, journalFile, artifactPath, mode, pauseAt] = process.argv.slice(2);
if (!registryFile || !journalFile || !artifactPath || !["cutoff", "lost-ack", "delivered"].includes(mode!)) {
  throw new Error("admission cutoff writer arguments are incomplete");
}
const registry = new AgentRegistry(registryFile, owner => {
  // A JSON lock contender checks the recorded holder before waiting. Keep
  // the real liveness verdict and let the parent release the cutoff writer.
  if (pauseAt === "mutation" && mode !== "cutoff") process.send!("contending");
  return processIdentityMayOwn(owner);
});
const journal = new RuntimeJournal(journalFile, { structuredHosts: true, now: () => Date.parse("2026-07-13T00:00:00Z") });
const conversation = registry.conversationForPath(artifactPath)!;
let commands = 0;
async function pause(): Promise<void> {
  process.send!("paused");
  if ((await new Response(Bun.stdin).text()).trim() !== "release") throw new Error("cutoff writer was not released");
}
function pauseAtMutation(): void {
  process.send!("paused");
  // The production callback is synchronous. A stdin barrier stops it at
  // the mutation entry while the other enqueue process reaches the lock.
  const barrier = spawnSync(process.execPath, ["-e", 'if ((await Bun.stdin.text()).trim() !== "release") process.exit(1)'],
    { stdio: ["inherit", "ignore", "pipe"] });
  if (barrier.status !== 0) throw new Error(`mutation barrier failed: ${barrier.stderr}`);
}
if (mode === "cutoff" && pauseAt === "settlement") {
  const write = registry.deliveryWriteNow.bind(registry);
  registry.deliveryWriteNow = (correlation, commit, options) => {
    if (correlation.label === "delivery.admission-cutoff") pauseAtMutation();
    return write(correlation, commit, options);
  };
}
if (mode === "cutoff" && pauseAt === "mutation") {
  const settle = registry.recordDeliveryOutcome.bind(registry);
  registry.recordDeliveryOutcome = (...args) => {
    pauseAtMutation();
    return settle(...args);
  };
}
const client = {
  readSession: async () => journal.readSession({ conversationId: conversation.id }),
  operationStatus: async () => { throw new Error("journal status unavailable"); },
  command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
    commands += 1;
    const admitted = journal.executeOperation(command);
    if (admitted.receipt.status !== "queued") throw new Error("command was not queued");
    journal.transitionOperation(admitted.operationId, "delivering");
    const delivered = journal.transitionOperation(admitted.operationId, "delivered");
    if (mode === "lost-ack") throw new RuntimeHostUnavailableError("runtime host request timed out");
    return delivered;
  },
} as unknown as RuntimeHostClient;
try {
  const result = await enqueueStructuredMessage({
    path: artifactPath, conversationId: conversation.id, clientMessageId: "concurrent-cutoff",
    operationId: "concurrent-cutoff", text: "Stage work",
  }, {
    enabled: () => true, registry: () => registry, client: () => client, kick: () => {},
    progress: new DeliveryProgressStore(null),
    authorizeDispatch: async () => {
      if (mode !== "cutoff") return;
      if (pauseAt === "authorization") await pause();
      throw new RegistryWriterBusyError("spawn admission", "lane deadline exhausted");
    },
  });
  process.stdout.write(JSON.stringify({ result, commands }));
} finally {
  journal.close();
  registry.close();
  process.disconnect?.();
}
