import { statePath } from "@/lib/configDir";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { SqliteMcpReceiptStore, recoveryAnswer, type McpToolName } from "./server";
import { viewerMcpRecoverableTools } from "./bindings";

/** One serving-release pass; no adapter or task child owns a clock. */
export async function reconcileLaunchAdmissions(assertRelease: () => void = () => {
  if (!viewerReleaseOwnsTraffic()) throw new Error("admission recovery lost release authority");
}) {
  const deadlineAt = Date.now() + 5000;
  const assert = () => { assertRelease(); if (Date.now() >= deadlineAt) throw new Error("admission recovery budget elapsed"); };
  assert();
  const store = new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite"), { busyTimeoutMs: 0, preparedOnly: true });
  let visited = 0, resolved = 0, failed = 0;
  try {
    assert(); store.prepareLaunchClaims(100, assert);
    const position = store.recoveryPosition();
    const rows = store.dueLaunchClaims(Date.now(), position);
    const tools = viewerMcpRecoverableTools();
    for (const row of rows) {
      assert(); visited++;
      try {
        if (row.launch_due === null || row.launch_due > Date.now() || row.launch_next_attempt > Date.now()) continue;
        const record = store.lookup(row.receipt_key);
        if (!record?.binding?.launchAdmission || record.result) continue;
        const binding = record.binding;
        if (record.stage === "claimed") {
          const answer = recoveryAnswer(binding.toolName, binding.clientRequestId, { outcome: "not-executed", evidence: "mcp-receipt",
            reason: "admission deadline elapsed before dispatch; the attempt is permanently closed", ids: {} }, true);
          if (store.fenceUndispatched(row.receipt_key, record.digest, answer, binding, assert)) resolved++;
          continue;
        }
        const tool = tools[binding.toolName as McpToolName];
        if (!tool) continue;
        const evidence = await tool.recover(binding, { legacy: false, context: { assertCaller: assert, deadlineAt } });
        assert();
        if (evidence.outcome === "settled" || evidence.outcome === "not-executed") {
          store.settle(row.receipt_key, record.digest, recoveryAnswer(binding.toolName, binding.clientRequestId, evidence, true),
            evidence.outcome === "not-executed" ? "not-executed" : "settled", true, binding, assert);
          resolved++;
        } else if (evidence.outcome === "accepted" || evidence.outcome === "in-flight") {
          store.confirmLaunchAdmission(row.receipt_key, binding, assert); resolved++;
        } else {
          failed++; store.admissionFailure(row.receipt_key, "evidence-unavailable", Date.now() + 5000, assert);
        }
      } catch {
        failed++;
        assert(); store.admissionFailure(row.receipt_key, "admission-unavailable", Date.now() + 5000, assert);
      } finally {
        assert(); store.recoveryPosition(row.sequence, assert);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    if (rows.length === 0) { assert(); store.recoveryPosition(0, assert); }
    return { visited, resolved, failed };
  } finally { store.close(); }
}

const SLOT = Symbol.for("delegatus.mcp.admissionRecovery");
const host = globalThis as typeof globalThis & { [SLOT]?: ReturnType<typeof setTimeout> };
export function startLaunchAdmissionRecovery(): void {
  if (host[SLOT]) return;
  const arm = () => {
    const timer = setTimeout(() => {
      void withViewerOperation("mcp.admission-recovery", async () => {
        if (!viewerReleaseOwnsTraffic()) return;
        const counts = await reconcileLaunchAdmissions();
        console.error(JSON.stringify({ event: "mcp.admission-recovery", ...counts }));
      }).catch(() => console.error(JSON.stringify({ event: "mcp.admission-recovery", code: "pass-unavailable" })))
        .finally(() => {
          if (host[SLOT] !== timer) return;
          host[SLOT] = undefined;
          if (viewerReleaseOwnsTraffic()) arm();
        });
    }, 5000);
    timer.unref?.(); host[SLOT] = timer;
  };
  arm();
}
