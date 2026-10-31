import "@/lib/testing/fixtureLifetime";
import { AgentRegistry, RegistryWriterBusyError } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHostUnavailableError, type RuntimeHostClient } from "../client";
import { DeliveryProgressStore } from "../deliveryProgress";
import { enqueueStructuredMessage } from "../structuredMessageDelivery";

const [registryFile, journalFile, artifactPath, mode, pauseAt] = process.argv.slice(2);
if (!registryFile || !journalFile || !artifactPath || !["cutoff", "lost-ack", "delivered"].includes(mode!)) {
  throw new Error("admission cutoff writer arguments are incomplete");
}
const registry = new AgentRegistry(registryFile);
const journal = new RuntimeJournal(journalFile, { structuredHosts: true, now: () => Date.parse("2026-07-13T00:00:00Z") });
const conversation = registry.conversationForPath(artifactPath)!;
let commands = 0;
async function pause(): Promise<void> {
  process.send!("paused");
  if ((await new Response(Bun.stdin).text()).trim() !== "release") throw new Error("cutoff writer was not released");
}
if (mode === "cutoff" && pauseAt === "settlement") {
  const write = registry.deliveryWrite.bind(registry);
  registry.deliveryWrite = async (correlation, commit, correlate) => {
    if (correlation.label === "delivery.admission-cutoff") await pause();
    return write(correlation, commit, correlate);
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
