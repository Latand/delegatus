import { claimMaintenanceRun, patchMaintenanceRun } from "./store";
const result = claimMaintenanceRun({ project: "fixture-maintenance", now: Number(process.argv[2]), intervalHours: 3, seat: { seatEpoch: 1, conversationId: "fixture-seat" }, repoDir: "/fixtures/repository" });
if (process.argv[3] === "settle" && result.claimed) patchMaintenanceRun(result.run.runId, { state: "succeeded", endedAt: new Date(Number(process.argv[2])).toISOString() });
process.stdout.write(JSON.stringify(result));
