import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AccountContext } from "@/lib/accounts/contracts";
import { statePath } from "@/lib/configDir";
import { canonicalProject, recordedProjectRemote } from "./aliases";
import { codexCloudEnvironmentId } from "./settings";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { initializeStateCollectionsAsync, readStateCollectionRevision, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { CloudEnvironmentError, configurationId, ENVIRONMENT_REASONS, openCloudEnvironmentBackend, type EnvironmentConfiguration } from "@/lib/pipelines/cloudEnvironmentClient";
import type { HostedCloudDependencies } from "@/lib/pipelines/cloudHostedClient";
import { readCloudRunSetup } from "./cloudRunSetupImport";

const id = z.string().regex(/^[A-Za-z0-9_~-]{1,200}$/);
const instant = z.number().finite().nonnegative();
const receiptSchema = z.object({ intent: id, configId: id.optional(), draftId: id.optional(), environmentId: id.optional(), operationId: id.optional(),
  draftRevision: z.number().int().nonnegative().optional(), configurationRevision: z.number().int().nonnegative().optional(),
  createDispatched: z.boolean().optional(), draftDispatched: z.boolean().optional() }).strict();
const templateSchema = z.object({ installScript: z.string().max(65536).optional(), startSkill: z.string().max(65536).optional(),
  networkPolicy: z.object({ type: z.enum(["disabled", "unrestricted", "restricted"]), presets: z.array(z.literal("package_managers")).optional(),
    egress_rules: z.array(z.object({ host: z.string().max(253) })).max(256).optional() }).optional() }).strict();
const bindingSchema = z.object({ key: z.string().max(1024), project: z.string().min(1).max(256), accountId: id,
  kind: z.enum(["automatic", "override"]), repository: z.string().max(160), ref: z.string().max(256),
  environmentId: id.nullable(), revision: z.number().int().nonnegative(), principal: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  accountVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(["discovering", "creating", "approving", "ready", "unavailable"]),
  code: z.enum(Object.keys(ENVIRONMENT_REASONS) as [keyof typeof ENVIRONMENT_REASONS, ...(keyof typeof ENVIRONMENT_REASONS)[]]).nullable(),
  validatedAt: instant.nullable(), retryAt: instant, deadlineAt: instant, retries: z.number().int().min(0).max(3),
  setup: receiptSchema, actor: z.string().max(256).nullable(), selection: z.string().max(256),
  template: templateSchema.optional(),
}).strict();
export type CloudEnvironmentBinding = z.infer<typeof bindingSchema>;
export type CloudEnvironmentProjection = Omit<CloudEnvironmentBinding, "key" | "principal" | "setup" | "actor" | "selection" | "template"> & {
  source: "account-override" | "project-override" | "automatic"; reason: string | null; overrideRevision: number;
};
const collection = "codex_cloud_environments";
const seed = { collection, schemaVersion: 1, migrationId: "codex-cloud-environments-v1", key: (r: CloudEnvironmentBinding) => r.key, loadRecords: (): CloudEnvironmentBinding[] => [] };
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
/** File metadata only; credentials are read exclusively by native auth. */
export function cloudAccountVersion(account: Pick<AccountContext, "home">): string {
  let version: unknown = "absent";
  try { const stat = fs.statSync(path.join(account.home, "auth.json"), { bigint: true }); version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") version = "unreadable"; }
  return digest(JSON.stringify([account.home, version]));
}
const prefix = (project: string) => `${digest(canonicalProject(project))}!`;
const key = (project: string, account: string, repository: string, ref: string, kind: "automatic" | "override") => `${prefix(project)}${account}!${kind}!${digest(JSON.stringify([repository, ref]))}`;
function readStore(): SqliteStateCollection<CloudEnvironmentBinding> | null {
  const file = statePath("state.sqlite");
  if (readStateCollectionRevision(file, collection) === null) return null;
  return new SqliteStateCollection(file, { ...seed, clone: structuredClone,
    decode: value => { const parsed = bindingSchema.safeParse(value); return parsed.success ? parsed.data : null; }, strictDecode: true,
    busyMessage: "Cloud environment bindings are busy" });
}
export async function initializeCloudEnvironmentBindings(): Promise<void> { await initializeStateCollectionsAsync(statePath("state.sqlite"), [seed]); }
function read(key: string): CloudEnvironmentBinding | null { const store = readStore(); try { return store?.get(key) ?? null; } finally { store?.close(); } }
async function update(value: CloudEnvironmentBinding, expected: number, assertCurrent: () => void): Promise<CloudEnvironmentBinding> {
  const checked = bindingSchema.parse(value);
  await initializeCloudEnvironmentBindings();
  const store = readStore()!;
  try {
    return await store.mutate(async (rows, persist) => {
      assertCurrent();
      const old = rows.find(r => r.key === checked.key);
      if ((old?.revision ?? 0) !== expected) throw new CloudEnvironmentError("preparation_superseded");
      const next = bindingSchema.parse({ ...checked, revision: expected + 1 });
      // A keyed mutation has an intentionally partial snapshot. Explicit
      // upserts preserve other accounts and the separately stored override.
      await persist([next]); return next;
    }, () => assertCurrent(), false, 1000, undefined, [checked.key]);
  } finally { store.close(); }
}
export function cloudEnvironmentSelection(project: string, accountId: string): { environmentId: string; source: CloudEnvironmentProjection["source"]; revision: number } {
  const override = read(key(project, accountId, "", "", "override"));
  if (override?.environmentId) return { environmentId: override.environmentId, source: "account-override", revision: override.revision };
  const legacy = codexCloudEnvironmentId(project);
  return { environmentId: legacy, source: legacy ? "project-override" : "automatic", revision: override?.revision ?? 0 };
}
export function cloudEnvironmentChoiceFingerprint(project: string, accountId: string): string { return JSON.stringify(cloudEnvironmentSelection(project, accountId)); }
function projection(binding: CloudEnvironmentBinding): CloudEnvironmentProjection {
  const choice = cloudEnvironmentSelection(binding.project, binding.accountId);
  const stale = binding.kind === "automatic" && binding.selection !== JSON.stringify(choice);
  return { project: binding.project, accountId: binding.accountId, kind: binding.kind, repository: binding.repository, ref: binding.ref,
    environmentId: stale ? choice.environmentId || null : binding.environmentId, revision: binding.revision, accountVersion: binding.accountVersion,
    state: stale ? "discovering" : binding.state, code: stale ? null : binding.code, validatedAt: stale ? null : binding.validatedAt,
    retryAt: binding.retryAt, deadlineAt: binding.deadlineAt, retries: binding.retries,
    source: choice.source, overrideRevision: choice.revision, reason: stale ? null : binding.code ? ENVIRONMENT_REASONS[binding.code] : null };
}
/** Indexed project page. Reads neither initialize storage nor contact Cloud. */
export function readCloudEnvironmentBindings(project: string, options: { accountId?: string; after?: string; limit?: number } = {}) {
  const p = prefix(project); const account = options.accountId;
  if (account !== undefined && !id.safeParse(account).success) throw new Error("invalid Cloud account");
  const start = account ? `${p}${account}!` : p;
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  if (options.after && !options.after.startsWith(start)) throw new Error("invalid Cloud binding cursor");
  const store = readStore();
  try {
    const rows = store?.keyRange(options.after || start, `${start}\uffff`, limit + 1) ?? [];
    return { bindings: rows.slice(0, limit).map(projection), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null };
  } finally { store?.close(); }
}
export function preparedCloudEnvironmentId(project: string, accountId: string, repository: string, ref: string): string {
  const choice = cloudEnvironmentSelection(project, accountId);
  if (choice.environmentId) return choice.environmentId;
  const saved = read(key(project, accountId, repository, ref.replace(/^refs\/heads\//, ""), "automatic"));
  return saved?.state === "ready" && saved.selection === JSON.stringify(choice) ? saved.environmentId ?? "" : "";
}
function initial(project: string, accountId: string, repository: string, ref: string, kind: CloudEnvironmentBinding["kind"], now: number, intent: string = randomUUID()): CloudEnvironmentBinding {
  return { key: key(project, accountId, repository, ref, kind), project: canonicalProject(project), accountId, kind, repository, ref,
    environmentId: null, revision: 0, principal: null, accountVersion: null, state: "discovering", code: null, validatedAt: null, retryAt: 0,
    deadlineAt: now + 10 * 60_000, retries: 0, setup: { intent }, actor: null, selection: JSON.stringify(cloudEnvironmentSelection(project, accountId)) };
}
/** The route derives actor and authority. A manual write never edits an automatic row. */
export async function setCloudEnvironmentOverride(input: { project: string; accountId: string; environmentId: string | null; expectedRevision: number; actor: string; assertCurrent: () => void }) {
  if (!id.safeParse(input.accountId).success || input.environmentId !== null && !configurationId(input.environmentId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("invalid Cloud environment override");
  const old = read(key(input.project, input.accountId, "", "", "override"));
  if ((old?.revision ?? 0) !== input.expectedRevision) return { ok: false as const, conflict: true, binding: old ? projection(old) : null };
  const value = { ...(old ?? initial(input.project, input.accountId, "", "", "override", Date.now())),
    environmentId: input.environmentId, state: "discovering" as const, validatedAt: null, code: null, retryAt: 0,
    deadlineAt: Date.now() + 10 * 60_000, retries: 0, actor: input.actor };
  try { return { ok: true as const, binding: projection(await update(value, input.expectedRevision, input.assertCurrent)) }; }
  catch (error) {
    if (error instanceof CloudEnvironmentError && error.code === "preparation_superseded") return { ok: false as const, conflict: true, binding: readCloudEnvironmentBindings(input.project, { accountId: input.accountId }).bindings.find(r => r.kind === "override") ?? null };
    throw error;
  }
}

/** A default-ref lookup can fail before an actual ref is known. Retain that
 * account's prerequisite and retry budget in a separate unresolved-ref row. */
export async function recordCloudEnvironmentPrerequisite(project: string, accountId: string, repository: string,
  error: unknown, assertCurrent: () => void, accountVersion: string | null = null): Promise<void> {
  const old = read(key(project, accountId, repository, "", "automatic")) ?? initial(project, accountId, repository, "", "automatic", Date.now());
  const code = error instanceof CloudEnvironmentError ? error.code : "catalog_incomplete";
  await update({ ...old, accountVersion, state: "unavailable", code, retryAt: Date.now() + 15 * 60_000, retries: Math.min(3, old.retries + 1) }, old.revision, assertCurrent);
}
export async function clearCloudEnvironmentPrerequisite(project: string, accountId: string, repository: string, assertCurrent: () => void): Promise<void> {
  const unresolvedKey = key(project, accountId, repository, "", "automatic"), store = readStore();
  try {
    if (!store?.get(unresolvedKey)) return;
    await store.patch(() => {
      assertCurrent();
      const current = store.get(unresolvedKey);
      if (current?.setup.configId || current?.setup.draftId || current?.setup.operationId) throw new Error("unresolved-ref receipt has remote custody");
      return { records: [], deleteKeys: [unresolvedKey] };
    });
  } finally { store?.close(); }
}

export interface PrepareCloudEnvironmentInput {
  project: string; account: AccountContext; repository: string; ref: string; signal: AbortSignal; assertCurrent: () => void;
  now?: () => number;
}
export type CloudEnvironmentPreparation = { state: "ready"; environmentId: string; selection: string; revision: number; principal: string }
  | { state: "pending"; retryAt: number; reason: string } | { state: "unavailable"; reason: string };

/** A slice advances persisted setup checkpoints; pending work is scheduled by
 * the controller. No network request owns a shared storage lease. */
export async function prepareCloudEnvironment(input: PrepareCloudEnvironmentInput, dependencies?: HostedCloudDependencies): Promise<CloudEnvironmentPreparation> {
  const now = input.now ?? Date.now;
  const project = canonicalProject(input.project), repository = githubRepositoryOfRemote(`https://github.com/${input.repository}`);
  if (!repository || !input.ref || input.ref.length > 256) return { state: "unavailable", reason: "Codex Cloud requires a GitHub repository and base ref" };
  const ref = input.ref.replace(/^refs\/heads\//, "");
  const choice = cloudEnvironmentSelection(project, input.account.accountId), selection = JSON.stringify(choice);
  const recordedRemote = recordedProjectRemote(project);
  const accountVersion = cloudAccountVersion(input.account);
  const accountIdentity = JSON.stringify([input.account.accountId, input.account.home]);
  const guard = () => {
    input.signal.throwIfAborted(); input.assertCurrent();
    if (selection !== cloudEnvironmentChoiceFingerprint(project, input.account.accountId)
      || recordedProjectRemote(project) !== recordedRemote
      || cloudAccountVersion(input.account) !== accountVersion
      || accountIdentity !== JSON.stringify([input.account.accountId, input.account.home])) {
      throw new CloudEnvironmentError("preparation_superseded");
    }
  };
  guard();
  let saved = read(key(project, input.account.accountId, repository, ref, "automatic"))
    ?? initial(project, input.account.accountId, repository, ref, "automatic", now(), dependencies?.uuid());
  if (saved.selection !== selection || saved.accountVersion !== accountVersion) saved = { ...saved, state: "discovering", code: null,
    retryAt: 0, validatedAt: null, selection, accountVersion, deadlineAt: now() + 10 * 60_000, retries: 0 };
  if (saved.state === "unavailable" && now() >= saved.retryAt && (saved.deadlineAt <= now() || saved.retries >= 3)) {
    // A durable cooldown permits another bounded reconciliation window.
    // Keep every remote-effect receipt and creation intent across windows.
    saved = { ...saved, state: "discovering", code: null, retries: 0, deadlineAt: now() + 10 * 60_000 };
  }
  const checkpoint = async (patch: Partial<CloudEnvironmentBinding>, receiptOnly = false) => {
    // A late response still records custody, but cannot publish readiness.
    saved = await update({ ...saved, ...patch }, saved.revision, receiptOnly ? () => {} : guard);
  };
  if (saved.state === "unavailable" && now() < saved.retryAt) return { state: "unavailable", reason: `Codex Cloud: ${ENVIRONMENT_REASONS[saved.code ?? "configuration_invalid"]} (${saved.code})` };
  if (saved.retryAt > now() && saved.state !== "ready") return { state: "pending", retryAt: saved.retryAt, reason: "Cloud environment approval is pending" };
  let backend: Awaited<ReturnType<typeof openCloudEnvironmentBackend>> | undefined;
  try {
    if (saved.state !== "ready" && (saved.deadlineAt <= now() || saved.retries >= 3)) throw new CloudEnvironmentError("setup_deadline_exceeded");
    backend = await openCloudEnvironmentBackend({ account: input.account, signal: input.signal, assertCurrent: guard }, dependencies);
    guard();
    if (saved.principal && saved.principal !== backend.principal) {
      // Retain the old principal's custody independently before rediscovering
      // under the new login. Those setup effects are never replayed as it.
      const retiredKey = `retired!${digest(JSON.stringify([saved.key, saved.principal, saved.setup]))}`;
      if (!read(retiredKey)) await update({ ...saved, key: retiredKey, state: "unavailable", code: "preparation_superseded" }, 0, guard);
      await checkpoint({ principal: backend.principal, environmentId: null, state: "discovering", setup: { intent: dependencies?.uuid() ?? randomUUID() },
        validatedAt: null, code: null, retryAt: 0, deadlineAt: now() + 10 * 60_000, retries: 0 });
    }
    if (!saved.principal) await checkpoint({ principal: backend.principal });
    const matches = async (config: EnvironmentConfiguration) => config.ref === ref && (await backend!.repository(config.repositoryId)).name === repository;
    const ready = async (config: EnvironmentConfiguration): Promise<CloudEnvironmentPreparation> => {
      guard(); await checkpoint({ environmentId: config.id, state: "ready", code: null, validatedAt: now(), retryAt: now() + 24 * 60 * 60_000,
        template: templateSchema.parse({ ...(config.installScript ? { installScript: config.installScript } : {}), ...(config.startSkill ? { startSkill: config.startSkill } : {}),
          ...(config.networkPolicy ? { networkPolicy: config.networkPolicy } : {}) }),
        setup: { ...saved.setup, configId: config.id, configurationRevision: config.revision } });
      return { state: "ready", environmentId: config.id, selection, revision: saved.revision, principal: saved.principal! };
    };
    if (choice.environmentId) {
      const config = await backend.detail(choice.environmentId);
      if (!await matches(config)) throw new CloudEnvironmentError("manual_environment_mismatched");
      if (!config.ready) throw new CloudEnvironmentError("approval_failed");
      return await ready(config);
    }
    if (saved.environmentId) {
      try {
        const config = await backend.detail(saved.environmentId);
        if (await matches(config) && config.ready) return await ready(config);
      } catch (error) {
        if (!(error instanceof CloudEnvironmentError) || error.code !== "environment_missing") throw error;
        const retiredKey = `retired!${digest(JSON.stringify([saved.key, saved.principal, saved.setup]))}`;
        if (!read(retiredKey)) await update({ ...saved, key: retiredKey, state: "unavailable", code: "environment_missing" }, 0, guard);
        await checkpoint({ environmentId: null, setup: { intent: dependencies?.uuid() ?? randomUUID() }, state: "discovering",
          code: null, validatedAt: null, retryAt: 0, deadlineAt: now() + 10 * 60_000, retries: 0 });
      }
    }
    const catalog = await backend.catalog(); guard();
    for (const entry of catalog) {
      const repos = Array.isArray(entry.repositories) ? entry.repositories : [];
      if (repos.length !== 1) continue;
      const repo = repos[0] as Record<string, unknown>;
      if (typeof repo.ref !== "string" || repo.ref.replace(/^refs\/heads\//, "") !== ref) continue;
      const config = await backend.detail(String(entry.id));
      if (!await matches(config)) continue;
      if (config.ready) return await ready(config);
      if (!saved.setup.configId && saved.setup.createDispatched && entry.name === `delegatus-${saved.setup.intent}`) {
        await checkpoint({ setup: { ...saved.setup, configId: config.id }, environmentId: config.id }, true); guard();
      }
      if (!saved.setup.configId && entry.is_owner === true && config.private) {
        const imported = await readCloudRunSetup(config.id, saved.setup.intent); guard();
        if (imported) await checkpoint({ setup: imported, environmentId: config.id });
      }
    }
    if (!saved.setup.configId) {
      if (saved.setup.createDispatched) throw new CloudEnvironmentError("setup_uncertain");
      const target = await backend.findRepository(repository); guard();
      // Copy only verified project setup fields. Secret and connection fields
      // never enter this service or its persisted receipts.
      let template: Pick<EnvironmentConfiguration, "installScript" | "startSkill" | "networkPolicy"> | undefined;
      const store = readStore();
      try { template = store?.keyRange(prefix(project), `${prefix(project)}\uffff`, 100)
        .find(prior => prior.state === "ready" && prior.repository === repository && prior.ref === ref && prior.template)?.template; }
      finally { store?.close(); }
      await checkpoint({ state: "creating", setup: { ...saved.setup, createDispatched: true } });
      const configId = await backend.create(`delegatus-${saved.setup.intent}`, target.id, ref, template);
      await checkpoint({ environmentId: configId, setup: { ...saved.setup, configId } }, true); guard();
    }
    const configId = saved.setup.configId!;
    const config = await backend.detail(configId);
    if (!await matches(config)) throw new CloudEnvironmentError("manual_environment_mismatched");
    if (config.ready) return await ready(config);
    if (!saved.setup.draftId) {
      if (saved.setup.draftDispatched && config.draft) {
        await checkpoint({ state: "approving", setup: { ...saved.setup, ...config.draft } });
      }
    }
    if (!saved.setup.draftId) {
      if (saved.setup.draftDispatched) throw new CloudEnvironmentError("setup_uncertain");
      await checkpoint({ setup: { ...saved.setup, draftDispatched: true } });
      const draft = await backend.draft(configId);
      await checkpoint({ state: "approving", setup: { ...saved.setup, ...draft } }, true); guard();
    }
    const draftId = saved.setup.draftId!;
    if (!saved.setup.operationId) {
      const revision = await backend.draftRevision(configId, draftId);
      await checkpoint({ setup: { ...saved.setup, draftRevision: revision } });
      const operationId = await backend.begin(configId, draftId, revision, saved.setup.intent);
      await checkpoint({ setup: { ...saved.setup, operationId } }, true); guard();
    }
    if (await backend.operation(saved.setup.operationId!, saved.setup.environmentId!)) {
      await backend.complete(configId, draftId, saved.setup.operationId!); guard();
      const approved = await backend.detail(configId);
      if (approved.ready && await matches(approved)) return await ready(approved);
    }
    await checkpoint({ state: "approving", retryAt: now() + 2000 });
    return { state: "pending", retryAt: saved.retryAt, reason: "Cloud environment approval is pending" };
  } catch (error) {
    const safe = error instanceof CloudEnvironmentError ? error : new CloudEnvironmentError("catalog_incomplete");
    if (input.signal.aborted) throw safe;
    if (safe.code === "preparation_superseded") {
      // A peer preparing this same account can win a checkpoint. Revalidate
      // authority: a storage race waits; a changed manual choice still refuses.
      guard();
      return { state: "pending", retryAt: now() + 2000, reason: "Cloud environment preparation is being reconciled" };
    }
    guard();
    const retries = Math.min(3, saved.retries + 1);
    await checkpoint({ state: "unavailable", code: safe.code, retries,
      retryAt: now() + (retries >= 3 || safe.code === "setup_deadline_exceeded" ? 15 * 60_000 : 2000 * 2 ** (retries - 1)) });
    return { state: "unavailable", reason: safe.message };
  } finally { backend?.close(); }
}
