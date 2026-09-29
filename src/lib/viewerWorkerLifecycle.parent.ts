import path from "node:path";
import { spawnViewerResidentWorker } from "./viewerWorkerLifecycle";

const entry = process.env.LLV_TEST_WORKER_ENTRY || path.join(import.meta.dir, "viewerWorkerLifecycle.child.ts");
const child = spawnViewerResidentWorker(process.execPath, [entry], {
  cwd: process.cwd(),
  env: process.env,
});
if (!child.pid) throw new Error("worker did not start");
console.log(child.pid);
setInterval(() => undefined, 60_000);
