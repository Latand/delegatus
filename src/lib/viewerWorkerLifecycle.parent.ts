import path from "node:path";
import { spawnViewerResidentWorker } from "./viewerWorkerLifecycle";

const child = spawnViewerResidentWorker(process.execPath, [path.join(import.meta.dir, "viewerWorkerLifecycle.child.ts")], {
  cwd: process.cwd(),
  env: process.env,
});
if (!child.pid) throw new Error("worker did not start");
console.log(child.pid);
setInterval(() => undefined, 60_000);
