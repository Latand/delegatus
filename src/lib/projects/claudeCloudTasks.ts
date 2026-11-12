import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { CLAUDE_ALIAS_RELEASES } from "@/lib/agent/models";
import type { AccountContext } from "@/lib/accounts/contracts";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { projectAllowsAccount } from "@/lib/accounts/projectBindings";
import { statePath } from "@/lib/configDir";
import { translate } from "@/lib/i18n/core";
import { operatorLocale } from "@/lib/operator/settings";
import { initializeStateCollectionsAsync, readStateCollectionRevision, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { HostedCloudError } from "@/lib/pipelines/cloudHostedErrors";
import { CLAUDE_CLOUD_TASK_PROMPT } from "@/lib/pipelines/claudeCloudTaskPrompt";
import { canonicalProject, projectAliasKeys, recordedProjectRemote } from "./aliases";
import { claudeCloudTasks, claudeCloudTaskFingerprint, setClaudeCloudTaskFor } from "./settings";
import type { PrepareCloudEnvironmentInput, CloudEnvironmentPreparation } from "./codexCloudEnvironments";

export const CLAUDE_TASK_REASONS = {
  login_missing: "the account’s claude.ai sign-in is missing on this machine",
  login_expired: "the account’s claude.ai sign-in expired; it refreshes on the account’s next local run",
  third_party_provider: "this account uses a third-party provider; Claude Cloud needs a claude.ai subscription",
  login_refused: "Claude Cloud login was refused",
  github_not_connected: "GitHub is not connected to this Claude account",
  github_write_access: "this account’s GitHub connection can write; its stages stay local for six hours after each probe",
  no_environment: "this Claude account has no cloud environment",
  task_list_incomplete: "the account’s task list has a further page that Delegatus does not read; nothing was created",
  create_uncertain: "a task creation may have succeeded; Delegatus is reconciling and creates no other",
  create_refused: "Claude Cloud refused the task creation",
  update_refused: "Claude Cloud refused to enable the task or clear its connectors",
  task_invalid: "the Claude cloud task record has an unrecognised shape",
  provider_unavailable: "Claude Cloud could not be reached or answered with an error",
  binding_busy: "project settings were busy; the binding is retried",
} as const;
export type ClaudeTaskReason = keyof typeof CLAUDE_TASK_REASONS;
const codes = Object.keys(CLAUDE_TASK_REASONS) as [ClaudeTaskReason, ...ClaudeTaskReason[]];
const instant = z.number().finite().nonnegative();
const rowSchema = z.object({ key: z.string().max(1024), project: z.string().min(1).max(256), accountId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), repository: z.string().max(160),
  organization: z.string().regex(/^[a-f0-9]{64}$/).nullable(), taskId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).nullable(), state: z.enum(["preparing", "ready", "unavailable"]),
  code: z.enum(codes).nullable(), status: z.number().int().optional(), validatedAt: instant.nullable(), retryAt: instant, deadlineAt: instant,
  retries: z.number().int().min(0).max(3), revision: z.number().int().nonnegative(),
  create: z.object({ intent: z.string().min(1).max(200), dispatchedAt: instant.optional(), listsAfterDispatch: z.number().int().min(0).max(2).optional(), releasedAt: instant.optional() }).strict(),
}).strict();
export type ClaudeTaskRow = z.infer<typeof rowSchema>;
type Row = Record<string, unknown>;
const record = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const collection = "claude_cloud_tasks";
const seed = { collection, schemaVersion: 1, migrationId: "claude-cloud-tasks-v1", key: (r: ClaudeTaskRow) => r.key, loadRecords: (): ClaudeTaskRow[] => [] };
function store(): SqliteStateCollection<ClaudeTaskRow> | null {
  const file = statePath("state.sqlite");
  return readStateCollectionRevision(file, collection) === null ? null : new SqliteStateCollection<ClaudeTaskRow>(file, { ...seed, clone: structuredClone,
    decode: value => { const parsed = rowSchema.safeParse(value); return parsed.success ? parsed.data : null; }, strictDecode: true, busyMessage: "Claude task readiness is busy" });
}
function read(project: string, accountId: string): ClaudeTaskRow | null {
  const db = store();
  try { for (const alias of projectAliasKeys(project)) { const found = db?.get(`${digest(alias)}!${accountId}`); if (found) return found; } return null; }
  finally { db?.close(); }
}
class Superseded extends Error {}
async function update(value: ClaudeTaskRow, expected: number, guard: () => void): Promise<ClaudeTaskRow> {
  const checked = rowSchema.parse(value);
  await initializeStateCollectionsAsync(statePath("state.sqlite"), [seed]);
  const db = store()!;
  try { return await db.mutate(async (rows, persist) => {
    guard();
    const currentKey = read(value.project, value.accountId)?.key;
    if (currentKey && currentKey !== value.key) throw new Superseded();
    if ((rows.find(r => r.key === value.key)?.revision ?? 0) !== expected) throw new Superseded();
    const next = rowSchema.parse({ ...checked, revision: expected + 1 });
    await persist([next]); return next;
  }, guard, false, 1000, undefined, [value.key]); } finally { db.close(); }
}
export function claudeCloudTasksRevision(): number | null { return readStateCollectionRevision(statePath("state.sqlite"), collection); }

const steps = {
  github_not_connected: { code: "connect_github", key: "claudeCloud.connectGithub", url: "https://claude.ai/connect-github" },
  github_write_access: { code: "github_read_only", key: "claudeCloud.githubReadOnly", url: "https://github.com/settings/installations" },
  no_environment: { code: "create_environment", key: "claudeCloud.createEnvironment", url: "https://claude.ai/code/onboarding?magic=env-setup" },
} as const;
export function claudeTaskStep(code: ClaudeTaskReason | null) {
  const step = code && code in steps ? steps[code as keyof typeof steps] : null;
  return step ? { code: step.code, text: translate(operatorLocale() ?? "en", step.key), url: step.url } : null;
}
/** Reads the probe artifact without modifying it. An expired hold still explains the remedy. */
export function claudeTaskWriteAccess(accountId: string, taskId: string | null, now = Date.now()) {
  if (!taskId) return null;
  try { const observedAt = record(JSON.parse(fs.readFileSync(statePath("cloud/claude-write-access.json"), "utf8")))[`${accountId}/${taskId}`];
    return typeof observedAt === "number" && Number.isFinite(observedAt) ? { observedAt, heldUntil: observedAt + 6 * 3_600_000, held: now < observedAt + 6 * 3_600_000 } : null;
  } catch { return null; }
}
export function readClaudeCloudReadiness(project: string, options: { accountId?: string; now?: number } = {}) {
  return listClaudeAccounts().filter(a => (!options.accountId || a.id === options.accountId) && projectAllowsAccount(project, "claude", a.id)).map(account => {
    const row = read(project, account.id), repository = recordedProjectRemote(project);
    const selected = claudeCloudTasks(project).find(task => task.accountId === account.id)?.taskId;
    const current = row && normalizeClaudeGithubUrl(repository) === row.repository && (row.state !== "ready" || selected === row.taskId) ? row : null;
    const writeAccess = claudeTaskWriteAccess(account.id, current?.taskId ?? null, options.now);
    const expired = current?.state === "preparing" && current.deadlineAt <= (options.now ?? Date.now());
    const code = writeAccess?.held ? "github_write_access" : expired ? "provider_unavailable" : current?.code ?? null;
    return { project: canonicalProject(project), accountId: account.id, label: account.label,
      state: writeAccess?.held || expired ? "unavailable" : current?.state ?? "not_prepared", code,
      reason: code ? CLAUDE_TASK_REASONS[code] + (current?.status ? ` (${current.status})` : "") : null,
      step: claudeTaskStep(code ?? (writeAccess ? "github_write_access" : null)), taskId: current?.taskId ?? null,
      writeAccess, validatedAt: current?.validatedAt ?? null, retryAt: current?.retryAt ?? 0, revision: current?.revision ?? 0 };
  });
}
export function normalizeClaudeGithubUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : null;
}
function context(task: Row): Row {
  const ccr = record(record(record(task.job_config).ccr).session_context);
  return Object.keys(ccr).length ? ccr : record(record(task.session_request).session_context);
}
function sameRepo(task: Row, repository: string): boolean {
  const sources = context(task).sources;
  return Array.isArray(sources) && sources.length === 1 && normalizeClaudeGithubUrl(record(record(sources[0]).git_repository).url ?? record(sources[0]).url) === repository;
}
function connectors(task: Row): boolean {
  const values = [task.mcp_connections, context(task).mcp_connector_ids];
  if (values.some(v => v !== undefined && v !== null && !Array.isArray(v))) throw new ClaudeTaskError("task_invalid");
  return values.some(v => Array.isArray(v) && v.length > 0);
}
const promptText = (task: Row) => {
  const events = record(record(task.job_config).ccr).events;
  return Array.isArray(events) ? events.map(e => {
    const content = record(record(record(e).data).message).content ?? record(record(e).message).content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map(b => record(b).text ?? "").join(" ") : "";
  }).join(" ").replace(/\s+/g, " ").trim() : "";
};
export class ClaudeTaskError extends HostedCloudError {
  constructor(readonly code: ClaudeTaskReason, readonly status?: number, readonly transient = false) { super(CLAUDE_TASK_REASONS[code], code === "login_refused" ? "account-limit" : transient ? "unavailable" : "cloud-limit"); }
}
export interface ClaudeTaskProvider {
  identity(account: AccountContext): Promise<string>;
  request(account: AccountContext, signal: AbortSignal, method: "GET" | "POST", path: string, body?: Row, fence?: { principal: string; assertCurrent: () => void }): Promise<Response>;
}
/** Every mutation follows a persisted revision claim; remote waits hold no storage lease. */
export async function prepareClaudeCloudTask(input: PrepareCloudEnvironmentInput & { force?: boolean }, provider: ClaudeTaskProvider): Promise<CloudEnvironmentPreparation> {
  const now = input.now ?? Date.now, project = canonicalProject(input.project), accountId = input.account.accountId;
  const repository = normalizeClaudeGithubUrl(`https://github.com/${input.repository}`);
  if (!repository) return { state: "unavailable", reason: "Claude Cloud requires a GitHub repository" };
  const home = input.account.home, remote = recordedProjectRemote(project);
  const syncGuard = () => { input.signal.throwIfAborted(); input.assertCurrent(); if (input.account.home !== home || recordedProjectRemote(project) !== remote) throw new Superseded(); };
  let row: ClaudeTaskRow = read(project, accountId) ?? { key: `${digest(project)}!${accountId}`, project, accountId, repository, organization: null, taskId: null,
    state: "preparing" as const, code: null, validatedAt: null, retryAt: 0, deadlineAt: now() + 600_000, retries: 0, revision: 0, create: { intent: randomUUID() } };
  let identity: string | undefined;
  const guard = async () => { syncGuard(); if (identity && await provider.identity(input.account) !== identity) throw new Superseded(); syncGuard(); };
  const save = async (patch: Partial<ClaudeTaskRow>) => { await guard(); row = await update({ ...row, ...patch }, row.revision, syncGuard); };
  const result = (code: ClaudeTaskReason): CloudEnvironmentPreparation => {
    const step = claudeTaskStep(code), reason = CLAUDE_TASK_REASONS[code] + (row.status ? ` (${row.status})` : "") + (step ? `; ${step.url}` : "");
    return row.state === "preparing" ? { state: "pending", retryAt: row.retryAt, reason } : { state: "unavailable", reason };
  };
  const call = async (method: "GET" | "POST", target: string, body?: Row) => {
    await guard(); const response = await provider.request(input.account, input.signal, method, target, body, { principal: identity!, assertCurrent: syncGuard });
    const parsed = await response.json().catch(() => null) as unknown; await guard();
    if (response.status === 401 && record(record(parsed).error).reason === "github_token_missing") throw new ClaudeTaskError("github_not_connected", 401);
    return { response, body: record(parsed), readable: !!parsed && typeof parsed === "object" };
  };
  const get = async (target: string) => {
    const answer = await call("GET", target);
    if (answer.response.status === 401) throw new ClaudeTaskError("login_refused");
    if (answer.response.status === 429 || answer.response.status >= 500) throw new ClaudeTaskError("provider_unavailable", answer.response.status, true);
    if (!answer.response.ok || !answer.readable) throw new ClaudeTaskError("task_invalid", answer.response.status);
    return answer.body;
  };
  try {
    syncGuard(); identity = await provider.identity(input.account); syncGuard();
    if (row.repository !== repository || row.organization !== identity) await save({ repository, organization: identity, taskId: null, state: "preparing", code: null,
      retryAt: 0, retries: 0, deadlineAt: now() + 600_000, create: { intent: randomUUID() } });
    if (!input.force && row.code && row.retryAt > now()) return result(row.code);
    if (input.force || row.deadlineAt <= now()) await save({ retries: 0, deadlineAt: now() + 600_000, retryAt: 0 });
    const replacing = claudeCloudTasks(project).find(t => t.accountId === accountId)?.taskId ?? null;
    let task: Row | null = null;
    for (const candidate of new Set([replacing, row.taskId].filter((id): id is string => !!id))) {
      const answer = await call("GET", `/v1/code/triggers/${encodeURIComponent(candidate)}`);
      if (answer.response.ok) {
        if (!Object.keys(context(record(answer.body.trigger))).length) throw new ClaudeTaskError("task_invalid");
        if (sameRepo(record(answer.body.trigger), repository)) { task = { ...record(answer.body.trigger), id: candidate }; break; }
      } else if (answer.response.status !== 404) {
        if (answer.response.status === 401) throw new ClaudeTaskError("login_refused");
        throw new ClaudeTaskError("provider_unavailable", answer.response.status, true);
      }
    }
    if (!task) {
      const list = await get("/v1/code/triggers");
      if (list.has_more !== false || !Array.isArray(list.data)) throw new ClaudeTaskError("task_list_incomplete");
      if (list.data.some(value => typeof record(value).id !== "string" || !Array.isArray(context(record(value)).sources))) throw new ClaudeTaskError("task_invalid");
      const matches = list.data.map(record).filter(t => sameRepo(t, repository) && (t.name === "Delegatus pipeline stages" || promptText(t) === CLAUDE_CLOUD_TASK_PROMPT.replace(/\s+/g, " ").trim()));
      matches.sort((a, b) => Number(b.enabled === true) - Number(a.enabled === true) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)));
      task = matches[0] ?? null;
      if (!task && row.create.dispatchedAt !== undefined) {
        if (now() - row.create.dispatchedAt >= 600_000) {
          const lists = (row.create.listsAfterDispatch ?? 0) + 1;
          await save({ create: { ...row.create, listsAfterDispatch: Math.min(2, lists), ...(lists >= 2 ? { dispatchedAt: undefined, releasedAt: now() } : {}) } });
        }
        if (row.create.dispatchedAt !== undefined) {
          const pending = now() - row.create.dispatchedAt < 60_000;
          await save({ state: pending ? "preparing" : "unavailable", code: "create_uncertain", retryAt: now() + (pending ? 2000 : 60_000) });
          return result("create_uncertain");
        }
      }
      if (!task) {
        // GitHub status can be unavailable; creation supplies the authoritative missing-token refusal.
        const auth = await get(`/api/oauth/organizations/current/sync/github/auth`).catch(error => {
          if (error instanceof ClaudeTaskError && ["provider_unavailable", "task_invalid"].includes(error.code)) return {} as Row;
          throw error;
        });
        if (auth.is_authenticated === false) throw new ClaudeTaskError("github_not_connected");
        const environments = await get("/v1/environment_providers");
        const active = (Array.isArray(environments.environment_providers) ? environments.environment_providers : Array.isArray(environments.data) ? environments.data : []).map(record)
          .filter(e => e.kind === "anthropic_cloud" && e.state === "active" && typeof e.environment_id === "string");
        const environment = active.find(e => e.name === "Default") ?? active[0];
        if (!environment) throw new ClaudeTaskError("no_environment");
        await save({ state: "preparing", code: null, create: { intent: randomUUID(), dispatchedAt: now() } });
        const dispatch = { ...row.create };
        let answer;
        try { answer = await call("POST", "/v1/code/triggers", { name: "Delegatus pipeline stages", enabled: true, clear_mcp_connections: true,
          run_once_at: new Date(Date.UTC(new Date(now()).getUTCFullYear() + 1, new Date(now()).getUTCMonth(), new Date(now()).getUTCDate(), 12)).toISOString(),
          job_config: { ccr: { environment_id: environment.environment_id, session_context: { model: CLAUDE_ALIAS_RELEASES.opus, sources: [{ type: "git_repository", git_repository: { url: `https://github.com/${input.repository}` } }],
            allowed_tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] }, events: [{ data: { uuid: row.create.intent, session_id: "", type: "user", parent_tool_use_id: null, message: { role: "user", content: CLAUDE_CLOUD_TASK_PROMPT.replace(/\s+/g, " ") } } }] } } }); }
        catch (error) {
          if (error instanceof ClaudeTaskError && error.code === "github_not_connected") {
            await releaseRefusal(row, dispatch, now()); row = read(project, accountId)!; throw error;
          }
          throw new ClaudeTaskError("create_uncertain");
        }
        if (answer.response.status >= 400 && answer.response.status < 500 && Object.keys(record(answer.body.error)).length) {
          await releaseRefusal(row, dispatch, now()); row = read(project, accountId)!;
          throw new ClaudeTaskError("create_refused", answer.response.status);
        }
        task = record(answer.body.trigger ?? answer.body);
        if (!answer.response.ok || typeof task.id !== "string") throw new ClaudeTaskError("create_uncertain");
        const createdTaskId = task.id;
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(createdTaskId)) throw new ClaudeTaskError("create_uncertain");
        row = await settleCreation(row, dispatch, current => ({ ...current, taskId: createdTaskId }));
      }
    }
    const taskId = task.id;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new ClaudeTaskError("task_invalid");
    if (row.taskId !== taskId) await save({ taskId });
    if (task.enabled === false || connectors(task)) {
      const fixed = await call("POST", `/v1/code/triggers/${encodeURIComponent(taskId)}`, { ...(task.enabled === false ? { enabled: true } : {}), ...(connectors(task) ? { clear_mcp_connections: true } : {}) });
      if (!fixed.response.ok) throw new ClaudeTaskError("update_refused", fixed.response.status, fixed.response.status === 429 || fixed.response.status >= 500);
      task = record(fixed.body.trigger);
    }
    if (task.enabled !== true || connectors(task) || !sameRepo(task, repository)) throw new ClaudeTaskError("task_invalid");
    await guard();
    if (setClaudeCloudTaskFor(project, accountId, taskId, replacing) !== taskId) {
      await save({ state: "preparing", code: "binding_busy", retryAt: now() + 2000 }); return result("binding_busy");
    }
    await save({ taskId, state: "ready", code: null, status: undefined, validatedAt: now(), retryAt: 0, retries: 0, create: { intent: row.create.intent } });
    const selection = JSON.stringify(taskId);
    if (claudeCloudTaskFingerprint(project, accountId) !== selection) return { state: "pending", retryAt: now() + 2000, reason: "Claude task binding changed; retrying" };
    const hold = claudeTaskWriteAccess(accountId, taskId, now());
    if (hold?.held) return { state: "unavailable", reason: `${CLAUDE_TASK_REASONS.github_write_access}; ${claudeTaskStep("github_write_access")!.url}` };
    return { state: "ready", environmentId: taskId, revision: row.revision, selection, principal: identity };
  } catch (error) {
    if (error instanceof Superseded) return { state: "pending", retryAt: now() + 2000, reason: "Claude task preparation changed; retrying" };
    if (input.signal.aborted) throw error;
    const failure = error instanceof ClaudeTaskError ? error : new ClaudeTaskError("provider_unavailable", undefined, true);
    const retries = Math.min(3, row.retries + 1), pending = failure.transient && retries < 3 && now() < row.deadlineAt;
    const patch: Partial<ClaudeTaskRow> = { state: pending ? "preparing" : "unavailable", code: failure.code, status: failure.status, retries,
      retryAt: now() + (pending ? 2000 * 2 ** (retries - 1) : 900_000) };
    try {
      // A sign-in lost during a read cannot authenticate again to save its own
      // refusal. Save under the local selection fence and keep its receipt.
      if (["login_missing", "login_expired", "third_party_provider"].includes(failure.code)) row = await update({ ...row, ...patch }, row.revision, syncGuard);
      else await save(patch);
    }
    catch (changed) { if (!(changed instanceof Superseded)) throw changed; return { state: "pending", retryAt: now() + 2000, reason: "Claude task preparation changed; retrying" }; }
    return result(failure.code);
  }
}
/** Effect receipts survive a peer’s readiness write under the same creation claim. */
async function settleCreation(dispatched: ClaudeTaskRow, receipt: ClaudeTaskRow["create"], change: (current: ClaudeTaskRow) => ClaudeTaskRow): Promise<ClaudeTaskRow> {
  const db = store();
  if (!db) throw new Superseded();
  try {
    return await db.mutate(async (rows, persist) => {
      const current = rows.find(row => row.key === dispatched.key);
      if (!current || current.organization !== dispatched.organization || current.repository !== dispatched.repository
        || current.create.intent !== receipt.intent || current.create.dispatchedAt !== receipt.dispatchedAt
        || read(dispatched.project, dispatched.accountId)?.key !== dispatched.key) throw new Superseded();
      const next = rowSchema.parse({ ...change(current), revision: current.revision + 1 });
      await persist([next]); return next;
    }, undefined, false, 1000, undefined, [dispatched.key]);
  } finally { db.close(); }
}
/** A definitive refusal releases only its own receipt. */
async function releaseRefusal(dispatched: ClaudeTaskRow, receipt: ClaudeTaskRow["create"], now: number) {
  await settleCreation(dispatched, receipt, current => ({ ...current, create: { intent: receipt.intent, releasedAt: now } }));
}
