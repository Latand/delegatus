import { redactMonitorText } from "@/lib/monitor/redact";
import { detectedVerdict } from "@/lib/spawnNotice/sweep";
import type { MaintenanceRun, MaintenanceRunLog, MaintenanceAttention, MaintenanceLeftAlone, MaintenanceFailureKind } from "./types";
import { workEvidenceLines, type TaskWorkEvidence } from "./evidence";

export function parseMaintenanceReport(text: string): Pick<MaintenanceRunLog, "attention" | "leftAlone" | "verdict"> {
  const attention: MaintenanceAttention[] = [];
  const leftAlone: MaintenanceLeftAlone[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(attention|left):\s*(.+)$/i.exec(line);
    if (!match) continue;
    const [id, body, ...options] = match[2].split(" | ").map(s => redactMonitorText(s.trim()).slice(0, 300));
    if (!/^(?:[a-f0-9]{8,32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id) || !body) continue;
    if (match[1].toLowerCase() === "attention" && attention.length < 40) attention.push({ taskId: id, text: body, options: options.slice(0, 3) });
    else if (match[1].toLowerCase() === "left" && leftAlone.length < 200) leftAlone.push({ taskId: id, reason: body });
  }
  return { attention, leftAlone, verdict: detectedVerdict(text) as MaintenanceRunLog["verdict"] };
}
export function maintenanceCardDetails(run: MaintenanceRun): string {
  return `Delegatus board maintenance run ${run.runId}.\nStarted by the seat tick of ${run.project} at ${run.claimedAt}; interval ${run.intervalHours} h. Delegatus manages this card: closed and hidden on success, blocked on failure. Run log: seat_tick_settings verbose, maintenance.lastRunLog.`;
}
export function maintenanceCardText(locale: "uk" | "en", run: MaintenanceRun, timeZone?: string): string {
  const time = (at: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at)).replace(",", "").replace(/(\d{2})\/(\d{2})/, "$1.$2");
  const title = `${locale === "uk" ? "Обслуговування дошки" : "Board maintenance"} — ${time(run.claimedAt)}`;
  if (run.state === "failed") {
    const reasons: Record<MaintenanceFailureKind, string> = {
      "no-account": "немає доступного акаунта Codex для цього проєкту", "no-repository": "не знайдено теку репозиторію проєкту", "launch-refused": "Delegatus відмовив у запуску", "launch-failed": "агент не запустився", "host-died": "процес агента зупинився посеред роботи", "turn-error": "агент завершився з помилкою", "agent-fail": "агент не зміг завершити перевірку", "needs-decision": "потрібне рішення оператора", "timed-out": "агент не завершив роботу за 90 хвилин",
    };
    const next = time(new Date(Date.parse(run.launchedAt ?? run.claimedAt) + run.intervalHours * 3_600_000).toISOString());
    const decision = run.failure!.kind === "needs-decision" ? `\n${run.failure!.detail}` : "";
    return locale === "uk" ? `${title}\nНе вдалося: ${reasons[run.failure!.kind]}.${decision}\nВстиг змінити ${run.counts.tasks} задач. Наступна спроба — не раніше ${next}.`
      : `${title}\nFailed: ${run.failure!.kind}.${decision}\nChanged ${run.counts.tasks} tasks. Next attempt no earlier than ${next}.`;
  }
  if (run.state === "succeeded") {
    const c = run.counts;
    const summary = locale === "uk" ? `Готово: змінено ${c.tasks} задач, ${c.writes} записів (статуси — ${c.status}, закрито — ${c.closed}, нових — ${c.created}, тексти — ${c.text}, описи — ${c.details}, вигляд — ${c.looks}).` : `Done: ${c.tasks} tasks changed in ${c.writes} writes (status ${c.status}, closed ${c.closed}, created ${c.created}, text ${c.text}, details ${c.details}, looks ${c.looks}).`;
    const attention = run.log.attention.length ? `${locale === "uk" ? "Потребує вашої уваги" : "For your attention"} (${run.log.attention.length}):\n${run.log.attention.slice(0, 12).map(a => `— ${a.taskId}: ${a.text.slice(0, 200)}${a.options.length ? ` (${a.options.join(" / ")})` : ""}`).join("\n")}` : locale === "uk" ? "Нічого не потребує вашої уваги." : "Nothing needs your attention.";
    return `${title}\n${summary}\n${attention}`;
  }
  return locale === "uk" ? `${title}\nDelegatus запустив агента, який перевіряє відкриті задачі проєкту: пайплайни, агентів, PR і те, чи робота справді йде. Він виправляє статуси, дописує новини для людини та створює продовження частково виконаних задач. Після роботи тут з’явиться підсумок і картка зникне з дошки.`
    : `${title}\nDelegatus started an agent that checks this project's open tasks, pipelines, agents and pull requests. It corrects statuses, writes news for the operator and creates continuations of partly shipped tasks. When it finishes, a summary appears here and the card leaves the board.`;
}
export function maintenanceBrief(input: { run: MaintenanceRun; previous: MaintenanceRun | null; previousCardText: string | null; seatTaskIds: string[]; productionLine: string; evidence: TaskWorkEvidence[]; openCount: number; now: number }): string {
  const { run, previous } = input;
  const boundedList = (heading: string, lines: string[], bound: number) => {
    let result = heading + "\n";
    for (let i = 0; i < lines.length; i++) {
      if (result.length + lines[i].length > bound - 100) { result += `and ${lines.length - i} more (seat_tick_settings verbose reads the full record)\n`; break; }
      result += lines[i] + "\n";
    }
    return result;
  };
  const section = previous ? [
    `Previous run ${previous.runId}: ${previous.state}, ended ${previous.endedAt}, card ${previous.taskId}.`,
    `Card summary: ${(input.previousCardText ?? "unread").slice(0, 600)}`,
    boundedList(`Changed (${previous.counts.writes}; ${previous.log.omittedChanges} omitted; ${previous.log.logGaps} log gaps):`, previous.log.changes.map(c => `- ${c.taskId} ${c.tool}: ${c.fields.join(", ")}${c.statusFrom ? ` ${c.statusFrom} → ${c.statusTo}` : ""}${c.titleTo ? ` title ${c.titleFrom ?? "new"} → ${c.titleTo}` : ""}`), 2600),
    boundedList(`Asked (${previous.log.attention.length}):`, previous.log.attention.map(a => `- ${a.taskId} | ${a.text} | ${a.options.join(" | ")}`), 1400),
    boundedList(`Left alone (${previous.log.leftAlone.length}):`, previous.log.leftAlone.map(a => `- ${a.taskId} | ${a.reason}`), 1000),
  ].join("\n") : "No earlier run for this project.";
  return `Board maintenance run ${run.runId} for project ${run.project}.\nRepository: ${run.repoDir}\nYour run's card: ${run.taskId}. Delegatus manages it.\nThe orchestrator seat's card: ${input.seatTaskIds.join(", ") || "none found; confirm with get_orchestrator"}.\nProduction: ${input.productionLine}\nThis run started ${run.claimedAt}. The previous run started ${previous?.claimedAt ?? "never"}; use it as updatedSince for the done-task check.\n\n${section}\nThe record is history. Confirm every decision from current state.\nWork evidence Delegatus measured at ${new Date(input.now).toISOString()}, for ${input.evidence.length} of ${input.openCount} open tasks. Confirm before you act:\n${workEvidenceLines(input.evidence, input.now).map(l => `- ${l}`).join("\n")}`;
}
export function maintenanceItemLabel(run: Pick<MaintenanceRun, "state" | "endedAt" | "failure" | "counts" | "log" | "claimedAt" | "launchedAt" | "intervalHours">): string {
  const c = run.counts;
  if (run.state === "failed") {
    const prefix = `board maintenance failed ${run.endedAt}: ${run.failure?.kind}: ${run.failure?.detail}. ${c.tasks} task(s) changed in ${c.writes} write(s) (status ${c.status}, closed ${c.closed}, created ${c.created}, text ${c.text}, details ${c.details}, looks ${c.looks}); for the operator (${run.log.attention.length}): `;
    const attention = run.log.attention.slice(0, 5).map(a => `${a.taskId}: ${a.text}${a.options.length ? ` [${a.options.join(" / ")}]` : ""}`).join("; ");
    const tail = ` The card stays blocked; next run after ${new Date(Date.parse(run.launchedAt ?? run.claimedAt) + run.intervalHours * 3_600_000).toISOString()}. Full list: seat_tick_settings verbose.`;
    return (prefix + attention + tail).slice(0, 1200);
  }
  const prefix = `board maintenance finished ${run.endedAt}; ${c.tasks} task(s) changed in ${c.writes} write(s) (status ${c.status}, closed ${c.closed}, created ${c.created}, text ${c.text}, details ${c.details}, looks ${c.looks}); for the operator (${run.log.attention.length}): `;
  const tail = " Bring these to the operator with suggest_replies; seat_tick_settings verbose holds the full list.";
  return prefix + run.log.attention.slice(0, 5).map(a => `${a.taskId}: ${a.text}${a.options.length ? ` [${a.options.join(" / ")}]` : ""}`).join("; ").slice(0, Math.max(0, 1200 - prefix.length - tail.length)) + tail;
}
