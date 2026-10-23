import fs from "node:fs";
import path from "node:path";
import { SelfUpdateService, type ServiceDeps } from "./service";

const directory = process.argv[2]!;
const now = Number(process.argv[3]);
const record = JSON.parse(fs.readFileSync(path.join(directory, "launcher.json"), "utf8"));
const service = new SelfUpdateService({
  dir: directory, env: {}, now: () => now,
  mode: async () => ({ mode: "checkout", record, reason: null }),
  prune: async () => {
    fs.appendFileSync(path.join(directory, "passes"), "pass\n");
    fs.writeFileSync(path.join(directory, "retention.json"), JSON.stringify({ at: new Date(now).toISOString() }));
  },
} as unknown as ServiceDeps);
await service.retentionTick();
service.stop();
