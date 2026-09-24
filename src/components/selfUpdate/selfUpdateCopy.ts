/* Pure derivations for the Update surface (#2007): which copy each state
   takes, in the operator's language. The component renders what these
   answer; the DOM tests read the same answers through the rendered page. */
import type { Locale, MessageKey, TFunction } from "@/lib/i18n";
import { REFUSAL_CODES, type CheckState, type ProcessError, type ProcessView, type RefusalCode, type Revision, type Snapshot, type Step, type StepName } from "@/lib/selfUpdate/types";

export type IconKind = "pending" | "running" | "done" | "failed" | "warning";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function clock(iso: string | null, seconds = false): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
}

export function day(iso: string, locale: Locale): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function duration(ms: number, t: TFunction): string {
  if (ms < 60_000) return t("selfUpdate.unit.seconds", { value: (Math.max(0, ms) / 1000).toFixed(1) });
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return t("selfUpdate.unit.minutesSeconds", { m: Math.floor(totalSeconds / 60), s: pad(totalSeconds % 60) });
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60 * 48) return t("selfUpdate.unit.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
  return t("selfUpdate.unit.daysHours", { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60) });
}

export function revisionText(revision: Revision, locale: Locale): string {
  return [revision.version, revision.short, day(revision.date, locale)].filter(Boolean).join(" · ");
}

export function targetText(short: string, version: string | null): string {
  return version ? `${short} (${version})` : short;
}

/** Which live processes serve something other than the installed release. */
export function staleProcesses(s: Snapshot): { web: boolean; host: boolean } {
  const installed = s.installed.short;
  return {
    web: Boolean(installed && s.serving.web && s.serving.web.short !== installed),
    host: Boolean(installed && s.serving.runtimeHost && s.serving.runtimeHost.short !== installed),
  };
}

export interface HeaderStatus { icon: IconKind; text: string; next: string | null; edge: "warning" | "danger" | null }

export function headerStatus(s: Snapshot, t: TFunction): HeaderStatus {
  const branch = `origin/${s.meta.branch}`;
  const check = s.check;
  const time = clock(check.at);
  const stale = staleProcesses(s);
  if (check.state === "checking") return { icon: "running", text: t("selfUpdate.status.checking", { branch }), next: null, edge: null };
  if (check.state === "up-to-date" && (stale.web || stale.host)) {
    /* Built is not running: green waits until every live process runs it. */
    const sha = s.installed.short;
    let text: string;
    if (s.mode === "managed") text = t("selfUpdate.stale.managedHost", { sha, host: s.serving.runtimeHost?.short ?? "", time });
    else if (stale.web && stale.host) text = t("selfUpdate.stale.both", { sha, time });
    else if (stale.web) text = s.serving.runtimeHost ? t("selfUpdate.stale.webBehind", { sha, time }) : t("selfUpdate.stale.web", { sha, time });
    else text = s.serving.web ? t("selfUpdate.stale.hostBehind", { sha, time }) : t("selfUpdate.stale.host", { sha, time });
    return { icon: "warning", text, next: null, edge: "warning" };
  }
  if (check.state === "up-to-date") {
    const note = check.relation === "ahead" ? t("selfUpdate.status.ahead", { branch, count: check.ahead })
      : check.relation === "diverged" ? t("selfUpdate.status.diverged", { branch }) : null;
    const text = [t("selfUpdate.status.upToDate", { time }), note].filter(Boolean).join(" · ");
    return { icon: "done", text, next: t("selfUpdate.status.nextCheck", { time: clock(check.nextPollAt) }), edge: null };
  }
  if (check.state === "update-available") {
    const behind = check.relation === "diverged" ? t("selfUpdate.status.diverged", { branch }) : t("selfUpdate.status.behind", { branch, count: check.behind });
    return { icon: "warning", text: t("selfUpdate.status.available", { behind, time }), next: null, edge: "warning" };
  }
  if (check.state === "failed") {
    return { icon: "failed", text: t("selfUpdate.status.failed", { time }), next: t("selfUpdate.status.nextCheck", { time: clock(check.nextPollAt) }), edge: "danger" };
  }
  return { icon: "pending", text: t("selfUpdate.status.idle"), next: null, edge: null };
}

export function stepLabel(name: StepName, short: string, t: TFunction): string {
  return t(`selfUpdate.step.${name}` as MessageKey, { sha: short });
}

export function stepName(name: StepName, t: TFunction): string {
  return t(`selfUpdate.stepName.${name}` as MessageKey);
}

/** The line of a failed step's output that says why: the last fatal or
    error line, else its last line. */
export function lastError(tail: string[]): string | null {
  const lines = tail.filter((line) => line.trim() !== "");
  return [...lines].reverse().find((line) => /^(fatal|error)\b|\berror:|ERR!/i.test(line.trim())) ?? lines.at(-1) ?? null;
}

/** What the done state asks for depends on which processes already run the
    build: a process counts once it is healthy on it, never while it starts. */
export function appliedCopy(s: Snapshot, short: string, t: TFunction): string {
  const runs = (view: ProcessView) => view.pid !== null && view.state === "healthy" && view.revision === short;
  const web = runs(s.processes.web);
  const host = runs(s.processes.runtimeHost);
  if (s.mode === "managed") {
    return host || !s.processes.runtimeHost.revision
      ? t("selfUpdate.applied.both")
      : t("selfUpdate.applied.managedHostBehind", { host: s.processes.runtimeHost.revision });
  }
  if (s.busy === "restart-web") return t("selfUpdate.applied.restartingWeb");
  if (s.busy === "restart-runtime-host") return t("selfUpdate.applied.restartingHost");
  if (web && host) return t("selfUpdate.applied.both");
  if (web) return t("selfUpdate.applied.web");
  if (host) return t("selfUpdate.applied.host");
  return t("selfUpdate.applied.none");
}

function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

export function processErrorText(error: ProcessError | null, role: "web" | "runtimeHost", t: TFunction): string | null {
  if (!error) return null;
  switch (error.kind) {
    case "exit":
      return error.signal
        ? t("selfUpdate.error.signal", { signal: error.signal, seconds: seconds(error.afterMs) })
        : t("selfUpdate.error.exit", { code: error.code ?? "?", seconds: seconds(error.afterMs) });
    case "timeout":
      return role === "web"
        ? t("selfUpdate.error.timeoutWeb", { seconds: seconds(error.budgetMs) })
        : t("selfUpdate.error.timeoutHost", { seconds: seconds(error.budgetMs) });
    case "port-in-use": return t("selfUpdate.error.port", { port: error.port });
    case "gone": return t("selfUpdate.error.gone", { pid: error.pid });
    case "no-answer": return t("selfUpdate.error.noAnswer");
    case "fell-back": return t("selfUpdate.error.fellBack", { sha: error.revision ?? "?", detail: error.detail });
    case "message": return error.text;
  }
}

/** The step the running update is in, counted from one. */
export function runningStepNumber(steps: Step[]): number {
  return Math.max(1, steps.findIndex((step) => step.state === "running") + 1);
}

/** Why an action was refused, as the page knows it: a code the server sent,
    or what the page itself saw (403 from the operator gate, another HTTP
    status, no answer at all). `detail` is machine output. */
export type ActionError =
  | { code: RefusalCode; detail?: string }
  | { code: "forbidden" }
  | { code: "http"; status: number }
  | { code: "offline" };

/** A refusal as the page words it: the server's code when it sent one,
    else what the page saw. The server's English `error` is for API readers. */
export function actionError(status: number, payload: { code?: string; detail?: string } | null): ActionError {
  const code = payload?.code;
  if (code && (REFUSAL_CODES as readonly string[]).includes(code)) {
    return { code: code as RefusalCode, ...(payload?.detail ? { detail: payload.detail } : {}) };
  }
  if (status === 403) return { code: "forbidden" };
  return { code: "http", status };
}

export function refusalText(error: ActionError, t: TFunction): string {
  if (error.code === "http") return t("selfUpdate.refusal.http", { status: error.status });
  const text = t(`selfUpdate.refusal.${error.code}` as MessageKey);
  return "detail" in error && error.detail ? `${text}: ${error.detail}` : text;
}

/** The check's failure line: our reason worded, else git's own line. */
export function checkErrorText(check: CheckState, branch: string, t: TFunction): string | null {
  if (check.errorCode) return t(`selfUpdate.checkError.${check.errorCode}` as MessageKey, { branch });
  return check.error;
}

/** Why a step failed: our reason worded; a command's failure is its own last
    fatal or error line; an unexpected failure is the text it carried. */
export function stepFailureText(step: Step, t: TFunction): string | null {
  const failure = step.failure;
  if (!failure || failure.kind === "exit") return lastError(step.tail);
  switch (failure.kind) {
    case "memory": return t("selfUpdate.stepFailure.memory", { available: failure.availableMb, needed: failure.neededMb });
    case "remote-moved": return t("selfUpdate.stepFailure.remoteMoved", { expected: failure.expected, fetched: failure.fetched });
    case "head-mismatch": return t("selfUpdate.stepFailure.headMismatch", { head: failure.head, expected: failure.expected });
    case "build-id-missing": return t("selfUpdate.stepFailure.buildIdMissing");
    case "interrupted": return t("selfUpdate.stepFailure.interrupted");
    case "deployment-lost": return t("selfUpdate.stepFailure.deploymentLost");
    case "error": return failure.text;
  }
}
