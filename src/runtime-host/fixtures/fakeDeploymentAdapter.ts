/* The deployment adapter the coordinator tests drive: every step recorded in
   `calls`, the serving release in `current`, each answer settable. Shared by
   the coordinator's own tests and the candidate gate's, which hand it the
   gate's real verdict. */

import type {
  ViewerHealthEvidence,
  ViewerMcpRuntimeIdentity,
  ViewerMcpRuntimePublicationEvidence,
  ViewerMcpRuntimeReconciliation,
  ViewerReleaseIdentity,
  ViewerRuntimeHostHandoffEvidence,
  ViewerRuntimeHostStartupPhase,
} from "@/lib/runtime/contracts";

import type { ViewerDeploymentAdapter } from "../deployment";

export function release(revision: string, label: string): ViewerReleaseIdentity {
  return { revision, image: `viewer:${revision}`, container: `viewer-${label}`, endpoint: `http://127.0.0.1/${label}` };
}

export function healthy(endpoint: string): ViewerHealthEvidence {
  return {
    checkedAt: "2026-07-11T12:00:00.000Z",
    endpoint,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [{ path: "/_next/static/app.js", status: 200 }, { path: "/_next/static/app.css", status: 200 }],
    ok: true,
  };
}

export class FakeDeploymentAdapter implements ViewerDeploymentAdapter {
  current = release("old", "old");
  currentMcp: ViewerMcpRuntimeIdentity = {
    source: "legacy" as const,
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  resolveGate: Promise<void> | null = null;
  resolveFailures = 0;
  buildGate: Promise<void> | null = null;
  candidateHealth = healthy("http://127.0.0.1/candidate");
  promotedHealth = healthy("http://127.0.0.1:8898");
  stageHostFailure: Error | null = null;
  verifyHostFailure: Error | null = null;
  promoteFailure: Error | null = null;
  hotStateHandOver: string | null = null;
  candidateOutput = ["startup failed before hot-state activation"];
  servingProgress(): string | null { return "waiting for serving readiness; HTTP rejection pending"; }
  calls: string[] = [];

  async reconcile(): Promise<void> { this.calls.push("reconcile"); }
  async verifyRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<ViewerRuntimeHostHandoffEvidence> {
    this.calls.push(`verify-host-successor:${candidate.image}:${candidate.revision}`);
    if (this.verifyHostFailure) throw this.verifyHostFailure;
    const generation = {
      image: candidate.image,
      revision: candidate.revision,
      container: `runtime-host-${candidate.revision.slice(0, 12)}`,
    };
    const identity = { generation, pid: 4242, startIdentity: "4242:successor", hostEpoch: 7 };
    const phases: ViewerRuntimeHostStartupPhase[] = [
      "fence-waiting",
      "fence-acquired",
      "journal-open",
      "handoff-cleanup-complete",
      "consumers-recovered",
      "socket-listening",
      "ready",
    ];
    return {
      ...identity,
      phases: phases.map((phase, index) => ({ ...identity, phase, recordedAt: `2026-08-31T14:00:0${index}.000Z` })),
      probe: {
        checkedAt: "2026-08-31T14:00:08.000Z",
        requestId: "runtime-host-health-probe",
        responseId: "runtime-host-health-probe",
        elapsedMs: 12,
      },
    };
  }
  async stageRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<void> {
    this.calls.push(`stage-host-successor:${candidate.image}:${candidate.revision}`);
    if (this.stageHostFailure) throw this.stageHostFailure;
  }
  async resolveRevision(revision: string): Promise<string> {
    this.calls.push(`resolve:${revision}`);
    await this.resolveGate;
    if (this.resolveFailures > 0) { this.resolveFailures -= 1; throw new Error("revision resolution timed out"); }
    return revision === "origin/main" || revision.startsWith("refs/heads/") ? "a".repeat(40) : revision;
  }
  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    this.calls.push(`build:${revision}`);
    await this.buildGate;
    return {
      ...release(revision, deploymentId),
      mcpRuntime: {
        source: "managed",
        revision,
        releaseId: `deploy-${deploymentId}`,
        artifactDigest: "7".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
    };
  }
  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`start:${candidate.container}`); }
  async currentRelease(): Promise<ViewerReleaseIdentity | null> { this.calls.push("current"); return this.current; }
  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> { this.calls.push(`verify-candidate:${candidate.container}`); return this.candidateHealth; }
  async currentMcpRuntime() { this.calls.push("current-mcp"); return this.currentMcp; }
  async reconcileMcpRuntime(revision: string): Promise<ViewerMcpRuntimeReconciliation> {
    this.calls.push(`reconcile-mcp-runtime:${revision}`);
    return {
      publication: {
        action: "activate",
        source: "managed",
        revision,
        releaseId: "deploy-reconciled",
        artifactDigest: "9".repeat(64),
        stagedAt: "2026-07-23T08:00:03.000Z",
        publishedAt: "2026-07-23T08:00:04.000Z",
        durable: true,
      },
      health: {
        checkedAt: "2026-07-23T08:00:05.000Z",
        revision,
        artifactDigest: "9".repeat(64),
        processReady: true,
        tools: ["deployment_status", "board_snapshot"],
        calls: { deploymentStatus: true, boardSnapshot: true },
        ok: true,
      },
    };
  }
  async promote(candidate: ViewerReleaseIdentity): Promise<ViewerMcpRuntimePublicationEvidence> {
    this.calls.push(`promote:${candidate.container}`);
    if (this.promoteFailure) throw this.promoteFailure;
    this.current = candidate;
    this.currentMcp = candidate.mcpRuntime!;
    return {
      action: "activate",
      ...candidate.mcpRuntime!,
      publishedAt: "2026-07-23T08:00:01.000Z",
      durable: true,
      ...(this.hotStateHandOver ? { hotStateHandOver: this.hotStateHandOver } : {}),
    };
  }
  async verifyPromoted(candidate: ViewerReleaseIdentity, _signal?: AbortSignal): Promise<ViewerHealthEvidence> { this.calls.push(`verify-promoted:${candidate.container}`); return this.promotedHealth; }
  async candidateLog(candidate: ViewerReleaseIdentity): Promise<string[]> {
    this.calls.push(`candidate-log:${candidate.container}`);
    return this.candidateOutput;
  }
  async rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<ViewerMcpRuntimePublicationEvidence> {
    this.calls.push(`rollback:${candidate.container}`);
    this.current = previous;
    this.currentMcp = previous.mcpRuntime ?? {
      source: "legacy",
      revision: "8".repeat(40),
      releaseId: null,
      artifactDigest: "8".repeat(64),
      stagedAt: null,
    };
    return {
      action: "restore",
      ...this.currentMcp,
      publishedAt: "2026-07-23T08:00:02.000Z",
      durable: true,
    };
  }
  async retire(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`retire:${candidate.container}`); }
  async retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> { this.calls.push(`retain-only:${releases.map((item) => item.container).join(",")}`); }
}
