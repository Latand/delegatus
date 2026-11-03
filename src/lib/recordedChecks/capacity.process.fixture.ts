import { RecordedCheckStore, rowSchema } from "./store";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { readEnvelope, writeEnvelope, digest, descriptorDigest, identitySchema } from "./wire";

const input = readEnvelope(process.argv[2]!) as { filename: string; output: string; row: unknown; count: number; sharedLaunch: boolean; hold?: boolean };
const template = rowSchema.parse(input.row);
const owner = identitySchema.parse(captureProcessIdentity(process.pid));
const store = new RecordedCheckStore(input.filename);
try {
  for (let index = 0; index < input.count; index++) {
    const id = digest(["capacity-holder", index]);
    const { wrapper: _wrapper, descriptorDigest: _digest, ...body } = template.descriptor;
    const descriptor = { ...body, runId: id, recorder: owner };
    await store.write(rowSchema.parse({ ...template, id, request: digest(["capacity-request", index]),
      binding: { ...template.binding, host: index === 0 ? template.binding.host : owner,
        launch: input.sharedLaunch ? template.binding.launch : `holder-launch-${Math.floor(index / 4)}` },
      descriptor: { ...descriptor, wrapper: owner, descriptorDigest: descriptorDigest(descriptor) },
    }), null);
  }
  writeEnvelope(input.output, { count: input.count, owner });
  if (input.hold) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capacity fixture release deadline")), 60_000);
    process.stdin.once("data", () => { clearTimeout(timer); process.stdin.pause(); resolve(); });
  });
} finally { store.close(); }
