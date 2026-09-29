import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Establish every state root before importing production modules.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "activity-route-"));
const previous = new Map<string, string | undefined>();
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  previous.set(key, process.env[key]);
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
const { NextRequest } = await import("next/server");
const { GET } = await import("./route");
const { indexTranscriptSources } = await import("@/lib/search/transcriptSearch");
const { recordOperatorRequest } = await import("@/lib/activity/requestLedger");

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SECRET_PROMPT = "please rotate the quartz-lantern credential";
const SECRET_REPLY = "rotated the quartz-lantern credential";

function get(query: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(`http://127.0.0.1/api/activity${query}`, { headers: { host: "127.0.0.1", ...headers } }));
}

test("a cross-origin request is refused", async () => {
  const response = await get("?range=today", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  expect(response.status).toBe(403);
});

test("the answer carries both axes and no path, title or message text", async () => {
  const now = Date.now();
  const transcript = path.join(sandbox, "HOME", "session-quartz.jsonl");
  const stamp = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();
  fs.writeFileSync(transcript, [
    { type: "user", timestamp: stamp(50), message: { role: "user", content: SECRET_PROMPT } },
    { type: "assistant", timestamp: stamp(20), message: { role: "assistant", content: [{ type: "text", text: SECRET_REPLY }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await indexTranscriptSources([{ path: transcript, project: "harbor", engine: "claude", size: fs.statSync(transcript).size, mtimeMs: now }]);
  recordOperatorRequest(
    { headers: new Headers({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36" }) },
    { kind: "message", idempotencyKey: "route-test-send", project: "harbor" },
    { now: () => now - 45 * 60_000 },
  );

  /* Out-of-range and malformed parameters are clamped, never refused. */
  const response = await get("?range=7d&tz=Not%2FAZone&window=99&break=1&rounding=weekly");
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as {
    params: { windowMin: number; breakMin: number; rounding: string; tz: string };
    coverage: { agentIndex: string; hosts: Array<{ host: string; complete: boolean; unread: Array<{ start: number; end: number }>; sources: Array<{ source: string; state: string; scope: string }> }> };
    totals: { humanMs: number; wallMs: number; supervisedMs: number; unattendedMs: number; unattendedUnreadMs: number };
    days: Array<{ hours: unknown[]; projects: Array<{ project: string | null }> }>;
    projects: Array<{ project: string | null; humanMs: number; wallMs: number; byEngine: Record<string, number>; byRole: Record<string, number> }>;
  };
  /* An unknown zone falls back to the settings' zone, Europe/Kyiv by default. */
  expect(body.params).toEqual({ windowMin: 15, breakMin: 15, rounding: "clock-hour", tz: "Europe/Kyiv" });
  expect(body.days).toHaveLength(7);
  expect(body.coverage.agentIndex).toBe("ok");
  expect(body.coverage.hosts.map((host) => [host.host, host.sources.map((source) => `${source.source}:${source.state}:${source.scope}`)]))
    .toEqual([["local", ["ledger:read:delegatus", "ingest:absent:all"]]]);
  /* The ledger read Delegatus requests only; terminal input here had no export. */
  expect(body.coverage.hosts[0]!.complete).toBe(false);
  expect(body.coverage.hosts[0]!.unread).toHaveLength(1);
  /* One request 45 minutes ago with a 15-minute window, and a 30-minute turn
     that began 5 minutes before it: 15 minutes supervised, 15 unattended. */
  expect(body.totals.humanMs).toBe(15 * 60_000);
  expect(body.totals.wallMs).toBe(30 * 60_000);
  expect(body.totals.supervisedMs).toBe(15 * 60_000);
  expect(body.totals.unattendedMs).toBe(15 * 60_000);
  /* The page's presentation fields: that host holds every project and was
     not read, so the unattended part is unclear; one row per clock hour. */
  expect(body.totals.unattendedUnreadMs).toBe(15 * 60_000);
  expect(body.days.at(-1)!.hours.length).toBeGreaterThanOrEqual(23);
  expect([...new Set(body.days.flatMap((day) => day.projects).map((entry) => entry.project))]).toEqual(["harbor"]);
  const harbor = body.projects.find((row) => row.project === "harbor")!;
  expect(harbor.byEngine).toEqual({ claude: 30 * 60_000 });
  expect(harbor.byRole).toEqual({ unregistered: 30 * 60_000 });
  for (const leaked of [SECRET_PROMPT, SECRET_REPLY, "quartz", transcript, "session-quartz", sandbox]) expect(text).not.toContain(leaked);
});

test("with this host's ingest caught up, its coverage is complete and no export exists", async () => {
  const { ingestTranscripts } = await import("@/lib/activity/ingest");
  const { ActivityStore } = await import("@/lib/activity/store");
  const now = Date.now();
  const stamp = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();
  /* A terminal session begun eight days ago and still in use: the backfill
     reads its history, and a prompt typed 20 minutes ago counts. */
  const transcript = path.join(sandbox, "HOME", "session-terminal.jsonl");
  const typed = (offsetMin: number, uuid: string) => ({ type: "user", timestamp: stamp(offsetMin), uuid, sessionId: "s", cwd: "/work/harbor", entrypoint: "cli", promptSource: "typed", message: { role: "user", content: `typed request ${uuid}` } });
  fs.writeFileSync(transcript, [typed(8 * 24 * 60, "t-old"), typed(20, "t-new")].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const store = ActivityStore.open();
  try {
    const stat = fs.statSync(transcript);
    await ingestTranscripts([{ path: transcript, engine: "claude", size: stat.size, mtimeMs: stat.mtimeMs }], {
      complete: true,
      listedAt: now,
      store,
      resolver: () => () => ({ project: "harbor", launch: null, registered: false }),
    });
  } finally {
    store.close();
  }
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "activity", "hosts"))).toBeFalse();

  /* Seven days: the history read covers all of it at any hour of the day. */
  const response = await get("?range=7d");
  const body = await response.json() as {
    coverage: { hosts: Array<{ host: string; complete: boolean; unread: unknown[]; sources: Array<{ source: string; state: string; readAt: number | null }> }> };
    totals: { humanMs: number; coverage: { complete: boolean } };
  };
  const host = body.coverage.hosts[0]!;
  expect(host.sources.map((source) => `${source.source}:${source.state}`)).toEqual(["ledger:read", "ingest:read"]);
  expect(host.sources[1]!.readAt).not.toBeNull();
  /* The pass just finished: caught up, so this host is read to now. */
  expect(host.complete).toBeTrue();
  expect(host.unread).toEqual([]);
  expect(body.totals.coverage.complete).toBeTrue();
  expect(body.totals.humanMs).toBeGreaterThan(0);
});

test("?project= answers that project's share of the same count: the numbers its row carries", async () => {
  type Figures = { humanMs: number; humanHours: number; requests: number; wallMs: number; supervisedMs: number; unattendedMs: number; agentHoursMs: number; coverage: unknown; agentCoverage: unknown };
  type Body = { scope: { project: string; name: string | null } | null; totals: Figures; projects: Array<Figures & { project: string | null }> };
  const all = await (await get("?range=7d")).json() as Body;
  const response = await get("?range=7d&project=harbor");
  expect(response.status).toBe(200);
  const scoped = await response.json() as Body;
  expect(all.scope).toBeNull();
  expect(scoped.scope).toEqual({ project: "harbor", name: null });
  const pick = (figures: Figures) => ({
    humanMs: figures.humanMs, humanHours: figures.humanHours, requests: figures.requests, wallMs: figures.wallMs, supervisedMs: figures.supervisedMs,
    unattendedMs: figures.unattendedMs, agentHoursMs: figures.agentHoursMs, coverage: figures.coverage, agentCoverage: figures.agentCoverage,
  });
  const harbor = all.projects.find((row) => row.project === "harbor")!;
  expect(harbor.humanMs).toBeGreaterThan(0);
  expect(pick(scoped.totals)).toEqual(pick(harbor));
  expect(scoped.projects).toEqual(all.projects);
});

test("GET keeps team-era terminal input unknown after the owner is revoked", async () => {
  const { ingestTranscripts } = await import("@/lib/activity/ingest");
  const { ActivityStore } = await import("@/lib/activity/store");
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { mintSession } = await import("@/lib/team/sessions");
  const now = Date.now();
  const project = "revocation-fixture";
  const memberId = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const activeMemberId = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const team = teamStore();
  team.insertMember({ id: memberId, name: "Owner", role: "owner", status: "active", color: "teal", telegram: null,
    createdAt: new Date(now - 60_000).toISOString(), createdBy: "claim", revokedAt: null });
  team.insertMember({ id: activeMemberId, name: "Member", role: "member", status: "active", color: "sky", telegram: null,
    createdAt: new Date(now - 60_000).toISOString(), createdBy: "join", revokedAt: null });
  const session = mintSession(team, memberId, "claim", { surface: "desktop", browser: "chrome" }, now);
  const activeSession = mintSession(team, activeMemberId, "claim", { surface: "desktop", browser: "chrome" }, now);
  const transcript = path.join(sandbox, "HOME", "team-terminal.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: new Date(now - 20 * 60_000).toISOString(),
    uuid: "team-terminal-1", sessionId: "team-terminal", cwd: "/work/revocation-fixture", entrypoint: "cli", promptSource: "typed",
    message: { role: "user", content: "typed terminal request" } }) + "\n");
  const store = ActivityStore.open();
  try {
    const stat = fs.statSync(transcript);
    await ingestTranscripts([{ path: transcript, engine: "claude", size: stat.size, mtimeMs: stat.mtimeMs }], {
      complete: true, listedAt: now, now: () => now, store,
      resolver: () => () => ({ project, launch: null, registered: false, mode: "team" }),
    });
    expect(store.hostState("")?.teamHistory).toBeTrue();
  } finally { store.close(); }
  const before = await (await get(`?range=7d&project=${project}`, { cookie: `llv_member=${session.value}` })).json() as {
    totals: { requests: number; humanMs: number }; unknownAuthorInputs: number;
  };
  expect(before.totals.requests).toBe(0);
  expect(before.totals.humanMs).toBe(0);
  expect(before.unknownAuthorInputs).toBeGreaterThanOrEqual(1);
  team.updateMember({ ...team.member(memberId)!, status: "revoked", revokedAt: new Date(now).toISOString() });
  resetTeamStoreForTests();
  recordOperatorRequest(new NextRequest("http://127.0.0.1/api/tasks", { headers: {
    cookie: `llv_member=${activeSession.value}`, "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
  } }), { kind: "task", project, idempotencyKey: "former-team-active-member-task" }, { now: () => now - 15 * 60_000 });
  const memberAfter = await (await get(`?range=7d&project=${project}`, { cookie: `llv_member=${activeSession.value}` })).json() as typeof before;
  expect(memberAfter.totals.requests).toBe(1);
  expect(memberAfter.totals.humanMs).toBe(10 * 60_000);
  expect(memberAfter.unknownAuthorInputs).toBeGreaterThanOrEqual(1);
  const after = await (await get(`?range=7d&project=${project}`)).json() as typeof before;
  expect(after.totals.requests).toBe(0);
  expect(after.totals.humanMs).toBe(0);
  expect(after.unknownAuthorInputs).toBeGreaterThanOrEqual(before.unknownAuthorInputs);
});

test("?member=: the owner reads any member or all of them; a member reads only themselves", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { mintSession } = await import("@/lib/team/sessions");
  const now = Date.now();
  const project = "member-filter-fixture";
  /* No live owner yet (the one before was revoked): a solo host's operator
     may read every member. */
  expect((await get("?range=7d&member=all")).status).toBe(200);

  const ownerId = "m_cccccccccccccccccccccccccccccccc";
  const memberId = "m_dddddddddddddddddddddddddddddddd";
  const team = teamStore();
  team.insertMember({ id: ownerId, name: "Ivo Pell", role: "owner", status: "active", color: "amber", telegram: null,
    createdAt: new Date(now - 60_000).toISOString(), createdBy: "claim", revokedAt: null });
  team.insertMember({ id: memberId, name: "Rhea Stone", role: "member", status: "active", color: "violet", telegram: null,
    createdAt: new Date(now - 60_000).toISOString(), createdBy: "join", revokedAt: null });
  resetTeamStoreForTests();
  const owner = `llv_member=${mintSession(teamStore(), ownerId, "claim", { surface: "desktop", browser: "chrome" }, now).value}`;
  const member = `llv_member=${mintSession(teamStore(), memberId, "claim", { surface: "desktop", browser: "chrome" }, now).value}`;
  const request = (cookie: string, key: string, minutesAgo: number) => recordOperatorRequest(new NextRequest("http://127.0.0.1/api/tasks", { headers: {
    cookie, "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
  } }), { kind: "task", project, idempotencyKey: key }, { now: () => now - minutesAgo * 60_000 });
  request(owner, "member-filter-owner", 40);
  request(member, "member-filter-member-1", 40);
  request(member, "member-filter-member-2", 20);

  type Body = {
    totals: { requests: number };
    unknownAuthorInputs: number;
    member: { selection: string; memberId: string | null; canChoose: boolean; notSplit: string[];
      members: Array<{ id: string; name: string | null; initials: string | null; self: boolean; requests: number }> };
  };
  const read = async (query: string, cookie: string) => {
    const response = await get(`?range=7d&project=${project}${query}`, { cookie });
    return { status: response.status, body: await response.json() as Body & { code?: string } };
  };

  const own = await read("", owner);
  expect(own.status).toBe(200);
  expect(own.body.member).toMatchObject({ selection: "self", memberId: ownerId, canChoose: true, notSplit: ["agents", "unknownAuthorInputs"] });
  expect(own.body.totals.requests).toBe(1);
  /* The earlier case's member worked in the range on another project: listed, with none here. */
  expect(own.body.member.members.map((row) => [row.name, row.initials, row.self, row.requests])).toEqual([
    ["Rhea Stone", "RS", false, 2], ["Ivo Pell", "IP", true, 1], ["Member", "ME", false, 0],
  ]);
  const all = await read("&member=all", owner);
  expect(all.status).toBe(200);
  expect(all.body.member.selection).toBe("all");
  expect(all.body.totals.requests).toBe(3);
  /* The terminal input with no author (an earlier case) is nobody's, and still counted apart. */
  expect(all.body.unknownAuthorInputs).toBeGreaterThanOrEqual(1);
  expect(all.body.member.members.every((row) => row.id.startsWith("m_"))).toBe(true);
  const one = await read(`&member=${memberId}`, owner);
  expect(one.status).toBe(200);
  expect(one.body.totals.requests).toBe(2);

  for (const query of ["&member=all", `&member=${ownerId}`]) {
    const refused = await read(query, member);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("activity_member_forbidden");
  }
  for (const query of ["", `&member=${memberId}`]) {
    const self = await read(query, member);
    expect(self.status).toBe(200);
    expect(self.body.totals.requests).toBe(2);
    expect(self.body.member).toEqual({ selection: "self", memberId, canChoose: false, members: [], notSplit: [] });
  }
  /* No email or handle reaches the answer. */
  const text = JSON.stringify(all.body);
  for (const leaked of ["@", "telegram"]) expect(text).not.toContain(leaked);
});
