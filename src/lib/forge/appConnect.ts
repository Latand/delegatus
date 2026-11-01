import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { agentForgeDir, declareForgeAppRepository, forgeAppRepositories } from "@/lib/git/agentForgeCredentials";
import { statePath } from "@/lib/configDir";
import { recordedProjectRemote } from "@/lib/projects/aliases";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { githubRepositoryLookup } from "@/lib/projects/forgeRename";
import { operatorLocale } from "@/lib/operator/settings";
import { prototypePublicationId, publishPrototype } from "@/lib/prototypeReview/store";
import { findSeatRound, mutateSeatRound } from "@/lib/prototypeReview/seatRounds";
import { postPrototypeReviewToTelegram } from "@/lib/prototypeReview/telegramPost";
import { issueReportDecisionApproves } from "@/lib/issueReports/approvalForm";
import { PrototypeError } from "@/lib/prototypeReview/input";
import { currentSeat } from "@/lib/orchestrator/seatChannel";
import { prototypeDelivery } from "@/lib/prototypeReview/decision";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { appConnectOpen, AppConnectStore } from "./appConnectStore";
import { APP_CONNECT_QUESTION, appConnectForm } from "./appConnectForm";
import type { AppConnectContext, AppConnectDiscovery, AppConnectResponse, AppConnectRow, AppPermissions } from "./appConnectTypes";
import type { PrototypeReviewRound, PublishPrototypeInput } from "@/lib/prototypeReview/types";
import { connectPermissions, connectRepository, FORGE_AUDIT_ENV, FORGE_REPOSITORIES_ENV } from "../../../bin/forge-app-token.mjs";

const exec = promisify(execFile);
export const APP_CONNECT_WINDOW_MS = 24 * 60 * 60_000;
export const APP_CONNECT_MAX_CHECKS = 315;
const ERRORS: Record<string, string> = {
  not_permitted: "Only a project's designated seat or the operator's own session asks to connect a repository.",
  invalid_repository: "Pass a github.com repository as owner/name, or give owner and repository separately.",
  invalid_permissions: "Pass up to twenty GitHub permission keys with read or write levels.",
  app_credential_unavailable: "No declared repository holds a readable GitHub App credential. Unlock the credential store or register the App first.",
  github_unreachable: "GitHub could not be read. Nothing was sent to the operator; call again.",
  form_refused: "The decision form could not be published; call again after resolving its refusal.",
};
const ERROR_KIND = Symbol.for("delegatus.forge-app-connect.error");
export class AppConnectError extends Error {
  readonly [ERROR_KIND] = true;
  constructor(readonly code: string, readonly status = 400, message = ERRORS[code] ?? code, readonly reason?: string) { super(message); }
}
export const isAppConnectError = (error: unknown): error is AppConnectError => error instanceof Error && (error as AppConnectError)[ERROR_KIND] === true;
export interface AppConnectCaller { conversationId: string; project: string; operator?: boolean; authorize(): void }
export interface AppConnectInput { clientRequestId: string; repository: string; owner?: string; permissions?: AppPermissions }
export interface AppConnectPorts {
  now(): number;
  requestId(): string;
  ownsTraffic(): boolean;
  discover(repository: string, options: { permissions: AppPermissions; context?: AppConnectContext; store?: number }): Promise<AppConnectDiscovery>;
  repository(repository: string): Promise<{ repository: string; id: number | null }>;
  own(project: string, repository: string): boolean;
  publish(input: PublishPrototypeInput, row: AppConnectRow, beforeWrite: () => void): Promise<PrototypeReviewRound>;
  telegram(round: PrototypeReviewRound): Promise<unknown>;
  round(id: string): PrototypeReviewRound | undefined;
  close(row: AppConnectRow): void;
  declare(repository: string, beforeWrite: () => void): Promise<boolean>;
  notify(row: AppConnectRow): Promise<boolean | null>;
}

/** No stdout from a failed child crosses this boundary. */
export async function discoverAppConnection(repository: string, options: { permissions: AppPermissions; context?: AppConnectContext; store?: number }, source = process.env): Promise<AppConnectDiscovery> {
  const declared = forgeAppRepositories();
  if (!declared.length) throw new AppConnectError("app_credential_unavailable", 503);
  const helper = path.join(agentForgeDir(source), "forge-app-token.mjs");
  try {
    const { stdout } = await exec("bun", [helper, "app-connect", "--repository", repository, "--from", declared.join(","),
      "--permissions", JSON.stringify(options.permissions), ...(options.context ? ["--context", JSON.stringify(options.context)] : []),
      ...(options.store !== undefined ? ["--store", String(options.store)] : [])], {
      env: { ...source, [FORGE_REPOSITORIES_ENV]: declared.join(","), [FORGE_AUDIT_ENV]: statePath("forge-app-tokens.ndjson") }, timeout: 240_000, maxBuffer: 32 * 1024,
    });
    return JSON.parse(stdout) as AppConnectDiscovery;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const line = typeof stderr === "string" ? /^Delegatus: ([a-z_]+)(?:: ([^\r\n]{1,300}))?\n?$/.exec(stderr) : null;
    throw new AppConnectError(line?.[1] ?? "verification_failed", 503, undefined, line?.[1] === "verification_failed" ? line[2] : undefined);
  }
}

export function appConnectOwnRepository(project: string, repository: string): boolean {
  return githubRepositoryOfRemote(recordedProjectRemote(project) ?? "")?.toLowerCase() === repository.toLowerCase();
}

export function closeAppConnectForm(row: AppConnectRow, now = Date.now()) {
  const id = row.reviewId ?? (row.form ? prototypePublicationId(`${row.conversationId}:${row.form.clientRequestId}`) : undefined);
  if (!id || !findSeatRound(id)) return;
  mutateSeatRound(id, round => {
    if (round.decision) return;
    round.decision = { chosen: [], comment: `GitHub App: ${row.state}`, at: new Date(now).toISOString(),
      decidedBy: { kind: "agent", conversationId: row.conversationId },
      delivery: { state: "sent", clientMessageId: `forge-connect:${row.requestId}:close`, conversationId: null, text: "" } };
  });
}

const productionPorts: AppConnectPorts = {
  now: Date.now,
  requestId: () => crypto.randomBytes(16).toString("hex"),
  ownsTraffic: viewerReleaseOwnsTraffic,
  discover: discoverAppConnection,
  async repository(repository) {
    const result = await githubRepositoryLookup(repository);
    if (result.status === "unreachable") throw new AppConnectError("github_unreachable", 503);
    return result.status === "found" ? { repository: result.fullName ?? repository, id: result.id } : { repository, id: null };
  },
  own: appConnectOwnRepository,
  publish: (input, row, beforeWrite) => publishPrototype(input, null, { conversationId: row.conversationId }, row.project, undefined, beforeWrite),
  telegram: postPrototypeReviewToTelegram,
  round: findSeatRound,
  close: closeAppConnectForm,
  declare: (repository, beforeWrite) => declareForgeAppRepository(repository, undefined, beforeWrite),
  async notify(row) {
    const seat = currentSeat(row.project);
    if (!seat?.conversationId) return null;
    const text = `GitHub App ${row.repository}: ${row.state}.` +
      (row.state === "connected" ? " Stored, proved and declared; applies to new launches." : "") +
      (row.state === "expired" ? ` Confirmation window closed; still missing: ${row.discovery.covered ? row.discovery.missingPermissions.join(", ") || "verified permission proof" : "repository installation"}. Call github_app_connect again to ask again.` : "") +
      (row.state === "verification_failed" ? " Call github_app_connect with a fresh clientRequestId for the current check details." : "");
    const result = await prototypeDelivery.send({ chosen: [], comment: "", at: new Date().toISOString(), decidedBy: { kind: "agent", conversationId: row.conversationId },
      delivery: { state: "pending", clientMessageId: `forge-connect:${row.requestId}:${row.state}`, conversationId: seat.conversationId, text } });
    return result.state === "sent";
  },
};

const response = (row: AppConnectRow): AppConnectResponse => ({ requestId: row.requestId, repository: row.repository, state: row.state,
  ...(row.reviewId ? { reviewId: row.reviewId } : {}), expiresAt: new Date(row.expiresAt).toISOString(), prerequisite: row.discovery.context.prerequisite,
  installationId: row.discovery.installationId, installationUrl: row.discovery.installationUrl,
  missingPermissions: row.discovery.missingPermissions, missingAppPermissions: row.discovery.missingAppPermissions,
  preselected: row.repositoryId !== null, changed: row.changed ?? false, appliesTo: "new launches", ...(row.lastError ? { lastError: row.lastError } : {}) });

/** A single owner serializes helper children; durable rows hold all budgets,
 * confirmation evidence and publication inputs across restart.
 */
export class AppConnectService {
  private pending: Promise<unknown> = Promise.resolve();
  private cursor = -1;
  constructor(readonly store = new AppConnectStore(), readonly ports: AppConnectPorts = productionPorts) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation);
    this.pending = run.catch(() => undefined);
    return run;
  }
  request(input: AppConnectInput, caller: AppConnectCaller): Promise<AppConnectResponse> {
    return withViewerOperation("forge.app-connect", () => this.serial(async () => {
      this.checkCaller(caller.authorize);
      const slug = connectRepository(input.repository, input.owner);
      if (!slug) throw new AppConnectError("invalid_repository");
      let permissions: AppPermissions;
      try { permissions = connectPermissions(input.permissions) as AppPermissions; } catch { throw new AppConnectError("invalid_permissions"); }
      const receiptKey = `receipt:${crypto.createHash("sha256").update(`${caller.conversationId}:${input.clientRequestId}`).digest("hex")}`;
      const digest = crypto.createHash("sha256").update(JSON.stringify([slug.toLowerCase(), permissions, caller.project])).digest("hex");
      const receipt = this.store.get(receiptKey);
      if (receipt?.kind === "receipt") {
        if (receipt.digest !== digest) throw new AppConnectError("request_key_conflict", 409);
        return receipt.response;
      }
      let row = this.store.request(slug);
      if (row && appConnectOpen(row)) {
        if (JSON.stringify(row.permissions) !== JSON.stringify(permissions)) throw new AppConnectError("request_permissions_conflict", 409);
        row = await this.advance(row, true, caller.authorize);
      } else {
        const found = await this.ports.repository(slug);
        this.checkCaller(caller.authorize);
        const repository = connectRepository(found.repository);
        if (!repository) throw new AppConnectError("invalid_repository");
        const d = await this.ports.discover(repository, { permissions });
        this.checkCaller(caller.authorize);
        const now = this.ports.now();
        const old = row;
        if (old?.state === "connected" && JSON.stringify(old.permissions) === JSON.stringify(permissions) && d.covered && !d.missingPermissions.length && old.discovery.installationId === d.installationId) {
          old.discovery = d;
          await this.settle(old);
          this.checkCaller(caller.authorize);
          const answer = response(old);
          this.store.put({ kind: "receipt", key: receiptKey, digest, response: answer });
          return answer;
        }
        row = { kind: "request", key: repository.toLowerCase(), requestId: this.ports.requestId(), repository, project: caller.project,
          conversationId: caller.conversationId, permissions, ownRepository: caller.operator === true || this.ports.own(caller.project, repository),
          absentAtRequest: !d.covered, createdAt: now, expiresAt: now + APP_CONNECT_WINDOW_MS, nextAt: now + 30_000, checks: 1,
          state: d.covered ? (d.missingPermissions.length ? "missing_permissions" : "awaiting_answer") : d.pending ? "awaiting_owner" : d.installationId ? "missing_repository" : "awaiting_click",
          discovery: d, repositoryId: found.id };
        // An expired request already showed the own-repository installation form.
        if (old?.state === "expired" && row.ownRepository && old.ownRepository && old.absentAtRequest && d.covered && !d.missingPermissions.length) {
          row.absentAtRequest = true;
        } else row.form = appConnectForm(row, operatorLocale() ?? "en");
        this.store.put(row);
        ensureAppConnectPoller();
        row = await this.advance(row, false, caller.authorize);
      }
      this.checkCaller(caller.authorize);
      const answer = response(row);
      this.store.put({ kind: "receipt", key: receiptKey, digest, response: answer });
      ensureAppConnectPoller();
      return answer;
    }));
  }
  private confirmed(row: AppConnectRow): boolean {
    const decision = row.reviewId ? this.ports.round(row.reviewId)?.decision : undefined;
    return issueReportDecisionApproves(decision, APP_CONNECT_QUESTION) ||
      (row.ownRepository && row.absentAtRequest && row.discovery.covered);
  }
  private cancelled(row: AppConnectRow): boolean {
    const decision = row.reviewId ? this.ports.round(row.reviewId)?.decision : undefined;
    return !!decision && ["operator", "member"].includes(decision.decidedBy?.kind ?? "") &&
      (decision.rejected === true || decision.answers?.some(a => a.questionId === APP_CONNECT_QUESTION && !a.skipped && !a.other && a.options.length === 1 && a.options[0] === 1) === true);
  }
  private checkCaller(authorize: () => void) {
    authorize();
    if (!this.ports.ownsTraffic()) throw new AppConnectError("release_replaced", 503);
  }
  private checkAuthority(row: AppConnectRow, authorize: () => void) {
    this.checkCaller(authorize);
    if (this.ports.now() >= row.expiresAt || this.cancelled(row)) throw new AppConnectError("confirmation_ended", 409);
  }
  private async advance(row: AppConnectRow, fresh: boolean, authorize = () => {}) {
    if (!appConnectOpen(row)) { await this.settle(row); return row; }
    if (this.cancelled(row)) row.state = "cancelled";
    else if (this.ports.now() >= row.expiresAt) row.state = "expired";
    if (!appConnectOpen(row)) { this.store.put(row); await this.settle(row); return row; }
    try {
      this.checkAuthority(row, authorize);
      if (row.form && !row.reviewId) {
        let round: PrototypeReviewRound;
        try { round = await this.ports.publish(row.form, row, () => this.checkAuthority(row, authorize)); }
        catch (error) { if (isAppConnectError(error)) throw error; throw new AppConnectError("form_refused", error instanceof PrototypeError ? error.status : 503, error instanceof PrototypeError ? error.message : undefined); }
        this.checkCaller(authorize);
        row.reviewId = round.id;
        this.store.put(row);
        this.checkAuthority(row, authorize);
        await this.ports.telegram(round);
        this.checkAuthority(row, authorize);
      }
      if (fresh && row.checks >= APP_CONNECT_MAX_CHECKS) {
        row.nextAt = row.expiresAt;
        this.store.put(row);
        await this.settle(row);
        return row;
      }
      if (fresh) {
        // Spend before launching; a crash or timeout never refunds a check.
        row.checks++;
        row.nextAt = Math.min(row.expiresAt, this.ports.now() + (this.ports.now() - row.createdAt < 15 * 60_000 ? 30_000 : 5 * 60_000));
        this.store.put(row);
        row.discovery = await this.ports.discover(row.repository, { permissions: row.permissions, context: row.discovery.context });
        this.checkAuthority(row, authorize);
      }
      if (row.checks >= APP_CONNECT_MAX_CHECKS) row.nextAt = row.expiresAt;
      row.lastError = undefined;
      const d = row.discovery;
      // One replacement when GitHub installed the App without this repository.
      if (!d.covered && d.installationId && row.form && !row.replacedForm && !row.form.questions?.[0]?.links?.some(link => link.href === d.installationUrl)) {
        this.ports.close(row);
        row.replacedForm = true;
        row.reviewId = undefined;
        row.form = appConnectForm(row, operatorLocale() ?? "en");
        this.store.put(row);
        const round = await this.ports.publish(row.form, row, () => this.checkAuthority(row, authorize));
        this.checkCaller(authorize);
        row.reviewId = round.id;
        this.store.put(row);
        this.checkAuthority(row, authorize);
        await this.ports.telegram(round);
        this.checkAuthority(row, authorize);
      }
      if (d.covered && !d.missingPermissions.length && this.confirmed(row)) {
        this.checkAuthority(row, authorize);
        const proof = await this.ports.discover(row.repository, { permissions: row.permissions, context: d.context, store: d.installationId! });
        this.checkAuthority(row, authorize);
        if (!proof.proved || proof.installationId !== d.installationId) throw new AppConnectError("verification_failed", 503);
        if (!this.confirmed(row)) throw new AppConnectError("confirmation_ended", 409);
        row.changed = (await this.ports.declare(row.repository, () => {
          this.checkAuthority(row, authorize);
          if (!this.confirmed(row)) throw new AppConnectError("confirmation_ended", 409);
        })) || row.changed === true;
        this.checkCaller(authorize);
        row.discovery = proof;
        row.state = "connected";
      } else row.state = d.covered ? (d.missingPermissions.length ? "missing_permissions" : "awaiting_answer")
        : d.pending ? "awaiting_owner" : d.installationId ? "missing_repository" : "awaiting_click";
    } catch (error) {
      this.checkCaller(authorize);
      if (isAppConnectError(error) && error.code === "not_permitted") throw error;
      if (isAppConnectError(error) && error.code === "form_refused") { row.lastError = error.code; this.store.put(row); throw error; }
      row.lastError = isAppConnectError(error) ? error.reason ?? error.code : "verification_failed";
      if (this.cancelled(row)) row.state = "cancelled";
      else if (this.ports.now() >= row.expiresAt) row.state = "expired";
      else if (!(isAppConnectError(error)) || error.code === "verification_failed") row.state = "verification_failed";
    }
    this.store.put(row);
    await this.settle(row);
    return row;
  }
  private async settle(row: AppConnectRow) {
    if (!this.ports.ownsTraffic()) return;
    if (!appConnectOpen(row)) this.ports.close(row);
    if (row.notifiedState !== row.state) {
      try {
        const delivered = await this.ports.notify(row);
        if (!this.ports.ownsTraffic()) return;
        row.notificationDeferred = delivered === null;
        if (delivered) row.notifiedState = row.state;
        this.store.put(row);
      }
      catch { /* Stable send key reconciles an unobserved receipt on the next pass. */ }
    }
  }
  tick(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.ports.ownsTraffic()) return false;
      let page = this.store.page(this.cursor);
      if (!page.rows.length && this.cursor !== -1) { this.cursor = -1; page = this.store.page(); }
      this.cursor = page.cursor;
      for (const row of page.rows) {
        if (!this.ports.ownsTraffic()) break;
        if (this.ports.now() >= row.nextAt || !appConnectOpen(row)) await this.advance(row, true);
      }
      return this.store.page().rows.length > 0;
    });
  }
}

// Next compiles instrumentation and routes separately. They share this owner,
// including the idle controller that a later route request must wake.
const CONTROLLER = Symbol.for("delegatus.forge-app-connect");
type Controller = { service?: AppConnectService; started: boolean; timer?: ReturnType<typeof setTimeout> };
const globals = globalThis as typeof globalThis & { [CONTROLLER]?: Controller };
const controller = globals[CONTROLLER] ??= { started: false };
export const appConnectService = () => controller.service ??= new AppConnectService();
export function setAppConnectServiceForTests(value: AppConnectService | undefined) {
  controller.service = value;
  if (!value) {
    controller.started = false;
    if (controller.timer) clearTimeout(controller.timer);
    controller.timer = undefined;
  }
}
export function ensureAppConnectPoller() {
  if (!controller.started || controller.timer) return;
  controller.timer = setTimeout(() => {
    controller.timer = undefined;
    void withViewerOperation("forge.app-connect", () => appConnectService().tick()).then(active => {
      if (active) ensureAppConnectPoller();
    }).catch(error => {
      console.error("[forge app connect] poll failed", error instanceof Error ? error.name : "unknown");
      ensureAppConnectPoller();
    });
  }, 30_000);
  controller.timer.unref?.();
}
export function startAppConnectPoller() { controller.started = true; ensureAppConnectPoller(); }
