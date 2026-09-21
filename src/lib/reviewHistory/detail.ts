import { archiveArtifacts } from "./archiveArtifacts";
import { archiveProjects, reviewHistorySelectionSource } from "./reader";
import { flowRelayedMessageOccurrences } from "./relayProvenance";
import { redactArchive } from "./redaction";

export function readReviewHistory(id: string, exported = false) {
  const source = reviewHistorySelectionSource();
  try {
    const raw = source.raw(id);
    if (!raw) return null;
    const flow = source.read(id)!;
    const artifacts = archiveArtifacts(source.directory, flow, exported);
    const last = flow.rounds.at(-1);
    const relayOccurrences = flowRelayedMessageOccurrences(flow.implementerPath, {
      flows: () => [flow],
      findings: (_flow, round) => {
        const artifact = artifacts.find(item => item.round === round.n)?.artifacts.findings;
        return artifact?.status === "available" ? artifact.text : null;
      },
    });
    return redactArchive({
      archive: true,
      label: flow.state === "paused" ? "Retired — delivery unresolved" : "Recorded review history",
      project: archiveProjects(source.directory).canonical(flow.project),
      recorded: { state: flow.state, verdict: last?.verdict ?? null, reviewHeadSha: last?.reviewHeadSha ?? null, reviewedAt: last?.reviewedAt ?? null },
      currentHead: "unknown", mergeAuthority: false,
      // Keep original paused state, unknown extension fields and receipts.
      row: raw, artifacts, relayOccurrences,
      conversations: {
        implementer: source.conversationId(flow.implementerConversationId),
        reviewers: flow.rounds.map(round => ({ round: round.n, conversationId: source.conversationId(round.reviewerConversationId) })),
      },
      ...(exported ? { format: "review-history-v1", private: true, redacted: true } : {}),
    });
  } finally { source.close(); }
}
