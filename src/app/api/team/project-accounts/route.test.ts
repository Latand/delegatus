import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-accounts-"));
const OLD = { state: process.env.LLV_STATE_DIR, codex: process.env.LLV_CODEX_HOME, claude: process.env.LLV_CLAUDE_HOME };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { GET } = await import("./route");
const { resetAccountCollectionsForTests, BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { bindAccountToProject } = await import("@/lib/accounts/projectBindings");
const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { persistProjectAliases } = await import("@/lib/projects/aliases");
const { claimInstall, revokeMember } = await import("@/lib/team/members");
const { MEMBER_COOKIE, mintSession } = await import("@/lib/team/sessions");
const { resetTeamStoreForTests, teamStore } = await import("@/lib/team/store");
const { createWorkspace, placeProject } = await import("@/lib/team/workspaces");
const { setWorkspaceDefaults } = await import("@/lib/team/workspaceDefaults");

const W1 = `w_${"a".repeat(32)}`;
const W2 = `w_${"b".repeat(32)}`;
const NOW = Date.now();

afterAll(() => {
  closeAgentRegistryForTests();
  resetTeamStoreForTests();
  for (const [key, value] of [["LLV_STATE_DIR", OLD.state], ["LLV_CODEX_HOME", OLD.codex], ["LLV_CLAUDE_HOME", OLD.claude]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  closeAgentRegistryForTests();
  resetTeamStoreForTests();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetAccountCollectionsForTests();
});
afterEach(() => { resetTeamStoreForTests(); });

function signIn(account: { home: string }, engine: "codex" | "claude"): void {
  fs.writeFileSync(path.join(account.home, engine === "codex" ? "auth.json" : ".credentials.json"), "{}", { mode: 0o600 });
}

function observe(engine: "codex" | "claude", accountId: string, plan: string, weekly: number): void {
  agentRegistry().recordQuotaObservation({
    engine, accountId, authenticated: true, authCheckedAt: new Date(NOW).toISOString(), observedAt: new Date(NOW).toISOString(), bootId: "fixture-boot",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { plan, session: { usedPercent: 11, resetsAt: Math.floor(NOW / 1000) + 3600 }, weekly: { usedPercent: weekly, resetsAt: Math.floor(NOW / 1000) + 86_400 }, tiers: [], capturedAt: Math.floor(NOW / 1000) },
  });
}

interface Fixture { ownerCookie: string; w1: string; w2: string; manager: string; a: string; b: string; c: string }

/** Account A (max, signed in), B (pro, signed in), C (signed out). */
function team(accounts: "all" | "signed-out-only" = "all"): Fixture {
  const store = teamStore();
  const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" }, NOW).member;
  const member = (id: string) => store.insertMember({ id, name: id, role: "member", status: "active", color: "teal", telegram: null,
    createdAt: new Date(NOW).toISOString(), createdBy: owner.id, revokedAt: null });
  member("m_one"); member("m_two"); member("m_manager");
  createWorkspace(store, owner, { id: W1, name: "Alpha", projects: ["repo-atlas"] });
  createWorkspace(store, owner, { id: W2, name: "Beta", projects: ["repo-beta"] });
  store.putWorkspaceMember(W1, "m_one", "member", owner.id, new Date(NOW).toISOString());
  store.putWorkspaceMember(W2, "m_two", "member", owner.id, new Date(NOW).toISOString());
  store.putWorkspaceMember(W1, "m_manager", "manager", owner.id, new Date(NOW).toISOString());
  const cookie = (id: string) => mintSession(store, id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const a = createManagedCodexAccount("Account A"); const b = createManagedCodexAccount("Account B");
  if (accounts === "all") { signIn(a, "codex"); observe("codex", a.id, "max", 31); signIn(b, "codex"); observe("codex", b.id, "pro", 87); }
  const c = createManagedCodexAccount("Account C");
  return { ownerCookie: cookie(owner.id), w1: cookie("m_one"), w2: cookie("m_two"), manager: cookie("m_manager"), a: a.id, b: b.id, c: c.id };
}

async function read(project: unknown, cookie?: string, headers: Record<string, string> = {}) {
  const query = project === undefined ? "" : `?project=${encodeURIComponent(String(project))}`;
  const response = await GET(new NextRequest(`http://127.0.0.1:8898/api/team/project-accounts${query}`, {
    headers: { host: "127.0.0.1:8898", ...(cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {}), ...headers },
  }));
  return { status: response.status, cache: response.headers.get("cache-control"), text: await response.text() };
}
const json = (answer: { text: string }) => JSON.parse(answer.text) as Record<string, unknown>;

describe("what a member sees", () => {
  test("exactly the pool of the project, with limits, no login action and nothing outside the pool", async () => {
    const t = team();
    for (const id of [t.a, t.c]) expect(bindAccountToProject("codex", id, "repo-atlas").ok).toBe(true);
    const answer = await read("repo-atlas", t.w1);
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("no-store");
    const body = json(answer) as { project: string; engines: { claude: unknown; codex: { pool: string; accounts: Record<string, unknown>[] } } };
    expect(Object.keys(body).sort()).toEqual(["engines", "project"]);
    expect(body.project).toBe("repo-atlas");
    expect(body.engines.codex.pool).toBe("set");
    const rows = body.engines.codex.accounts;
    expect(rows.map(row => row.id).sort()).toEqual([t.a, t.c].sort());
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["id", "label", "limits", "signedIn"]);
      expect(Object.keys(row.limits as object).sort()).toEqual(["checkedAt", "session", "state", "tiers", "weekly"]);
    }
    const rowA = rows.find(row => row.id === t.a)!;
    expect(rowA).toMatchObject({ label: "Account A", signedIn: true, limits: { state: "fresh", weekly: { usedPercent: 31 } } });
    expect(rows.find(row => row.id === t.c)).toMatchObject({ label: "Account C", signedIn: false, limits: { state: "unavailable", session: null, weekly: null } });
    /* The engine with no account list reports only whether it could start. */
    expect(body.engines.claude).toEqual({ pool: "none", available: false });
    /* Account B is outside the pool: nothing of it, and nothing that leads to a login or a path. */
    for (const leak of [t.b, "Account B", "\"pro\"", "\"usedPercent\":87", SANDBOX, "home", "transcriptRoot", "login", "deviceAuth", "provider", "email", "plan", "nextChosen", "paidCredits", "projects"]) {
      expect(answer.text).not.toContain(leak);
    }
  });

  test("the pool also comes from the workspace's allow-list, and the two together intersect", async () => {
    const t = team();
    const store = teamStore();
    await setWorkspaceDefaults(store, store.member("m_manager")!, W1, { accounts: { codex: [t.a, t.b] } });
    const listed = async () => ((json(await read("repo-atlas", t.w1)).engines as { codex: { accounts: { id: string }[] } }).codex.accounts.map(row => row.id).sort());
    expect(await listed()).toEqual([t.a, t.b].sort());
    expect(bindAccountToProject("codex", t.b, "repo-atlas").ok).toBe(true);
    expect(await listed()).toEqual([t.b]);
  });

  test("a pool that names an account which no longer exists lists nothing for it", async () => {
    const t = team();
    expect(bindAccountToProject("codex", "account-gone", "repo-atlas").ok).toBe(true);
    const body = json(await read("repo-atlas", t.w1)) as { engines: { codex: unknown } };
    expect(body.engines.codex).toEqual({ pool: "set", accounts: [] });
  });

  test("without a pool a member gets the engines that could start and no account rows", async () => {
    const t = team();
    const answer = await read("repo-atlas", t.w1);
    expect(answer.status).toBe(200);
    expect((json(answer) as { engines: unknown }).engines).toEqual({ claude: { pool: "none", available: false }, codex: { pool: "none", available: true } });
    for (const leak of [t.a, t.b, t.c, "Account A", "Account B", "Account C", "limits", "signedIn"]) expect(answer.text).not.toContain(leak);
  });

  test("an engine whose accounts are all signed out is not offered", async () => {
    const t = team("signed-out-only");
    expect((json(await read("repo-atlas", t.w1)) as { engines: unknown }).engines).toEqual({ claude: { pool: "none", available: false }, codex: { pool: "none", available: false } });
  });

  test("both engines appear when the project's pool holds both", async () => {
    const t = team();
    const claude = createManagedClaudeAccount("Account D"); signIn(claude, "claude"); observe("claude", claude.id, "max", 5);
    expect(bindAccountToProject("codex", t.a, "repo-atlas").ok).toBe(true);
    expect(bindAccountToProject("claude", claude.id, "repo-atlas").ok).toBe(true);
    const body = json(await read("repo-atlas", t.w1)) as { engines: { claude: { pool: string; accounts: { id: string }[] }; codex: { pool: string; accounts: { id: string }[] } } };
    expect(body.engines.claude.pool).toBe("set");
    expect(body.engines.claude.accounts.map(row => row.id)).toEqual([claude.id]);
    expect(body.engines.codex.accounts.map(row => row.id)).toEqual([t.a]);
  });

  test("a project's alias answers the canonical key", async () => {
    const t = team();
    expect(bindAccountToProject("codex", t.a, "repo-atlas").ok).toBe(true);
    expect(persistProjectAliases([{ source: "dir-atlas-old", target: "repo-atlas", displayName: "Atlas" }])).toBe(true);
    const answer = await read("dir-atlas-old", t.w1);
    expect(answer.status).toBe(200);
    expect(json(answer).project).toBe("repo-atlas");
  });

  test("the owner and the workspace's manager read it too; an unassigned project is the owner's alone", async () => {
    const t = team();
    expect(bindAccountToProject("codex", t.a, "repo-atlas").ok).toBe(true);
    expect((await read("repo-atlas", t.ownerCookie)).status).toBe(200);
    expect((await read("repo-atlas", t.manager)).status).toBe(200);
    expect((await read("repo-loose", t.ownerCookie)).status).toBe(200);
    expect((await read("repo-loose", t.manager)).status).toBe(403);
    expect((await read("repo-loose", t.w1)).status).toBe(403);
  });
});

describe("who is refused", () => {
  test("a member of another workspace gets the same refusal for an id, a path, an alias, an unknown key and a moved project", async () => {
    const t = team();
    expect(bindAccountToProject("codex", t.a, "repo-atlas").ok).toBe(true);
    expect(bindAccountToProject("codex", t.b, "repo-beta").ok).toBe(true);
    expect(persistProjectAliases([{ source: "dir-atlas-old", target: "repo-atlas", displayName: "Atlas" }])).toBe(true);
    const store = teamStore();
    placeProject(store, store.member(claimOwner(store))!, "repo-moved", W1);
    expect(bindAccountToProject("codex", t.a, "repo-moved").ok).toBe(true);
    expect((await read("repo-moved", t.w1)).status).toBe(200);
    placeProject(store, store.member(claimOwner(store))!, "repo-moved", W2);
    const own = await read("repo-atlas", t.w2);
    const answers = [
      own,
      await read("/srv/projects/atlas", t.w2),
      await read("dir-atlas-old", t.w2),
      await read("repo-never-heard-of", t.w2),
      await read("repo-moved", t.w1),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(answer.text).toBe(own.text);
    }
    expect(json(own)).toEqual({ error: "workspace access denied", code: "workspace_forbidden" });
    expect((await read("repo-moved", t.w2)).status).toBe(200);
  });

  test("no session is 401, a solo install 409, a bad project 400, a cross-origin call refused", async () => {
    const t = team();
    expect(json(await read("repo-atlas"))).toEqual({ error: "sign in required", code: "member_required" });
    expect((await read("repo-atlas", "not-a-session")).status).toBe(401);
    for (const bad of [undefined, "", "   ", "x".repeat(257), "repo\nbreak", "repo\u0000x"]) {
      const answer = await read(bad, t.w1);
      expect([answer.status, json(answer).code]).toEqual([400, "project_required"]);
    }
    expect((await read("repo-atlas", t.w1, { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("a solo install answers 409 solo_mode and creates no team file", async () => {
    const answer = await read("repo-atlas");
    expect([answer.status, json(answer)]).toEqual([409, { error: "this Delegatus has no team", code: "solo_mode" }]);
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "team"))).toBe(false);
  });

  test("an unreadable binding record is a named 409, not an empty pool", async () => {
    const t = team();
    seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 99, bindings: "damaged" });
    const answer = await read("repo-atlas", t.w1);
    expect([answer.status, json(answer)]).toEqual([409, { error: "the project's account list cannot be read", code: "account_list_unreadable" }]);
  });

  test("a revoked session is refused before anything about the project is read", async () => {
    const t = team();
    const store = teamStore();
    expect((await read("repo-atlas", t.w1)).status).toBe(200);
    revokeMember(store, store.member(claimOwner(store))!, store.member("m_one")!);
    const answer = await read("repo-atlas", t.w1);
    expect([answer.status, json(answer).code]).toEqual([401, "member_required"]);
  });
});

function claimOwner(store: ReturnType<typeof teamStore>): string {
  return store.members().find(member => member.role === "owner")!.id;
}
