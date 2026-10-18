import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "./store";
import { commitUsage, DAY, maintainUsage } from "./tokenStore";
import { usageRecord, USAGE_NOW } from "./tokenUsage.fixture";
import { activityTokensResponse } from "./tokenReport";
import { ActivityMemberForbidden } from "./report";
import { parseActivityDates } from "./range";
let root: string, file: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "token-report-")); file = path.join(root, "records.sqlite"); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const owner = { mode: "team" as const, memberId: "member-a", canChoose: true };
const deps = () => ({ now: () => USAGE_NOW, file: () => file, tz: () => "Europe/Kyiv", aliases: () => ({ "project-old": "project-new" }),
  canonical: (p: string) => p === "project-old" ? "project-new" : p, projectNames: async () => new Map([["project-new", "Project"]]),
  roster: () => [{ id: "member-a", name: "Member", color: "teal", initials: "M", self: true }], accounts: () => new Map([["account-a", "Account"]]) });
function seed(id: string, extra: { model?: string; tier?: string; at?: number; project?: string } = {}) {
  const store = ActivityStore.open(file);
  try { store.transaction(() => commitUsage(store.db, { owner: { conversation: id, project: extra.project ?? "project-old", engine: "claude", role: "builder", pipelineId: null, stageId: null },
    records: [{ ...usageRecord(id, extra.at), ...(extra.model ? { model: extra.model } : {}), ...(extra.tier ? { tier: extra.tier } : {}) }],
    attribution: () => ({ member: "member-a", account: "account-a", model: null, tier: null }), malformed: 0, now: USAGE_NOW })); }
  finally { store.close(); }
}
const read = (query = "", overrides = {}) => activityTokensResponse(new URLSearchParams(query), owner, { ...deps(), ...overrides });
test("presets, invalid calendar dates, future dates, swapped endpoints and 366-day clamp", () => {
  const parsed = (q: string) => parseActivityDates(new URLSearchParams(q), USAGE_NOW, "UTC");
  for (const [range, days] of [["today",1],["7d",7],["30d",30],["90d",90],["365d",365]] as const) expect(parsed(`range=${range}`).days).toHaveLength(days);
  expect(parsed("from=2026-10-17&to=2026-12-01")).toMatchObject({ from: "2026-10-17", to: "2026-10-18", preset: null });
  expect(parsed("from=2026-10-15&to=2026-10-01")).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
  expect(parsed("from=2020-01-01&to=2026-10-18").days).toHaveLength(366);
  expect(parsed("from=2026-02-30&to=2026-10-18").preset).toBe("7d");
});
test("an absent store and an old schema without usage_meta return empty coverage", async () => {
  expect((await read()).coverage.countedFrom).toBeNull();
  const s = ActivityStore.open(file); s.db.exec("DROP TABLE usage_meta"); s.close();
  expect((await read()).totals.requests).toBe(0);
});
test("queries fold project aliases and preserve model, tier and kind splits for cost, cache and reasoning", async () => {
  seed("a"); seed("b", { tier: "fast", model: "other-model", project: "project-new" });
  const got = await read("project=project-old&stack=project&list=role&compare=previous");
  expect(got.scope).toEqual({ project: "project-new", name: "Project" });
  expect(got.totals).toEqual({ input: 20, cacheRead: 160, cacheWrite: 20, cacheWrite1h: 8, output: 40, reasoning: 10, requests: 2 });
  expect(got.costBasis.map(r => [r.model, r.tier, r.counts.cacheWrite1h]).sort()).toEqual([["fixture-model","standard",4],["other-model","fast",4]]);
  expect(got.list[0]!.counts).toEqual(got.totals);
  expect(got.series.flatMap(r => r.parts).map(r => r.key)).toEqual(["project-new"]);
  expect(got.previous?.totals.requests).toBe(0);
  expect(JSON.stringify(got)).not.toContain(root);
  expect(JSON.stringify(got)).not.toContain("private response text");
});
test("owner-only selectors are refused before cache lookup, including empty or hostile selectors", async () => {
  seed("a");
  const restricted = { ...owner, canChoose: false };
  for (const query of ["member=all", "member=member-a", "member=", "account=account-a", "account=", "stack=member", "list=member", "stack=account", "list=account"]) {
    await read(query);
    await expect(activityTokensResponse(new URLSearchParams(query), restricted, deps())).rejects.toBeInstanceOf(ActivityMemberForbidden);
  }
  const got = await activityTokensResponse(new URLSearchParams(), restricted, deps());
  expect(got.totals.requests).toBe(1); expect(got.member.members).toEqual([]);
  expect(JSON.stringify(got)).not.toContain("account-a");
  expect(JSON.stringify(got)).not.toContain("member-a");
});
test("one version hits the bounded shared cache, a new commit and an alias change recompute", async () => {
  seed("a"); const timings: string[] = [];
  const overrides = { measured: (name: string) => { timings.push(name); } };
  await read("", overrides); expect(timings.sort()).toEqual(["list", "series", "totals"]);
  timings.length=0; const cached = await read("", overrides); expect(timings).toEqual([]);
  cached.totals.requests=999; expect((await read("", overrides)).totals.requests).toBe(1);
  seed("b"); expect((await read("", overrides)).totals.requests).toBe(2); expect(timings).toHaveLength(3);
  timings.length=0; await read("stack=project", { ...overrides, aliases: () => ({ "project-old": "different" }) }); expect(timings).toHaveLength(3);
  for (let i=0;i<17;i++) await read(`model=model-${i}`, overrides);
  timings.length=0; await read("", overrides); expect(timings).toHaveLength(3);
});
test("bucket edges include DST; weeks are Mondays, and top lists and chart parts sum to totals", async () => {
  for (let i=0;i<15;i++) seed(`row-${i}`, { model: `model-${i}` });
  for (const [query, bucket] of [["range=today","hour"],["range=7d","day"],["range=90d","day"],["range=365d","week"]] as const) expect((await read(query)).params.bucket).toBe(bucket);
  const got = await read("stack=model");
  expect(got.list).toHaveLength(13); expect(got.list.at(-1)!.key).toBe("other");
  expect(got.list.reduce((s,r)=>s+r.counts.requests,0)).toBe(got.totals.requests);
  expect(got.series.flatMap(r=>r.parts).reduce((s,r)=>s+r.counts.requests,0)).toBe(got.totals.requests);
  expect(Math.max(...got.series.map(r=>r.parts.length))).toBeLessThanOrEqual(13);
  const dates = parseActivityDates(new URLSearchParams("from=2026-03-29&to=2026-03-29&tz=Europe/Kyiv"), USAGE_NOW, "UTC");
  expect(dates.days[0]!.end - dates.days[0]!.start).toBe(23*3_600_000);
  const weeks=await read("from=2025-10-12&to=2026-10-12");
  expect(weeks.series).toHaveLength(54);
  expect(weeks.params.from).toBe("2025-10-12"); expect(weeks.params.to).toBe("2026-10-12");
});
test("zone rebuild is persisted, preserves old-zone days and accepts new writes", async () => {
  seed("a");
  const s = ActivityStore.open(file);
  try { s.transaction(() => maintainUsage(s.db, USAGE_NOW, "America/New_York")); }
  finally { s.close(); }
  const got = await read("range=365d&tz=America/New_York");
  expect(got.totals.requests).toBe(1);
  expect(got.coverage.daysZone?.zone).toBe("Europe/Kyiv");
  seed("b", { at: USAGE_NOW - DAY });
  expect((await read("tz=America/New_York")).totals.requests).toBe(2);
});
test("persisted dimension summaries agree with the filtered day path for every grouping", async () => {
  seed("a");seed("b",{model:"other-model",tier:"fast",project:"project-new"});
  for(const dimension of ["kind","model","role","project","member","account","engine"]) {
    const query=`stack=${dimension}&list=${dimension==="kind"?"model":dimension}`;
    const fast=await read(query);
    // All seeded rows have this role; naming it exercises the detailed day path.
    const detailed=await read(`${query}&role=builder`);
    expect(detailed.totals).toEqual(fast.totals);
    expect(detailed.series).toEqual(fast.series);
    expect(detailed.list).toEqual(fast.list);
    expect(detailed.costBasis).toEqual(fast.costBasis);
  }
});
test("the actual aggregate selectors use scoped time indexes, including single and multiple project keys", async () => {
  seed("a");
  const plans: string[]=[];
  for(const query of ["","project=other","project=project-old","range=today","member=member-a"]) {
    await read(query,{measured:(_name:string,_ms:number,plan:()=>unknown)=>{
      const details=(plan() as Array<{detail:string}>).map(r=>r.detail); plans.push(...details);
      expect(details.some(d=>d.includes("SEARCH usage_")&&(d.includes("day>?")||d.includes("hour>?")))).toBeTrue();
      expect(details.some(d=>/^SCAN usage_(?:days|hours|summaries)\b/.test(d))).toBeFalse();
    }});
  }
  expect(plans.some(d=>d.includes("usage_summaries USING PRIMARY KEY"))).toBeTrue();
  expect(plans.some(d=>d.includes("usage_hours USING PRIMARY KEY"))).toBeTrue();
});
test("a real process restart starts with an empty answer cache", async () => {
  seed("a");
  const code=`const {activityTokensResponse}=await import(process.argv[1]); let queries=0;
    const deps={now:()=>Date.parse('2026-10-18T12:00:00Z'),file:()=>process.argv[2],tz:()=> 'Europe/Kyiv',aliases:()=>({}),
      projectNames:async()=>new Map(),measured:()=>{queries++}};
    const viewer={mode:'team',memberId:null,canChoose:false};
    await activityTokensResponse(new URLSearchParams(),viewer,deps);await activityTokensResponse(new URLSearchParams(),viewer,deps);
    process.stdout.write(JSON.stringify(queries));`;
  for(let restart=0;restart<2;restart++) {
    const child=Bun.spawn([process.execPath,"-e",code,path.join(import.meta.dir,"tokenReport.ts"),file],{stdout:"pipe",stderr:"pipe"});
    const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text(); expect(await child.exited,errors).toBe(0); expect(JSON.parse(output)).toBe(3);
  }
});
