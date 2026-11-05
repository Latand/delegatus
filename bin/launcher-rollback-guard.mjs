// This child survives exec into a prior launcher that cannot read deadlines.
// It signals only its recorded parent identity and that parent's recorded
// serving children; native agents remain outside that ownership.
import { readFileSync } from "node:fs";
import { readStartIdentity } from "./self-update-supervisor.mjs";
import { stopRecorded } from "./launcher-adoption.mjs";
import { writeLauncherRefusal } from "./launcher-deadline.mjs";

const plan = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
if (!Number.isSafeInteger(plan.pid) || plan.pid <= 1 || typeof plan.identity !== "string"
  || !Number.isFinite(plan.deadline)) throw new Error("Invalid rollback guard owner");
const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
process.stdout.end("ready\n");
while (readStartIdentity(plan.pid) === plan.identity) {
  const trial = read(plan.paths.trial), record = read(plan.paths.record);
  const same = record?.launcher?.pid === plan.pid && record.launcher.startIdentity === plan.identity;
  const predecessor = record?.launcher?.pid === plan.recordOwner?.pid
    && record?.launcher?.startIdentity === plan.recordOwner?.startIdentity;
  if (Number.isSafeInteger(record?.launcher?.pid) && typeof record.launcher.startIdentity === "string" && !same && !predecessor) break;
  // Sample the completion timestamp as well: a timely old launcher remains
  // timely if this observer is scheduled after its deadline.
  if (same && record.web?.state === "healthy" && record.runtimeHost?.state === "healthy"
    && (!record.launcher.state || record.launcher.state === "healthy")
    && record.web.pid && record.web.startIdentity && record.runtimeHost.pid && record.runtimeHost.startIdentity
    && readStartIdentity(record.web.pid) === record.web.startIdentity
    && readStartIdentity(record.runtimeHost.pid) === record.runtimeHost.startIdentity
    && Date.parse(record.updatedAt) < plan.deadline) break;
  if (!trial || trial.requestId !== plan.requestId || trial.target !== plan.target) break;
  if (Date.now() >= plan.deadline) {
    if (trial?.requestId !== plan.requestId || trial.target !== plan.target || trial.state !== "rolled-back") break;
    const detail = "The launcher rollback exceeded its 10 minute deadline";
    const refused = writeLauncherRefusal(plan.paths, { ...trial, switchOverrun: trial.switchOverrun ?? detail }, detail);
    console.error(`[self-update] launcher startup refused: ${refused.detail}`);
    if (readStartIdentity(plan.pid) !== plan.identity) break;
    // An old image has no deadline handler. Ending this exact launcher is a
    // refusal; its manager may retry through the restored release pointer.
    try { process.kill(plan.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (same) await Promise.all([
      stopRecorded(record.web, record.socket, record.port, plan.installRoot, plan.paths.releasePointer),
      stopRecorded(record.runtimeHost, record.socket),
    ]);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, Math.min(100, plan.deadline - Date.now())));
}
