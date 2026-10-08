import { createHash } from "node:crypto";
import { accountManager, ProjectAccountRefusedError } from "@/lib/accounts/manager";
import { AccountProjectBindingsUnreadableError, allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { bridgeReportsEnabled, effectiveReportTelegram, reportHeaderName } from "@/lib/projects/settings";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import { seatTurnProgressing } from "./seatTick";
import { openSeatAuthIncident, seatAuthAccounts, seatAuthCredentialStamp, seatAuthCredentialChangedAt, seatAuthCredentialsChanged, seatAuthIncidentRecovered, seatAuthNotice } from "./seatAuthIncident";
import type { SeatTickCheckInput, SeatTickCard } from "./types";
import type { SeatTickSources } from "./seatTickSources";
import type { readSeatTickState, writeSeatTickState } from "./seatTickState";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import type { TelegramBotService } from "@/lib/telegram/bot/service";

export interface SeatAuthRecoveryPorts {
  rotate?: typeof executeOrchestratorRotation;
  telegram?: TelegramBotService["send"];
}

function telegramRefusedBeforeSend(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["bot_not_connected", "chat_not_found", "chat_not_allowed", "bot_not_in_chat"].includes(String(error.code));
}

export function seatAuthRotationKey(id: string): string {
  return `seat-auth-${createHash("sha256").update(id).digest("hex")}`;
}

/** Owns no clock: the ordinary seat check drives detection, recovery and telling. */
export async function recoverSeatAuthentication(
  input: SeatTickCheckInput,
  sources: SeatTickSources,
  readState: typeof readSeatTickState,
  writeState: typeof writeSeatTickState,
  ensureCard: (project: string, card: SeatTickCard, at: string) => boolean,
  ports: SeatAuthRecoveryPorts,
): Promise<string | null> {
  let incident = input.state.authIncident;
  const seat = input.seat;
  const at = new Date(input.now).toISOString();
  const persist = () => {
    writeState(input.project, input.state);
    // Accounting writes advance the conditional revision. Continue from the
    // revision just committed before the next phase attempts its own write.
    input.state = { ...input.state, accounting: readState(input.project).accounting };
  };
  const writeCard: typeof ensureCard = (project, card, timestamp) => {
    try { return ensureCard(project, card, timestamp); }
    catch (error) {
      console.error("[seat authentication] board notice write failed", error instanceof Error ? error.name : "unknown");
      return false;
    }
  };
  const owedCard = input.state.authCardsOwed?.[0];
  if (owedCard && !activeDrain()) {
    const card: SeatTickCard = { ref: "seat-auth-failed", kind: "auth-failed", instance: owedCard.id, state: "open", detail: owedCard.detail };
    const created = writeCard(input.project, card, at);
    const settled = created && (owedCard.state === "open" || writeCard(input.project, { ...card, state: "resolved" }, at));
    if (settled) {
      if (incident?.id === owedCard.id && incident.notice) incident.notice.card = true;
      input.state = { ...input.state, authCardsOwed: input.state.authCardsOwed?.filter(notice => notice.id !== owedCard.id) };
      persist();
    }
  }
  const owedTelegram = input.state.authTelegramOwed?.[0];
  if (owedTelegram && !activeDrain()) {
    let settled = false;
    let sent: Awaited<ReturnType<NonNullable<SeatAuthRecoveryPorts["telegram"]>>> | undefined;
    let failure: unknown;
    try {
      let send = ports.telegram;
      if (!send) {
        const service = (await import("@/lib/telegram/bot/service")).telegramBotService();
        send = service.send.bind(service);
      }
      if (!activeDrain()) {
        sent = await send({ conversationId: null, clientRequestId: owedTelegram.id, chat: owedTelegram.chat,
          ...(owedTelegram.topicId ? { topicId: owedTelegram.topicId } : {}), text: owedTelegram.html, format: "html", silent: false });
        settled = true;
      }
    } catch (error) { failure = error; settled = !telegramRefusedBeforeSend(error); }
    if (settled) {
      const { findBridgeReport, scopedReportId, recordBridgeReportTelegram } = await import("@/lib/bridge/store");
      const report = findBridgeReport(scopedReportId(input.project, owedTelegram.id));
      if (report) recordBridgeReportTelegram(report.id, sent
        ? { state: "sent", at, messageIds: sent.messageIds }
        : { state: "failed", at, code: failure instanceof Error && "code" in failure ? String(failure.code) : "telegram_failed" });
      if (sent && incident?.id === owedTelegram.id && incident.notice) incident.notice.telegram = "sent";
      input.state = { ...input.state, authTelegramOwed: input.state.authTelegramOwed?.filter((notice) => notice.id !== owedTelegram.id) };
      persist();
    }
  }
  const outcome = seat && !seatTurnProgressing(seat) ? await sources.seatTurnOutcome?.(seat.conversationId) ?? null : null;
  const credentialScope = seat ? `seat-auth-baseline:${input.project}:${seat.seatEpoch}` : null;
  const observed = input.state.authCredentialObserved;
  const baseline = observed?.scope === credentialScope ? observed : sources.seatFor(input.project).active?.authCredentialBaseline;
  const observedStamp = outcome?.accountId && credentialScope ? seatAuthCredentialStamp(outcome.engine, outcome.accountId, credentialScope) : null;
  if (outcome?.accountId && credentialScope && observedStamp) input.state = { ...input.state,
    authCredentialObserved: { engine: outcome.engine, accountId: outcome.accountId, scope: credentialScope, stamp: observedStamp } };
  let closingThrough: number | undefined;
  const close = (recoveredThrough = incident?.lastFailedTs ?? 0, retainUnsent = false) => {
    if (!incident) return;
    closingThrough = recoveredThrough;
    if (!incident.notice && retainUnsent) {
      incident.recoveredThrough = Math.max(incident.recoveredThrough ?? 0, incident.lastFailedTs, recoveredThrough);
      input.state = { ...input.state, authRecoveredThrough: Math.max(input.state.authRecoveredThrough ?? 0, incident.recoveredThrough) };
      return;
    }
    // Notice debt is independent of authentication recovery. A full board
    // cannot keep repaired credentials fenced, and a resolved write creates
    // no missing card; retain its original body and identity until it exists.
    const card = input.state.authCardsOwed?.find(notice => notice.id === incident!.id);
    if (card) card.state = "resolved";
    if (!incident.notice || incident.notice.card) {
      if (!writeCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "resolved", detail: "" }, at)) {
        const labels = new Map(seatAuthAccounts(incident.engine).map(row => [row.id, row.label]));
        const locale = operatorLocale() === "en" ? "en" : "uk";
        const detail = seatAuthNotice(incident, labels, [], locale, reportHeaderName(input.project, locale)).body;
        input.state = { ...input.state, authCardsOwed: [...(input.state.authCardsOwed ?? []).filter(notice => notice.id !== incident!.id), { id: incident.id, detail, state: "resolved" }] };
      }
    }
    input.state = { ...input.state, authIncident: undefined, authRecoveredThrough: Math.max(incident.lastFailedTs, recoveredThrough) };
    incident = undefined;
    closingThrough = undefined;
  };
  if (incident && seat?.conversationId === incident.conversationId && incident.seatEpoch === seat.seatEpoch
    && incident.accountId !== null && outcome?.accountId && (incident.engine !== outcome.engine || incident.accountId !== outcome.accountId)) {
    // A native account migration keeps the conversation and designation epoch.
    // Finish the old credential scope before judging the current account's turn.
    close();
  }
  const provisionalSuccessor = () => {
    const current = sources.seatFor(input.project).active;
    return incident?.rotation.state === "rotated" && current?.path === null
      && current.intent.clientRequestId === seatAuthRotationKey(incident.id);
  };
  if (incident && incident.seatEpoch !== (seat?.seatEpoch ?? null)) {
    // A rotation can have landed before its caller's next write. Its durable
    // request identity proves ours, so finish telling before closing the row.
    const current = sources.seatFor(input.project).active;
    const failedMove = current?.conversationId === incident.conversationId
      ? readOrchestratorSeatFileOrNull()?.history.find((row) => row.reason === "terminal_error"
        && row.seat.project === input.project && row.seat.intent.clientRequestId === seatAuthRotationKey(incident!.id)
        && row.seat.predecessorConversationId === incident!.conversationId && row.seat.state === "active"
        && row.seat.path === null && row.seat.seatEpoch < current.seatEpoch) : undefined;
    if (current?.conversationId === incident.conversationId) {
      // Restoring the same failed conversation cannot prove credential repair.
      // The incident survives lost outcome writes and bounded history trimming;
      // terminal history supplies the failure detail when it is still available.
      incident.seatEpoch = current.seatEpoch;
      if (incident.rotation.toAccountId) incident.rotation = { ...incident.rotation, state: "refused", error: failedMove?.seat.intent.error ?? "automatic move did not produce a readable successor" };
      if (incident.notice?.card && incident.rotation.state === "refused") {
        const labels = new Map(seatAuthAccounts(incident.engine).map((row) => [row.id, row.label]));
        const locale = operatorLocale() === "en" ? "en" : "uk";
        const notice = seatAuthNotice(incident, labels, [], locale, reportHeaderName(input.project, locale));
        incident.notice.card = writeCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "open", detail: notice.body }, at);
      }
    } else if (!incident.notice && current?.intent.clientRequestId === seatAuthRotationKey(incident.id)) {
      incident.rotation = { ...incident.rotation, state: "rotated", successorConversationId: current.conversationId ?? undefined };
    } else if (incident.rotation.state !== "rotated" || (incident.notice && !provisionalSuccessor())) {
      // A completed notice attempt leaves board delivery in authCardsOwed.
      // The readable successor can now be judged independently.
      close();
    }
  }
  if (incident && incident.seatEpoch === (seat?.seatEpoch ?? null)) {
    const stamp = seatAuthCredentialStamp(incident.engine, incident.accountId, incident.id);
    if (seatAuthIncidentRecovered(incident, seat?.seatEpoch ?? null, outcome, stamp)) {
      // Consume unobserved failures preceding the credential write. A failed
      // turn after that write must still open its own incident in this check.
      // Without a verified repair timestamp, clear the observed failure but
      // do not consume a newer failed turn whose ordering is unproven.
      const loginAt = seatAuthCredentialsChanged(incident.credentialStamp, stamp) ? seatAuthCredentialChangedAt(stamp) ?? incident.lastFailedTs : Infinity;
      close(Math.min(outcome?.auth?.ts ?? incident.lastFailedTs, loginAt), true);
    }
  }
  if (!incident && seat && outcome) {
    const stamp = outcome.auth ? seatAuthCredentialStamp(outcome.engine, outcome.accountId, `seat-auth:${input.project}:${seat.seatEpoch}:${outcome.auth.ts}`) : null;
    const repairedBeforeDetection = outcome.auth && baseline?.engine === outcome.engine && baseline.accountId === outcome.accountId
      && seatAuthCredentialsChanged(baseline.stamp, observed?.scope === credentialScope ? observedStamp
        : seatAuthCredentialStamp(outcome.engine, outcome.accountId, baseline.scope));
    if (outcome.auth && repairedBeforeDetection && (seatAuthCredentialChangedAt(stamp) ?? 0) > outcome.auth.ts) {
      input.state = { ...input.state, authRecoveredThrough: Math.max(input.state.authRecoveredThrough ?? 0, outcome.auth.ts) };
    }
    incident = openSeatAuthIncident(input.project, seat, outcome, input.state.authRecoveredThrough, stamp) ?? undefined;
    if (incident) input.state = { ...input.state, authIncident: incident };
  }
  if (!incident) return null;
  if (incident.recoveredThrough === undefined && seat && incident.seatEpoch === seat.seatEpoch && incident.conversationId === seat.conversationId
    && outcome?.auth && outcome.auth.ts > incident.lastFailedTs) incident.lastFailedTs = outcome.auth.ts;
  if (incident.recoveredThrough === undefined && closingThrough === undefined && (incident.rotation.state === "pending" || incident.rotation.state === "held")) {
    if (activeDrain()) {
      incident.rotation.state = "held";
      return `${incident.id}: held`;
    }
    const current = sources.seatFor(input.project).active;
    if (!current || current.seatEpoch !== incident.seatEpoch) { close(); return null; }
    // Persist identity before any external effect. Failed persistence must
    // prevent the effect; a retry has the original first-failure key.
    persist();
    let choice: ReturnType<typeof accountManager.resolveProjectSpawn> | null = null;
    let choiceFailed = false;
    const refused = (error: unknown) => {
      incident!.rotation = { ...incident!.rotation, state: "refused", error: error instanceof Error ? error.message : "rotation failed" };
    };
    try {
      choice = incident.accountId ? accountManager.resolveProjectSpawn(incident.engine, {
        project: input.project, model: current.model ?? undefined, unavailableIds: [incident.accountId],
      }) : null;
    } catch (error) { refused(error); choiceFailed = true; }
    if (choice?.kind === "available" && choice.account.accountId !== incident.accountId) {
      const targetAccountId = choice.account.accountId;
      incident.rotation.toAccountId = targetAccountId;
      // Propagate checkpoint errors so a later check can retry persistence.
      persist();
      try {
        const rotate = ports.rotate ?? (await import("@/lib/orchestrator/seatCommand")).executeOrchestratorRotation;
        if (activeDrain()) { incident.rotation.state = "held"; return `${incident.id}: held`; }
        const failedLabel = seatAuthAccounts(incident.engine).find((row) => row.id === incident!.accountId)?.label ?? "?";
        const result = await rotate({
          project: input.project, clientRequestId: seatAuthRotationKey(incident.id),
          expectedIncumbentSeatEpoch: incident.seatEpoch, accountId: targetAccountId,
          handoffNotes: `Automatic rotation after authentication failure on ${incident.engine} account ${failedLabel}`,
        }, undefined, null, {
          autonomous: true,
          assertAccount: (accountId) => {
            if (accountId !== targetAccountId) throw new Error("automatic authentication recovery target changed");
            // A target selected before the handoff is still an automatic pick.
            // Restrict the shared capacity selector to it at each admission.
            const admitted = accountManager.resolveProjectSpawn(incident!.engine, {
              project: input.project, model: current.model ?? undefined,
              unavailableIds: seatAuthAccounts(incident!.engine).filter((row) => row.id !== accountId).map((row) => row.id),
            });
            if (admitted.kind !== "available") throw new ProjectAccountRefusedError(admitted, incident!.engine, input.project);
            if (admitted.account.accountId !== accountId) throw new Error("automatic authentication recovery target changed");
          },
        });
        if (result.body.code === "launch_held_for_update" || result.body.code === "AUTO_UPDATE_DRAIN") {
          incident.rotation.state = "held";
          return `${incident.id}: held`;
        }
        if (result.status === 409 && (result.body.code === "incumbent_changed" || sources.seatFor(input.project).active?.seatEpoch !== incident.seatEpoch)) {
          close(); return null;
        }
        const successor = sources.seatFor(input.project).active;
        // A receipt lookup can answer HTTP 200 with a terminal launch failure.
        // The ordinary command's activated seat proves that the move happened,
        // including a durable 202 admission awaiting its transcript.
        const rotated = result.status >= 200 && result.status < 300 && result.body.ok !== false
          && successor?.intent.clientRequestId === seatAuthRotationKey(incident.id) && successor.seatEpoch !== incident.seatEpoch;
        incident.rotation = rotated
          ? { ...incident.rotation, state: "rotated", successorConversationId: successor?.conversationId ?? undefined }
          : { ...incident.rotation, state: "refused", error: String(result.body.error ?? "rotation failed") };
      } catch (error) { refused(error); }
    } else if (!choiceFailed) incident.rotation.state = "none-allowed";
    persist();
  }
  if (!incident.notice?.card) {
    if (activeDrain()) return `${incident.id}: held`;
    const accounts = seatAuthAccounts(incident.engine);
    let allowed: string[] | null = null;
    try { allowed = allowedAccountIdsForProject(input.project, incident.engine); }
    catch (error) {
      if (!(error instanceof AccountProjectBindingsUnreadableError)) throw error;
      // Authentication and the selection refusal remain reportable even when
      // the pool cannot be read. Outside-account enumeration is unverified.
    }
    const locale = operatorLocale() === "en" ? "en" : "uk";
    const notice = seatAuthNotice(incident, new Map(accounts.map((row) => [row.id, row.label])),
      allowed ? accounts.filter((row) => !allowed.includes(row.id)).map((row) => row.id) : [], locale, reportHeaderName(input.project, locale));
    const { renderReport, renderPlain, REPORT_ITEM_MAX_CHARS } = await import("@/lib/bridge/reportRender");
    const { renderTelegram } = await import("@/lib/bridge/telegramReport");
    const { recordManagerReport } = await import("@/lib/bridge/service");
    const { findBridgeReport, scopedReportId, recordBridgeReportTelegram } = await import("@/lib/bridge/store");
    const reportClass = incident.rotation.state === "rotated" || incident.recoveredThrough !== undefined ? "status" : "blocked";
    const items = (paragraph: string): string[] => {
      const chunks: string[] = [];
      let chunk = "";
      for (const word of paragraph.split(/\s+/)) {
        if (chunk && chunk.length + word.length + 1 > REPORT_ITEM_MAX_CHARS) { chunks.push(chunk); chunk = ""; }
        chunk += `${chunk ? " " : ""}${word.slice(0, REPORT_ITEM_MAX_CHARS)}`;
      }
      if (chunk) chunks.push(chunk);
      return chunks;
    };
    const rendered = renderReport({ class: reportClass, name: "Delegatus", at: new Date(incident.firstFailedAt), locale,
      timeZone: operatorTimeZone(), summary: notice.summary,
      // The renderer preserves the decision section when it cuts for size.
      // Keep the login action there so a long diagnostic cannot crowd it out.
      sections: { decision: items(notice.action), inProgress: [notice.failure, ...(notice.pool ? [notice.pool] : [])].flatMap(items) } });
    const destination = effectiveReportTelegram(input.project);
    const html = renderTelegram(rendered.cut);
    if (activeDrain()) return `${incident.id}: held`;
    const report = bridgeReportsEnabled(input.project)
      ? recordManagerReport({ key: incident.id, origin: { kind: "agent", role: "seat-tick", conversationId: null },
        project: input.project, targetSeatConversationId: incident.conversationId, class: reportClass, at,
        body: renderPlain(rendered.cut), ...(destination ? { telegram: { chat: destination.chat, html, ...(destination.topicId ? { topicId: destination.topicId } : {}) } } : {}) })
        ?? findBridgeReport(scopedReportId(input.project, incident.id)) : null;
    let telegram: "sent" | "failed" | "skipped" = "skipped";
    if (destination) {
      try {
        let send = ports.telegram;
        if (!send) {
          const service = (await import("@/lib/telegram/bot/service")).telegramBotService();
          send = service.send.bind(service);
        }
        if (activeDrain()) return `${incident.id}: held`;
        const sent = await send({ conversationId: null, clientRequestId: incident.id, chat: destination.chat,
          ...(destination.topicId ? { topicId: destination.topicId } : {}), text: html, format: "html", silent: false });
        telegram = "sent";
        if (report) recordBridgeReportTelegram(report.id, { state: "sent", at, messageIds: sent.messageIds });
      } catch (error) {
        telegram = "failed";
        if (telegramRefusedBeforeSend(error) && !input.state.authTelegramOwed?.some((notice) => notice.id === incident!.id)) {
          input.state = { ...input.state, authTelegramOwed: [...(input.state.authTelegramOwed ?? []), {
            id: incident.id, chat: destination.chat, html, ...(destination.topicId ? { topicId: destination.topicId } : {}),
          }] };
          persist();
        }
        if (report) recordBridgeReportTelegram(report.id, { state: "failed", at, code: error instanceof Error && "code" in error ? String(error.code) : "telegram_failed" });
      }
    }
    // Create then resolve a rotated notice: a resolved write alone creates no
    // card, and would erase the board's only evidence that this happened.
    if (activeDrain()) return `${incident.id}: held`;
    input.state = { ...input.state, authCardsOwed: [...(input.state.authCardsOwed ?? []).filter(card => card.id !== incident!.id), {
      id: incident.id, detail: notice.body, state: incident.rotation.state === "rotated" && !provisionalSuccessor() ? "resolved" : "open",
    }] };
    persist();
    let card = writeCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "open", detail: notice.body }, at);
    if (card && incident.rotation.state === "rotated" && !provisionalSuccessor()) card = writeCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "resolved", detail: notice.body }, at);
    if (card) input.state = { ...input.state, authCardsOwed: input.state.authCardsOwed?.filter(notice => notice.id !== incident!.id) };
    incident.notice = { ...(report ? { bridgeSeq: report.seq } : {}), telegram, card };
  }
  if (incident.recoveredThrough !== undefined || (closingThrough !== undefined && incident.notice?.card)) {
    close(incident.recoveredThrough ?? closingThrough, true);
    if (!incident) return recoverSeatAuthentication(input, sources, readState, writeState, ensureCard, ports);
  }
  if (incident.notice && incident.seatEpoch !== seat?.seatEpoch && !provisionalSuccessor()) {
    // Finish the predecessor's independent notice, then judge the successor's
    // own turn in this same check. Its failure cannot advance the old boundary.
    close();
    if (!incident) return recoverSeatAuthentication(input, sources, readState, writeState, ensureCard, ports);
  }
  return `${incident.id}: ${incident.rotation.state}`;
}
