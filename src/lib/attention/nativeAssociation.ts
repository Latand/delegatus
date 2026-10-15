import crypto from "node:crypto";
import { findSeatRound, insertSeatRound } from "@/lib/prototypeReview/seatRounds";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { operatorLocale } from "@/lib/operator/settings";
import { nativeAssociationDecisionApproves, nativeAssociationForm } from "./nativeAssociationForm";
import type { NativeAdmissionEvidence } from "./nativeCaller";

/** The operator's persisted decision binds precisely this process and transcript
 * evidence. An amendment to Refuse revokes it; a new generation needs a new round.
 * No caller argument or CLI record can supply approval. */
export function nativeAssociation(evidence: NativeAdmissionEvidence): { status: "approved" | "waiting" | "refused"; proof: string } {
  // Older rounds classified anonymous loopback requests as operator decisions.
  // A versioned binding requires fresh, authenticated approval of their evidence.
  const proof = crypto.createHash("sha256").update("operator-authorized-v1:").update(JSON.stringify(evidence)).digest("hex");
  const id = `pr_${proof.slice(0, 32)}`;
  let round = findSeatRound(id);
  if (!round) {
    const project = projectInfoFromCwd(evidence.cwd)?.project;
    if (!project) throw new Error("native association needs a known project");
    const at = new Date().toISOString();
    try {
      insertSeatRound({ id, taskId: null, project, ...nativeAssociationForm(evidence, operatorLocale() ?? "en"), createdAt: at,
        source: { conversationId: null }, publicationKey: `native-association:${proof}`, inputDigest: proof,
        variants: [], nativeAssociation: evidence,
      });
    } catch (error) {
      // Concurrent requests for the same generation share one decision round.
      if (!findSeatRound(id)) throw error;
    }
    round = findSeatRound(id);
  }
  if (!round || round.inputDigest !== proof || JSON.stringify(round.nativeAssociation) !== JSON.stringify(evidence)) return { status: "refused", proof };
  const decision = round.decision;
  if (!decision) return { status: "waiting", proof };
  const approved = nativeAssociationDecisionApproves(decision);
  return { status: approved ? "approved" : "refused", proof };
}
