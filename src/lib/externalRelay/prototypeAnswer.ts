import type { EphemeralAgentRun } from "@/lib/agent/ephemeral";
import { decidePrototype, type PrototypeDelivery } from "@/lib/prototypeReview/decision";
import { findPrototypeRound } from "@/lib/prototypeReview/store";
import { PrototypeError } from "@/lib/prototypeReview/input";
import { prototypeCopyLine, type PrototypeAnswerMatch } from "@/lib/prototypeReview/telegramAnswer";
import type { PrototypeWorld } from "@/lib/prototypeReview/world";

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
        await decidePrototype({ kind: "operator-in-process", authorize: guard }, round.taskId, match.input, ports.world, ports.delivery);
        const decision = findPrototypeRound(round.taskId, round.id)?.decision;
        if (!decision) throw new Error("decision unavailable");
        const choices = decision.chosen.length ? `варіанти ${decision.chosen.join(", ")}` : "";
        const answers = decision.answers?.map((a, i) => `${i + 1}${a.options.map(n => String.fromCharCode(97 + n)).join("")}${a.other ? "+" : ""}`).join(" ");
        text = `✅ Записав рішення «${round.title}»: ${[choices, answers ? `відповіді ${answers}` : ""].filter(Boolean).join("; ")}. ${decision.delivery.state === "no-orchestrator"
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
