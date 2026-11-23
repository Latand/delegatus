import { RecordedCheckStore, rowSchema } from "./store";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { readEnvelope, writeEnvelope, digest, descriptorDigest, identitySchema } from "./wire";

const input = readEnvelope(process.argv[2]!) as { filename: string; output: string; row: unknown; count: number; sharedLaunch: boolean; hold?: boolean;
  terminalOwner?: "command" | "supervisor" | "producer-command" | "producer-supervisor" };
const template = rowSchema.parse(input.row);
const owner = identitySchema.parse(captureProcessIdentity(process.pid));
const store = new RecordedCheckStore(input.filename);
try {
  for (let index = 0; index < input.count; index++) {
    const id = digest(["capacity-holder", index]);
    const { wrapper: _wrapper, descriptorDigest: _digest, ...body } = template.descriptor;
    const descriptor = { ...body, runId: id, recorder: owner };
    const descriptorHash = descriptorDigest(descriptor);
    const report = { version: 1, runId: id, descriptorDigest: descriptorHash,
      supervisor: input.terminalOwner?.endsWith("supervisor") ? template.binding.host : owner,
      command: input.terminalOwner?.endsWith("command") ? template.binding.host : owner,
      kind: "portable", boundary: "direct", cancellation: null, service: null, commandExit: null, commandSignal: null,
      cleanup: "unknown", phase: "close", at: 1_790_000_000_001, atUptimeMs: 2 };
    const aggregate = input.terminalOwner?.startsWith("producer-") ? { ...report, supervisor: owner, command: owner, kind: "namespace" } : report;
    const result = input.terminalOwner ? { state: "terminal", reason: "owned command cleanup remains unknown",
      terminal: { version: 1, runId: id, descriptorDigest: descriptorHash,
        wrapperExit: 1, wrapperSignal: null, cancellation: null, closedAt: 1_790_000_000_002,
        closedUptimeMs: 3, report: aggregate, reports: [report, ...(aggregate === report ? [] : [aggregate])], dispatch: "started" },
      complete: false, visited: 0, completed: 0, failed: 0, evidence: [], evidenceDigest: digest([]), evidenceCount: 0,
      revision: 1, digest: digest(["unknown-close", id]), history: [] } : null;
    await store.write(rowSchema.parse({ ...template, id, request: digest(["capacity-request", index]), result,
      binding: { ...template.binding, host: !input.terminalOwner && index === 0 ? template.binding.host : owner,
        launch: input.sharedLaunch ? template.binding.launch : `holder-launch-${Math.floor(index / 4)}` },
      descriptor: { ...descriptor, wrapper: owner, descriptorDigest: descriptorHash },
    }), null);
  }
  writeEnvelope(input.output, { count: input.count, owner });
  if (input.hold) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capacity fixture release deadline")), 60_000);
    process.stdin.once("data", () => { clearTimeout(timer); process.stdin.pause(); resolve(); });
  });
} finally { store.close(); }
