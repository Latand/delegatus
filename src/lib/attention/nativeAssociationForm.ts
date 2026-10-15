import type { NativeAdmissionEvidence } from "./nativeCaller";
import type { PrototypeDecision, PrototypeQuestion } from "@/lib/prototypeReview/types";

export const NATIVE_ASSOCIATION_AUTHORIZATION_ERROR = "Native association requires authorization from the paired Telegram owner. Sign in through that owner's linked Telegram account and review this session in Decisions, or send an explicit decision through the owner relay. Approval is unavailable without this authorization.";

/** Shared by production and the existing board evidence fixture. */
export function nativeAssociationForm(evidence: NativeAdmissionEvidence, locale: "en" | "uk") {
  const uk = locale === "uk";
  const words = (en: string, ua: string) => uk ? ua : en;
  const questions: PrototypeQuestion[] = [
    { id: "identity", text: words("Approve this external Claude session for attributed mutations and original-key recovery?", "Дозволити цій зовнішній сесії Claude зміни від її імені та відновлення за початковим ключем?"), other: true,
      options: [{ label: words("Refuse or revoke this association", "Відмовити або відкликати прив’язку"), recommended: true }, { label: words("Approve this process and transcript generation", "Дозволити цей процес і покоління транскрипту") }] },
    { id: "evidence", text: `${words("Engine", "Рушій")}: Claude. ${words("Cwd", "Робоча тека")}: ${evidence.cwd}. ${words("Process started", "Початок процесу")}: ${new Date(evidence.startedAt).toISOString()}. ${words("Transcript", "Транскрипт")}: ${evidence.transcript}. PID: ${evidence.pid}. ${words("Verify this exact session; a sibling needs its own approval.", "Перевірте саме цю сесію; сусідня потребує окремого дозволу.")}`, other: true,
      options: [{ label: words("Evidence does not match", "Дані не збігаються"), recommended: true }, { label: words("I verified this exact session", "Я перевірив саме цю сесію") }] },
  ];
  return { title: words("Approve external Claude session", "Дозвіл для зовнішньої сесії Claude"), questions };
}

/** Exact, explicit choices are required; free text and skipped answers grant nothing. */
export function nativeAssociationDecisionApproves(decision: PrototypeDecision | undefined): boolean {
  const authorized = decision?.nativeAssociationApproval === "paired-owner" ? decision.decidedBy?.kind === "operator"
    : decision?.nativeAssociationApproval === "owner-session" && decision.decidedBy?.kind === "member";
  return Boolean(authorized && decision && !decision.skipped && !decision.rejected && !decision.recommendedWithReservation
    && ["identity", "evidence"].every(id => {
      const answer = decision.answers?.find(answer => answer.questionId === id);
      return answer && !answer.skipped && !answer.other && !answer.customText && answer.options.length === 1 && answer.options[0] === 1;
    }));
}
