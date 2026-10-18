import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-route-"));
const previous = new Map<string, string | undefined>();
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  previous.set(key, process.env[key]); process.env[key] = path.join(sandbox, key); fs.mkdirSync(process.env[key]!, { recursive: true });
}
const { NextRequest } = await import("next/server");
const { GET } = await import("./route");
const { GET: timeGET } = await import("../route");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { mintSession } = await import("@/lib/team/sessions");
afterAll(() => { resetTeamStoreForTests(); for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key]=value; } fs.rmSync(sandbox, { recursive: true, force: true }); });
function get(query: string, headers: Record<string,string>={}) { return GET(new NextRequest(`http://127.0.0.1/api/activity/tokens?${query}`, { headers: { host: "127.0.0.1", ...headers } })); }
test("the real route rejects cross-origin calls and serves an uncached empty bootstrap", async () => {
  expect((await get("", { origin: "https://evil.example", "sec-fetch-site":"cross-site" })).status).toBe(403);
  const response = await get(""); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json(); expect(body.params.preset).toBe("7d"); expect(body.coverage.countedFrom).toBeNull();
  expect(JSON.stringify(body)).not.toContain(sandbox);
});
test("the route enforces owner authority on every member/account selector, including after a cached owner read", async () => {
  const team=teamStore(), now=Date.now();
  for (const [id, role] of [["m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","owner"],["m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","member"]] as const) team.insertMember({ id, role, name: role, status:"active", color:"teal", telegram:null, createdAt:new Date(now).toISOString(), createdBy:"claim", revokedAt:null });
  const owner=mintSession(team,"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","claim",{surface:"desktop",browser:"chrome"},now);
  const member=mintSession(team,"m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","claim",{surface:"desktop",browser:"chrome"},now);
  for (const query of ["member=all","member=m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","stack=member","list=member","stack=account","list=account","account=fixture"]) {
    expect((await get(query,{cookie:`llv_member=${owner.value}`})).status).toBe(200);
    const refused=await get(query,{cookie:`llv_member=${member.value}`}); expect(refused.status).toBe(403); expect((await refused.json()).code).toBe("activity_member_forbidden");
  }
  expect((await get("",{cookie:`llv_member=${member.value}`})).status).toBe(200);
});
test("the existing Time route accepts and clamps the same free range to 366 days", async () => {
  const response=await timeGET(new NextRequest("http://127.0.0.1/api/activity?from=2020-01-01&to=2026-10-17&tz=UTC", {headers:{host:"127.0.0.1"}}));
  expect(response.status).toBe(200); const body=await response.json(); expect(body.days).toHaveLength(366);
  expect(body.days.at(-1).date).toBe("2026-10-17");
});
test("an unreadable store returns a generic uncached failure without a private path", async () => {
  const state=process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR=path.join(sandbox,"corrupt-state");
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR,"activity"),{recursive:true});
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR,"activity","records.sqlite"),"invalid fixture database");
  try {
    const response=await get(""); expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    const body=await response.text(); expect(body).toContain("activity token report unavailable"); expect(body).not.toContain(sandbox);
  } finally {process.env.LLV_STATE_DIR=state;}
});
