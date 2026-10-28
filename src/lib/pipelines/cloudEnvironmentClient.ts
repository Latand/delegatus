import type { AccountContext } from "@/lib/accounts/contracts";
import { openHostedCloudSession, hostedCloudDependencies, hostedCloudPrincipal, type HostedCloudDependencies, type HostedCloudGuard } from "./cloudHostedClient";
import { HostedCloudError } from "./cloudHostedErrors";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
export const configurationId = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && /^(?:[A-Za-z0-9_-]+~)?asenvcfg_[A-Za-z0-9_-]{1,128}$/.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_~-]{1,200}$/.test(v);
const endpoint = "https://codex-cloud-backend.chatgpt.com";
const repositories = "https://chatgpt.com/backend-api/wham/github/repositories";
export const ENVIRONMENT_REASONS = {
  github_connector_not_configured: "this account's ChatGPT workspace has no GitHub connection",
  repository_access_missing: "this account cannot access the project's GitHub repository",
  authentication_expired: "this account requires a ChatGPT sign-in",
  access_refused: "this account's workspace refused Cloud access",
  manual_environment_mismatched: "the selected environment has a different repository or base ref",
  environment_missing: "the selected Cloud environment is no longer accessible to this account",
  catalog_incomplete: "the Cloud environment catalog could not be read completely",
  approval_failed: "Cloud environment approval failed",
  setup_uncertain: "an environment creation may have succeeded; reconciliation is required",
  setup_deadline_exceeded: "Cloud environment setup exceeded its persisted deadline",
  configuration_invalid: "Cloud returned an invalid environment configuration",
  preparation_superseded: "Cloud environment selection or account authority changed",
} as const;
export type EnvironmentFailureCode = keyof typeof ENVIRONMENT_REASONS;
export class CloudEnvironmentError extends HostedCloudError {
  constructor(readonly code: EnvironmentFailureCode, readonly terminalOperationId?: string) { super(`Codex Cloud: ${ENVIRONMENT_REASONS[code]} (${code})`, "cloud-limit"); }
}
/** A received authentication/access rejection proves this POST had no effect.
 * Transport failures, server errors and unreadable success replies keep custody. */
export class CloudEnvironmentMutationRefused extends CloudEnvironmentError {}
function fail(code: EnvironmentFailureCode): never { throw new CloudEnvironmentError(code); }
function check(ok: unknown, code: EnvironmentFailureCode = "configuration_invalid"): asserts ok { if (!ok) fail(code); }
function providerFailure(value: unknown): EnvironmentFailureCode | null {
  const error = row(value);
  const candidates = [error.code, row(error.error).code, row(error.failure).code];
  return candidates.includes("github_connector_not_configured") ? "github_connector_not_configured" : null;
}

export interface EnvironmentSetupReceipt {
  intent: string;
  configId?: string;
  draftId?: string;
  environmentId?: string;
  operationId?: string;
  approvalAttempt?: number;
  failedOperationId?: string;
  draftRevision?: number;
  configurationRevision?: number;
  createDispatched?: boolean;
  draftDispatched?: boolean;
}
export interface EnvironmentConfiguration {
  id: string;
  repositoryId: string;
  ref: string;
  ready: boolean;
  private: boolean;
  revision: number;
  installScript?: string;
  startSkill?: string;
  networkPolicy?: { type: "disabled" | "unrestricted" | "restricted"; presets?: string[]; egress_rules?: { host: string }[] };
  draft?: { draftId: string; environmentId: string };
}

/** One authenticated, bounded preparation slice. The caller checkpoints every
 * remote-effect intent and receipt outside any database lease. */
export async function openCloudEnvironmentBackend(input: HostedCloudGuard & { account: AccountContext },
  dependencies: HostedCloudDependencies = hostedCloudDependencies) {
  let session: Awaited<ReturnType<typeof openHostedCloudSession>>;
  try { session = await openHostedCloudSession(input, 25_000, dependencies); }
  catch (error) {
    input.signal.throwIfAborted(); input.assertCurrent();
    if (error instanceof Error && ["Codex Cloud requires an existing ChatGPT sign-in", "Codex Cloud ChatGPT token unavailable", "Codex Cloud native authentication refused"].includes(error.message)) fail("authentication_expired");
    fail("catalog_incomplete");
  }
  const guard = () => { session.scope.signal.throwIfAborted(); session.scope.assertCurrent(); };
  async function request(url: string, method = "GET", body?: Row): Promise<Row> {
    guard();
    let response: Response;
    try {
      response = await dependencies.fetch(url, { method, redirect: "error", signal: session.scope.signal,
        headers: { Authorization: `Bearer ${session.auth.token}`, "X-OpenAI-Product-Sku": "codex",
          originator: "Codex Desktop", "User-Agent": "Codex Desktop/26.1016.61520", "Content-Type": "application/json",
          ...(session.auth.account ? { "ChatGPT-Account-Id": session.auth.account } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail(method === "POST" ? "setup_uncertain" : "catalog_incomplete"); }
    function responseFailure(code: EnvironmentFailureCode): never {
      if (method === "POST" && (response.status === 401 || response.status === 403)) throw new CloudEnvironmentMutationRefused(code);
      fail(code);
    }
    // Read receipts even when authority was withdrawn while the effect ran.
    const reader = response.body?.getReader();
    if (!reader) responseFailure(response.status === 401 ? "authentication_expired" : response.status === 403 ? "access_refused" : "catalog_incomplete");
    const chunks: Uint8Array[] = []; let bytes = 0;
    let result: Row;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        check(bytes <= 1024 * 1024, "catalog_incomplete"); chunks.push(value);
      }
      result = row(JSON.parse(Buffer.concat(chunks).toString()));
    } catch { responseFailure(response.status === 401 ? "authentication_expired" : response.status === 403 ? "access_refused"
      : method === "POST" ? "setup_uncertain" : "catalog_incomplete"); }
    finally { try { await reader.cancel(); } catch { /* Release the owned reader. */ } reader.releaseLock(); }
    const prerequisite = providerFailure(result);
    if (prerequisite && !(response.ok && url.startsWith(`${endpoint}/v1/environment-operations/`))) responseFailure(prerequisite);
    if (!response.ok) responseFailure(response.status === 401 ? "authentication_expired" : response.status === 403 ? "access_refused"
      : response.status === 404 ? url.includes("/v1/environment-configs/") ? "environment_missing" : "repository_access_missing"
        : method === "POST" ? "setup_uncertain" : "catalog_incomplete");
    if (method !== "POST") guard();
    return result;
  }
  async function pages(url: string): Promise<Row[]> {
    let cursor: string | undefined; const seen = new Set<string>(); const results: Row[] = [];
    for (let page = 0; page < 20; page++) {
      const target = new URL(url); if (cursor) target.searchParams.set("cursor", cursor);
      const result = await request(target.toString());
      check(Array.isArray(result.data), "catalog_incomplete");
      check(result.data.length <= 100, "catalog_incomplete"); results.push(...result.data.map(row));
      const next = result.next_cursor ?? result.nextCursor;
      if (next === null || next === undefined || next === "") return results;
      check(typeof next === "string" && next.length <= 2048 && !seen.has(next), "catalog_incomplete");
      seen.add(next); cursor = next;
    }
    fail("catalog_incomplete");
  }
  async function repository(id: string) {
    check(identifier(id)); const result = await request(`${repositories}/${encodeURIComponent(id)}`);
    check(typeof result.repository_full_name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository_full_name));
    return { id, name: result.repository_full_name.toLowerCase(), defaultBranch: result.default_branch };
  }
  async function detail(id: string): Promise<EnvironmentConfiguration> {
    check(configurationId(id)); const result = await request(`${endpoint}/v1/environment-configs/${encodeURIComponent(id)}`);
    check(result.id === id && Array.isArray(result.repositories) && result.repositories.length === 1);
    const repo = row(result.repositories[0]);
    check(identifier(repo.repository_id) && typeof repo.ref === "string" && repo.ref.length <= 256);
    const policy = row(result.network_policy);
    const networkPolicy: EnvironmentConfiguration["networkPolicy"] = ["disabled", "unrestricted", "restricted"].includes(String(policy.type))
      ? { type: policy.type as "restricted", ...(Array.isArray(policy.presets) ? { presets: policy.presets.filter((v): v is string => v === "package_managers") } : {}),
        ...(Array.isArray(policy.egress_rules) ? { egress_rules: policy.egress_rules.map(row).flatMap(rule => typeof rule.host === "string" && /^[A-Za-z0-9.*:-]{1,253}$/.test(rule.host) ? [{ host: rule.host }] : []) } : {}) } : undefined;
    const draft = row(result.draft);
    return { id, repositoryId: repo.repository_id, ref: repo.ref.replace(/^refs\/heads\//, ""),
      ready: typeof result.latest_ready_version_id === "string" && result.latest_ready_version_id === result.version_id,
      private: result.share_settings === "private", revision: Number.isSafeInteger(result.version_revision) ? Number(result.version_revision) : 0,
      ...(typeof result.install_script === "string" && result.install_script.length <= 65536 ? { installScript: result.install_script } : {}),
      ...(typeof result.start_skill === "string" && result.start_skill.length <= 65536 ? { startSkill: result.start_skill } : {}), ...(networkPolicy ? { networkPolicy } : {}),
      ...(identifier(draft.id) && identifier(result.environment_id) ? { draft: { draftId: draft.id, environmentId: result.environment_id } } : {}) };
  }
  return {
    close: session.close,
    principal: hostedCloudPrincipal(session.auth),
    repository, detail,
    async findRepository(name: string) {
      // The desktop picker uses numbered repository pages, independently of
      // the ASB catalog's cursors (app-initial's repository query).
      for (let page = 1; page <= 20; page++) {
        const result = await request(`https://chatgpt.com/backend-api/wham/github/list-repositories?page=${page}&per_page=20`);
        check(Array.isArray(result.repositories) && result.repositories.length <= 20, "catalog_incomplete");
        const match = result.repositories.map(row).find(r => typeof r.repository_full_name === "string" && r.repository_full_name.toLowerCase() === name);
        if (match) {
          check(identifier(match.id) || typeof match.id === "number" && Number.isSafeInteger(match.id));
          const resolved = await repository(String(match.id)); check(resolved.name === name, "repository_access_missing"); return resolved;
        }
        if (result.repositories.length < 20) fail("repository_access_missing");
      }
      fail("catalog_incomplete");
    },
    async catalog() {
      const all = new Map<string, Row>();
      for (const scope of ["user", "workspace"]) for (const picker of [true, false]) {
        for (const entry of await pages(`${endpoint}/v1/environment-configs?scope=${scope}&limit=100&omitDraft=true${picker ? "&view=picker" : ""}`)) {
          check(configurationId(entry.id), "catalog_incomplete"); all.set(entry.id, entry);
        }
      }
      return [...all.values()].sort((a, b) => Number(b.share_settings === "private") - Number(a.share_settings === "private") || String(a.id).localeCompare(String(b.id)));
    },
    async create(name: string, repositoryId: string, ref: string, template?: Pick<EnvironmentConfiguration, "installScript" | "startSkill" | "networkPolicy">) {
      const result = await request(`${endpoint}/v1/environment-configs`, "POST", { name, repositories: [{ repository_id: repositoryId, ref }],
        share_settings: "private", network_policy: template?.networkPolicy ?? { type: "restricted", presets: ["package_managers"], egress_rules: [] },
        ...(template?.installScript ? { install_script: template.installScript } : {}), ...(template?.startSkill ? { start_skill: template.startSkill } : {}) });
      check(configurationId(result.id)); return result.id;
    },
    async draft(configId: string) {
      const result = await request(`${endpoint}/v1/environment-configs/${encodeURIComponent(configId)}/drafts`, "POST", { start_thread: false });
      check(identifier(result.draft_id) && identifier(result.environment_id));
      return { draftId: result.draft_id, environmentId: result.environment_id };
    },
    async draftRevision(configId: string, draftId: string) {
      const result = await request(`${endpoint}/v1/environment-configs/${encodeURIComponent(configId)}/drafts/${encodeURIComponent(draftId)}`);
      const revision = row(result.draft).revision;
      check(Number.isSafeInteger(revision) && Number(revision) >= 0); return Number(revision);
    },
    async begin(configId: string, draftId: string, revision: number, intent: string) {
      const result = await request(`${endpoint}/v1/environment-configs/${encodeURIComponent(configId)}/drafts/${encodeURIComponent(draftId)}/approve/begin`, "POST",
        { expected_revision: revision, idempotency_key: intent });
      check(identifier(result.id)); return result.id;
    },
    async operation(operationId: string, environmentId: string) {
      const result = await request(`${endpoint}/v1/environment-operations/${encodeURIComponent(operationId)}`);
      check(result.id === operationId && result.environment_id === environmentId);
      guard();
      let environment: Row | undefined;
      try {
        const status = await session.client.rpc("environment/status", { environmentIds: [environmentId] });
        guard(); check(Array.isArray(status.data));
        environment = status.data.map(row).find(r => r.environmentId === environmentId); check(environment);
      } catch (error) {
        // The validated terminal result owns the receipt even if its runtime
        // disappeared or diagnostics exhausted the backend session deadline.
        input.signal.throwIfAborted(); input.assertCurrent();
        if (result.state !== "FAILED") throw error;
      }
      // A failed setup is decisive even while the approval operation is RUNNING.
      const observed = row(environment?.observations); const failure = row(observed.failure);
      const code = providerFailure(failure) ?? providerFailure(result);
      if (result.state === "FAILED") throw new CloudEnvironmentError(code ?? "approval_failed", operationId);
      if (code) fail(code);
      if (observed.phase === "failed") fail("approval_failed");
      check(["PENDING", "RUNNING", "SUCCEEDED"].includes(String(result.state)));
      return result.state === "SUCCEEDED";
    },
    async complete(configId: string, draftId: string, operationId: string) {
      await request(`${endpoint}/v1/environment-configs/${encodeURIComponent(configId)}/drafts/${encodeURIComponent(draftId)}/approve/complete`, "POST", { operation_id: operationId });
    },
  };
}
