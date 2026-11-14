import fs from "node:fs";
import { waitForStateLock } from "@/lib/state/lockWait";
import { parseMaintenanceReport } from "./text";
import { claimMaintenanceRun, patchMaintenanceRun, readMaintenanceRun, settleMaintenanceAudit } from "./store";
if (process.argv[3] === "audit-settle") {
  const result = await waitForStateLock("fixture.audit.settle", () => {
    const run = readMaintenanceRun(process.argv[4]);
    return run?.audit ? settleMaintenanceAudit(run, { state: "succeeded", log: { ...run.log, ...parseMaintenanceReport(fs.readFileSync(process.argv[5], "utf8"), run.audit) } }) : null;
  });
  process.stdout.write(JSON.stringify(result));
} else {
  const result = await waitForStateLock("fixture.maintenance.claim", () => claimMaintenanceRun({ project: "fixture-maintenance", now: Number(process.argv[2]), intervalHours: 3, seat: { seatEpoch: 1, conversationId: "fixture-seat" }, repoDir: "/fixtures/repository" }));
  if (process.argv[3] === "settle" && result.claimed) patchMaintenanceRun(result.run.runId, { state: "succeeded", endedAt: new Date(Number(process.argv[2])).toISOString() });
  process.stdout.write(JSON.stringify(result));
}
