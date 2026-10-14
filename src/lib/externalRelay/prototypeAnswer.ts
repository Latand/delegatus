import type { EphemeralAgentRun } from "@/lib/agent/ephemeral";
import { decidePrototype, prototypeDelivery, type PrototypeDelivery } from "@/lib/prototypeReview/decision";
import { deliverPrototypeDecision } from "@/lib/prototypeReview/deliveryWorker";
import { findPrototypeRound } from "@/lib/prototypeReview/store";
import { PrototypeError } from "@/lib/prototypeReview/input";
import { prototypeCopyLine, type PrototypeAnswerMatch } from "@/lib/prototypeReview/telegramAnswer";
import { prototypeWorld, type PrototypeWorld } from "@/lib/prototypeReview/world";

/** An owner control with the runner's normal lease and cancellation lifetime. */
export function runPrototypeAnswer(match: PrototypeAnswerMatch, replyTo: string, authorize: () => void,
  ports: { world?: PrototypeWorld; delivery?: PrototypeDelivery } = {}): EphemeralAgentRun {
  let cancelled = false;
  const guard = () => { if (cancelled) throw new Error("cancelled"); authorize(); };
  const started = Date.now();
  const done = Promise.resolve().then(async () => {
    guard();
    const { round } = match;
    const expected = prototypeCopyLine(round, round.variants[0]?.number);
    let text: string;
    if (match.error !== undefined) text = `Не записав: ${match.error}. Формат: ${expected}`;
    else {
      try {
        if (decidePrototype({ kind: "operator-in-process", authorize: guard }, round.taskId, match.input, ports.world)) {
          // Authority is checked while saving. The durable operator decision
          // then uses the same background delivery and boot recovery as the web.
          deliverPrototypeDecision(round.taskId, round.id, { world: ports.world ?? prototypeWorld,
            delivery: ports.delivery ?? prototypeDelivery, now: Date.now });
        }
        const decision = findPrototypeRound(round.taskId, round.id)?.decision;
        if (!decision) throw new Error("decision unavailable");
        const choices = decision.chosen.length ? `варіанти ${decision.chosen.join(", ")}` : "";
        const answers = decision.answers?.map((a, i) => `${i + 1}${a.options.map(n => String.fromCharCode(97 + n)).join("")}${a.other ? "+" : ""}`).join(" ");
        const note = decision.comment ? ` Слова збережено дослівно: «${decision.comment.slice(0, 500)}${decision.comment.length > 500 ? "…» (повний текст у Delegatus)" : "»"}.` : "";
        const recorded = decision.recommendedWithReservation ? "рекомендовані з застереженням" : decision.skipped ? "рекомендовані"
          : decision.answers?.some(a => a.other || a.customText) || (!decision.chosen.length && decision.originalReply) ? "власні відповіді" : "";
        text = `✅ Записав рішення «${round.title}»: ${[recorded, choices, answers ? `відповіді ${answers}` : ""].filter(Boolean).join("; ")}.${note} ${decision.delivery.state === "no-orchestrator"
          ? "Оркестратора зараз немає; рішення збережено в Delegatus."
          : decision.delivery.state === "sent" ? "Оркестратор отримав його." : "Рішення збережено в Delegatus; стан доставки оркестратору — у вебрев’ю."}`;
      } catch (error) {
        guard();
        text = `Не записав: ${error instanceof PrototypeError ? error.message : "рішення зараз недоступне"}. Формат: ${expected}`;
      }
    }
    guard();
    return { status: "done" as const, answer: { action: "reply", text, reply_to: replyTo }, durationMs: Date.now() - started, code: null, signal: null };
  }).catch(() => ({ status: cancelled ? "cancelled" as const : "failed" as const,
    answer: null, durationMs: Date.now() - started, code: null, signal: null }));
  // Done settles like an agent run even when the lease or authority was revoked.
  return { pid: null, identity: null, done, cancel: () => { cancelled = true; } };
}
