import { waitForStateLock } from "./lockWait";
import fs from "node:fs";

import { loadFlows, saveFlowsAsync as saveFlows } from "@/lib/flows/store";

const [resultFile, action = "read", readyFile, releaseFile] = process.argv.slice(2);
if (!resultFile) throw new Error("hot-state authority child result path is required");

try {
  const flows = await waitForStateLock("flows.open", loadFlows);
  if (readyFile && releaseFile) {
    fs.writeFileSync(readyFile, "read");
    const deadline = performance.now() + 10_000;
    while (!fs.existsSync(releaseFile)) {
      if (performance.now() >= deadline) throw new Error("flow writer fixture release timed out");
      await Bun.sleep(5);
    }
  }
  if (action === "write" && flows[0]) {
    flows[0].stateDetail = "late-portless-write";
    await saveFlows(flows);
  }
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: true,
    records: flows.map((flow) => ({
      id: flow.id,
      stateDetail: flow.stateDetail,
      model: flow.roles.implementer.model,
    })),
  }));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}
