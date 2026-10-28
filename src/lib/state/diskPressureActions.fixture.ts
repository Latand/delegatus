import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { diskVolumes, observeDiskPressureReport } from "./diskPressure";
import { productionDiskPressureActions, reconcileDiskPressure } from "./diskPressureActions";
import { writeJsonDurably } from "./durableJson";
import { loadTasksForList } from "@/lib/tasks/store";
import { readBridgeReportLog } from "@/lib/bridge/store";

const [at, free] = process.argv.slice(2);
const pressure = observeDiskPressureReport(statePath("disk-pressure-report.json"), () => diskVolumes([
  { role: "state", directory: statePath() },
], () => ({ volume: "fixture", totalBytes: 1742 * 1024 ** 3, freeBytes: Number(free) * 1024 ** 3 })), at!);
pressure.consumers = [{ kind: "temp", bytes: 30 * 1024 ** 3, measuredAt: at! }];
writeJsonDurably(statePath("disk-pressure-report.json"), pressure);
const ports = productionDiskPressureActions();
ports.project = async () => "repo-1234abcd";
ports.early = () => fs.appendFileSync(statePath("early-passes.ndjson"), at + "\n");
await reconcileDiskPressure(pressure, ports);
console.log(JSON.stringify({ cards: loadTasksForList(statePath("tasks.json")), reports: readBridgeReportLog() }));
