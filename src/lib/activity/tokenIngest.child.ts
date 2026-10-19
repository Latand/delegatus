import fs from "node:fs";
import { ActivityStore } from "./store";
import { ingestTranscripts, type IngestSource } from "./ingest";
import { maintainUsage, usageMeta } from "./tokenStore";
const [database, inventory, budget, batch] = process.argv.slice(2);
const sources = JSON.parse(fs.readFileSync(inventory!, "utf8")) as IngestSource[];
const store = ActivityStore.open(database!);
try {
  if (budget?.startsWith("maintain:")) {
    store.transaction(()=>maintainUsage(store.db,Date.parse("2026-10-18T12:00:00Z"),budget.slice("maintain:".length)));
    process.stdout.write(JSON.stringify(usageMeta(store.db)));
  } else {
    const result = await ingestTranscripts(sources, { store, complete: true, listedAt: Date.parse("2026-10-18T12:00:00Z"),
      now: () => Date.parse("2026-10-18T12:00:00Z"), budgetBytes: Number(budget),
      ...(batch?{batchBytes:Number(batch)}:{}),
      resolver: () => () => ({ project: "fixture", registered: true, launch: "pipeline", mode: "team",
        agent: { role: "builder", pipelineId: "pipeline-a", stageId: "build" },
        usageAttribution: () => ({ member: "member-a", account: "account-a", model: null, tier: null }) }) });
    process.stdout.write(JSON.stringify(result));
  }
} finally { store.close(); }
