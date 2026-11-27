"use client";

import { GLOBAL_RUNTIME_GATES, RUNTIME_DEPLOYMENTS } from "@/hooks/runtimeSubscriptions";
import { memo, useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useRuntimeSelector } from "@/hooks/useRuntime";
import type { RuntimeSnapshot, ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { Z } from "@/components/layers";

/* The viewer-deploy status is internal operator information (issue #177 item 6).
   It stays out of the app interface by default and never appears on the phone.
   Set `NEXT_PUBLIC_LLV_SHOW_DEPLOY_PILL=1` to surface it on desktop for deploy
   debugging. */
function deployPillEnabled(): boolean {
  return (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_SHOW_DEPLOY_PILL : undefined) === "1";
}

export const DeploymentStatusPill = memo(function DeploymentStatusPill() {
  const isMobile = useIsMobile();
  const show = !isMobile && deployPillEnabled();
  const enabled = useRuntimeSelector(state => state.enabled, false, Object.is, show, GLOBAL_RUNTIME_GATES);
  const liveDeployments = useRuntimeSelector(state => state.store.deployments, null, Object.is, show && enabled, RUNTIME_DEPLOYMENTS);
  const [snapshotDeployments, setSnapshotDeployments] = useState<ViewerDeploymentStatus[]>([]);
  useEffect(() => {
    if (enabled || !show) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/runtime/snapshot", { headers: { accept: "application/json" } });
        if (!response.ok) return;
        const snapshot = await response.json() as RuntimeSnapshot;
        if (active) setSnapshotDeployments(snapshot.deployments);
      } catch { /* runtime host may be disabled */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled, show]);
  const deployments = enabled && liveDeployments ? Object.values(liveDeployments) : snapshotDeployments;
  const deployment = [...deployments].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!show || !deployment) return null;
  const label = deployment.phase.replaceAll("-", " ");
  const tone = deployment.phase === "succeeded"
    ? "border-success/45 text-success"
    : deployment.phase === "failed" || deployment.phase === "rolled-back"
      ? "border-danger/45 text-danger"
      : "border-accent/45 text-accent";
  return (
    /* Purely informational and desktop-only — never a hit-target.
       `pointer-events-none` guards taps through it, and the safe-area inset lifts
       it clear of the home bar. */
    <div
      className={`pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 ${Z.toast} max-w-[calc(100vw-1.5rem)] -translate-x-1/2 truncate rounded-full border bg-raised px-3 py-1 text-[11px] font-semibold shadow-2 backdrop-blur ${tone}`}
      role="status"
      title={deployment.error ?? `Revision ${deployment.revision.slice(0, 12)}`}
    >
      Viewer deploy · {label} · {deployment.revision.slice(0, 7)}
    </div>
  );
});
