import { RecordedCheckStore, rowSchema } from "./store";
import { readEnvelope, writeEnvelope, digest, descriptorDigest } from "./wire";

const input = readEnvelope(process.argv[2]!) as {
  filename: string; output: string; row: unknown; start: number; count: number; sharedLaunch: boolean;
};
const template = rowSchema.parse(input.row);
const store = new RecordedCheckStore(input.filename);
let refusal: string | null = null;
try {
  for (let index = input.start; index < input.start + input.count; index++) {
    const id = digest(["storage-fixture", index]);
    const { wrapper, descriptorDigest: _digest, ...descriptor } = template.descriptor;
    const bound = { ...descriptor, runId: id };
    const row = rowSchema.parse({ ...template, id, request: digest(["request", index]), revision: 1,
      descriptor: { ...bound, wrapper, descriptorDigest: descriptorDigest(bound) },
      binding: { ...template.binding, launch: input.sharedLaunch ? "one-launch" : `launch-${Math.floor(index / 4)}` },
    });
    try { await store.write(row, null); }
    catch (error) { refusal = error instanceof Error ? error.message : String(error); break; }
  }
  let cursor = "", count = 0;
  for (;;) {
    const page = store.page(cursor);
    for (const row of page) { rowSchema.parse(row); cursor = row.id; count++; }
    if (page.length < 32) break;
  }
  writeEnvelope(input.output, { count, refusal, rootsHeld: template.descriptor.manifest.roots.every(root => store.rootHeld(root.directory)) });
} finally { store.close(); }
