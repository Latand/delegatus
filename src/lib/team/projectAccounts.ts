import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { accountProjection } from "@/lib/accounts/accountProjection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalProject } from "@/lib/projects/aliases";

import type { EnginePool, PoolAccount, PoolLimitWindow, PoolTierWindow, ProjectAccountsView } from "./contract";

/*
 * What a member may know about the accounts of a project they act on
 * (docs/design/team-memory-and-workspaces.md §5.2, W1): the accounts of its
 * pool per engine with a label, whether each is signed in and its limit
 * windows. Nothing else of an account leaves here: no path, plan, login state
 * or project list, and no account outside the pool. The caller has already
 * decided the member may act on the project; this reads nothing before that.
 */

type Engine = "claude" | "codex";

interface ListedAccount { id: string; label: string; authPresent: boolean; credentialState?: string; provider?: unknown }

function windowOf(raw: PoolLimitWindow | null): PoolLimitWindow | null {
  if (!raw) return null;
  return { usedPercent: raw.usedPercent, resetsAt: raw.resetsAt, ...(raw.windowMinutes === undefined ? {} : { windowMinutes: raw.windowMinutes }) };
}

function tierOf(raw: PoolTierWindow): PoolTierWindow {
  return { ...windowOf(raw)!, tier: raw.tier, ...(raw.label === undefined ? {} : { label: raw.label }) };
}

function poolAccount(engine: Engine, account: ListedAccount, observation: DurableQuotaObservation | undefined, now: number): PoolAccount {
  /* The same rules as the owner's account list (`/api/accounts`): a Claude
     account whose store could not say is not signed out, and a provider
     account has no quota windows. */
  const providerAccount = engine === "claude" && Boolean(account.provider);
  const authPresent = engine === "claude" ? account.authPresent || account.credentialState === "unknown" : account.authPresent;
  const projection = accountProjection(observation, authPresent, now);
  const signedIn = providerAccount ? account.authPresent : projection.auth.state !== "signed_out";
  const limits = providerAccount
    ? { state: "unavailable" as const, session: null, weekly: null, tiers: [], checkedAt: null }
    : {
      state: projection.limits.state,
      session: windowOf(projection.limits.session),
      weekly: windowOf(projection.limits.weekly),
      tiers: projection.limits.tiers.map(tierOf),
      checkedAt: projection.limits.checkedAt,
    };
  return { id: account.id, label: account.label, signedIn, limits };
}

function enginePool(engine: Engine, project: string, now: number): EnginePool {
  const allowed = allowedAccountIdsForProject(project, engine);
  const observations = new Map(agentRegistry().quotaObservations(engine).map(observation => [observation.accountId, observation]));
  /* A set pool selects its ids before any account's credentials or quota are
     read, so the work does not depend on the accounts left out. Only the
     branch with no pool needs every account: to say whether the engine has
     one that is signed in. */
  const only = allowed === null ? undefined : new Set(allowed);
  const listed: ListedAccount[] = engine === "claude" ? listClaudeAccounts(only) : listCodexAccounts(only);
  const rows = listed.map(account => poolAccount(engine, account, observations.get(account.id), now));
  if (allowed === null) return { pool: "none", available: rows.some(row => row.signedIn) };
  return { pool: "set", accounts: rows };
}

/** The member's view of one project's pool. Throws the binding record's own
 *  error when the record cannot be read: no pool is never answered for it. */
export function projectAccountsView(project: string, now = Date.now()): ProjectAccountsView {
  const key = canonicalProject(project.trim());
  return { project: key, engines: { claude: enginePool("claude", key, now), codex: enginePool("codex", key, now) } };
}
