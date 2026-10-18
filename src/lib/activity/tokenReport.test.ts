import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "./store";
import { commitUsage, DAY, HOUR, maintainUsage, USAGE_MAINTENANCE_LIMIT, USAGE_REBUILD_SCAN_LIMIT } from "./tokenStore";
import { usageRecord, USAGE_NOW } from "./tokenUsage.fixture";
import { addTokens, emptyTokens, type TokenCounts } from "./tokenUsage";
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
function seed(id: string, extra: { model?: string; tier?: string; at?: number; project?: string; engine?: "claude" | "codex"; account?: string } = {}) {
  const store = ActivityStore.open(file);
  try { store.transaction(() => commitUsage(store.db, { owner: { conversation: id, project: extra.project ?? "project-old", engine: extra.engine ?? "claude", role: "builder", pipelineId: null, stageId: null },
    records: [{ ...usageRecord(id, extra.at), ...(extra.model ? { model: extra.model } : {}), ...(extra.tier ? { tier: extra.tier } : {}) }],
    attribution: () => ({ member: "member-a", account: extra.account ?? "account-a", model: null, tier: null }), malformed: 0, now: USAGE_NOW })); }
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
test("top=all names every listed entry for the project picker, and caches apart from the top-12 answer", async () => {
  for (let i=0;i<15;i++) seed(`picker-${i}`, { project: `project-${String(i).padStart(2,"0")}` });
  const capped = await read("list=project");
  expect(capped.list).toHaveLength(13); expect(capped.list.at(-1)!.key).toBe("other");
  const all = await read("list=project&top=all");
  expect(all.list).toHaveLength(15); expect(all.list.some(r => r.key === "other")).toBe(false);
  expect(all.list.reduce((s,r)=>s+r.counts.requests,0)).toBe(all.totals.requests);
  expect((await read("list=project&top=bogus")).list).toHaveLength(13);
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
test("zone generation copies and cleans in bounded restartable phases while ingest continues", async () => {
  const store = ActivityStore.open(file);
  const days = 80, projectsPerDay = 200, rows = days * projectsPerDay;
  const hour = Math.floor(USAGE_NOW / HOUR);
  try {
    store.transaction(() => {
      store.db.query("UPDATE usage_meta SET maintenance_day=? WHERE singleton=1").run(Math.floor(USAGE_NOW / DAY));
      const add = store.db.query(`INSERT INTO usage_hours(host,hour,conversation,model,tier,account,engine,project,role,member,pipeline,stage,requests,input,cache_read,cache_write,cache_write_1h,output,reasoning)
        VALUES('',?,?,?,?,?,'claude',?,'builder','member-a',NULL,NULL,1,2,3,4,0,5,1)`);
      for (let day=0;day<days;day++) for (let project=0;project<projectsPerDay;project++) {
        const id=day*projectsPerDay+project;
        add.run(hour-day*24, `conversation-${String(id).padStart(5,"0")}`, "fixture-model", "standard", "account-a", `project-${day}-${project}`);
      }
    });
    store.db.exec(`CREATE TABLE phase_counts(name TEXT PRIMARY KEY, inserted INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
      INSERT INTO phase_counts(name) VALUES('usage_days'),('usage_days_rebuild'),('usage_summaries'),('usage_summaries_rebuild');
      CREATE TRIGGER count_days_insert AFTER INSERT ON usage_days BEGIN UPDATE phase_counts SET inserted=inserted+1 WHERE name='usage_days'; END;
      CREATE TRIGGER count_days_delete AFTER DELETE ON usage_days BEGIN UPDATE phase_counts SET deleted=deleted+1 WHERE name='usage_days'; END;
      CREATE TRIGGER count_shadow_days_insert AFTER INSERT ON usage_days_rebuild BEGIN UPDATE phase_counts SET inserted=inserted+1 WHERE name='usage_days_rebuild'; END;
      CREATE TRIGGER count_shadow_days_delete AFTER DELETE ON usage_days_rebuild BEGIN UPDATE phase_counts SET deleted=deleted+1 WHERE name='usage_days_rebuild'; END;
      CREATE TRIGGER count_summaries_insert AFTER INSERT ON usage_summaries BEGIN UPDATE phase_counts SET inserted=inserted+1 WHERE name='usage_summaries'; END;
      CREATE TRIGGER count_summaries_delete AFTER DELETE ON usage_summaries BEGIN UPDATE phase_counts SET deleted=deleted+1 WHERE name='usage_summaries'; END;
      CREATE TRIGGER count_shadow_summaries_insert AFTER INSERT ON usage_summaries_rebuild BEGIN UPDATE phase_counts SET inserted=inserted+1 WHERE name='usage_summaries_rebuild'; END;
      CREATE TRIGGER count_shadow_summaries_delete AFTER DELETE ON usage_summaries_rebuild BEGIN UPDATE phase_counts SET deleted=deleted+1 WHERE name='usage_summaries_rebuild'; END;`);
  } finally { store.close(); }
  const childCode = `const {ActivityStore}=await import(process.argv[1]);const {maintainUsage}=await import(process.argv[2]);const s=ActivityStore.open(process.argv[3]);try{const start=performance.now();s.transaction(()=>maintainUsage(s.db,Number(process.argv[4]),process.argv[5]));process.stdout.write(String(performance.now()-start))}finally{s.close()}`;
  const modulePath = (name: string) => path.join(import.meta.dir, name);
  let liveDeltaAdded = false, maxMaintenanceMs = 0, maxMaintenancePhase = "";
  for (let pass=0;pass<64;pass++) {
    const current = ActivityStore.open(file);
    const phase = current.db.query<{ rebuild_phase: string | null }, []>("SELECT rebuild_phase FROM usage_meta WHERE singleton=1").get()!.rebuild_phase;
    current.db.exec("UPDATE phase_counts SET inserted=0,deleted=0");
    current.close();
    if (phase === "copy-days" && !liveDeltaAdded) {
      seed("zone-live-delta", { project: "project-live" });
      const reset=ActivityStore.open(file); reset.db.exec("UPDATE phase_counts SET inserted=0,deleted=0"); reset.close();
      liveDeltaAdded = true;
    }
    const child = Bun.spawn([process.execPath,"-e",childCode,modulePath("store.ts"),modulePath("tokenStore.ts"),file,String(USAGE_NOW),"America/New_York"],{stdout:"pipe",stderr:"pipe"});
    const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
    expect(await child.exited, stderr || stdout).toBe(0);
    if (Number(stdout) > maxMaintenanceMs) { maxMaintenanceMs = Number(stdout); maxMaintenancePhase=phase ?? "start"; }
    const check=ActivityStore.open(file);
    const counts=check.db.query<{name:string;inserted:number;deleted:number}, []>("SELECT * FROM phase_counts").all();
    const nextPhase=check.db.query<{rebuild_phase:string|null}, []>("SELECT rebuild_phase FROM usage_meta WHERE singleton=1").get()!.rebuild_phase;
    if (phase === "scan") {
      expect(counts.find(row=>row.name==="usage_days_rebuild")!.inserted).toBeLessThanOrEqual(USAGE_REBUILD_SCAN_LIMIT);
    }
    if (["prepare-days","prepare-summaries","copy-days","copy-summaries","prune-days","prune-summaries","cleanup-days","cleanup-summaries"].includes(phase ?? "")) {
      for (const count of counts) {
        expect(count.inserted, `${phase} ${count.name} insert bound`).toBeLessThanOrEqual(USAGE_MAINTENANCE_LIMIT);
        expect(count.deleted, `${phase} ${count.name} delete bound`).toBeLessThanOrEqual(USAGE_MAINTENANCE_LIMIT);
      }
    }
    check.close();
    if (!nextPhase) break;
    if (pass === 63) throw new Error("zone rebuild did not finish within the bounded pass limit");
  }
  expect(liveDeltaAdded).toBeTrue();
  console.log(`zone rebuild max ${maxMaintenanceMs.toFixed(2)} ms in ${maxMaintenancePhase} for ${rows} source rows`);
  const finished=ActivityStore.open(file);
  try {
    const active = finished.db.query<{ requests: number; input: number }, [string]>("SELECT SUM(requests) AS requests,SUM(input) AS input FROM usage_days WHERE zone=?").get("America/New_York")!;
    expect(active.requests).toBe(rows+1);
    expect(active.input).toBe(rows*2+usageRecord("zone-live-delta").counts.input);
    expect(finished.db.query<{ requests: number }, [string]>("SELECT SUM(requests) AS requests FROM usage_summaries WHERE zone=? AND dimension='all' AND key='all'").get("America/New_York")!.requests).toBe(rows+1);
    expect(finished.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_days_rebuild").get()!.n).toBe(0);
    expect(finished.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_summaries_rebuild").get()!.n).toBe(0);
  } finally { finished.close(); }
}, 15_000);
test("hourly totals, list and chart use the requested timezone boundaries", async () => {
  seed("utc-boundary", { at: Date.parse("2026-10-17T21:30:00Z") });
  for (const query of [
    "from=2026-10-17&to=2026-10-17&tz=UTC",
    "from=2026-10-17&to=2026-10-18&tz=UTC",
  ]) {
    const got = await read(query);
    const sum = (counts: TokenCounts[]) => counts.reduce((total, row) => { addTokens(total, row); return total; }, emptyTokens());
    const chartCounts = sum(got.series.flatMap(row => row.parts.map(part => part.counts)));
    const listCounts = sum(got.list.map(row => row.counts));
    const basisCounts = sum(got.costBasis.map(row => row.counts));
    expect(got.totals.requests).toBe(1);
    expect(basisCounts).toEqual(got.totals);
    expect(listCounts).toEqual(got.totals);
    expect(chartCounts).toEqual(got.totals);
  }
  const nextDay = await read("from=2026-10-18&to=2026-10-18&tz=UTC");
  expect(nextDay.totals).toEqual(emptyTokens());
  expect(nextDay.costBasis).toEqual([]);
  expect(nextDay.list).toEqual([]);
  expect(nextDay.series.flatMap(row => row.parts)).toEqual([]);
});
test("fractional timezone hourly ranges include every UTC edge bucket for one and two days", async () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  for (const [zoneIndex, tz] of ["Asia/Kolkata", "Asia/Kathmandu"].entries()) {
    if (zoneIndex > 0) { fs.rmSync(root, { recursive: true, force: true }); root = fs.mkdtempSync(path.join(os.tmpdir(), "token-report-")); file = path.join(root, "records.sqlite"); }
    const firstDay = parseActivityDates(new URLSearchParams("from=2026-10-18&to=2026-10-18"), now, tz).days[0]!;
    const secondDay = parseActivityDates(new URLSearchParams("from=2026-10-19&to=2026-10-19"), now, tz).days[0]!;
    for (const [index, at] of [firstDay.start + 60_000, firstDay.end - 60_000, secondDay.start + 60_000, secondDay.end - 60_000].entries()) {
      seed(`fractional-${tz}-${index}`, { at });
    }
    for (const [to, expectedRequests] of [["2026-10-18", 3], ["2026-10-19", 4]] as const) {
      const from = "2026-10-18";
      const got = await read(`from=${from}&to=${to}&tz=${tz}`, { now: () => now, tz: () => tz });
      const sum = (rows: TokenCounts[]) => rows.reduce((total, row) => { addTokens(total, row); return total; }, emptyTokens());
      const listCounts = sum(got.list.map(row => row.counts));
      const basisCounts = sum(got.costBasis.map(row => row.counts));
      const seriesCounts = sum(got.series.flatMap(row => row.parts.map(part => part.counts)));
      expect(got.totals.requests).toBe(expectedRequests);
      expect(basisCounts).toEqual(got.totals);
      expect(listCounts).toEqual(got.totals);
      expect(seriesCounts).toEqual(got.totals);
      const days = parseActivityDates(new URLSearchParams(`from=${from}&to=${to}`), now, tz).days;
      expect(got.series[0]!.start).toBe(Math.floor(days[0]!.start / HOUR) * HOUR);
      expect(got.series.at(-1)!.end).toBe(Math.ceil(days.at(-1)!.end / HOUR) * HOUR);
      expect(got.series).toHaveLength(Math.ceil(days.at(-1)!.end / HOUR) - Math.floor(days[0]!.start / HOUR));
    }
  }
});
test("historical one and two day ranges use retained daily aggregates and agree with totals", async () => {
  const oldAt = USAGE_NOW - DAY;
  seed("old", { at: oldAt });
  seed("before-hour-cutoff", { at: USAGE_NOW - 3_600_000 });
  seed("after-hour-cutoff", { at: USAGE_NOW + 7_200_000 });
  const futureNow = USAGE_NOW + 92 * DAY + 3_600_000;
  const store = ActivityStore.open(file);
  try { store.transaction(() => maintainUsage(store.db, futureNow, "Europe/Kyiv")); }
  finally { store.close(); }
  const readAtFuture = (query: string) => read(query, { now: () => futureNow });
  for (const from of [new Date(oldAt).toISOString().slice(0, 10), new Date(USAGE_NOW).toISOString().slice(0, 10)]) {
    const single = await readAtFuture(`from=${from}&to=${from}`);
    expect(single.params.bucket).toBe("day");
    expect(single.totals.requests).toBeGreaterThan(0);
    expect(single.series.flatMap(row => row.parts).reduce((n, part) => n + part.counts.requests, 0)).toBe(single.totals.requests);
    expect(single.list.reduce((n, row) => n + row.counts.requests, 0)).toBe(single.totals.requests);
    const next = new Date(Date.parse(`${from}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const twoDays = await readAtFuture(`from=${from}&to=${next}`);
    expect(twoDays.params.bucket).toBe("day");
    expect(twoDays.series.flatMap(row => row.parts).reduce((n, part) => n + part.counts.requests, 0)).toBe(twoDays.totals.requests);
  }
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
test("a Claude and a Codex account both named default are two rows with their own labels, and a filter keeps one engine", async () => {
  seed("claude-conversation", { engine: "claude", account: "claude:default" });
  seed("codex-conversation", { engine: "codex", account: "codex:default" });
  const accounts = () => new Map([["claude:default", "Claude main"], ["codex:default", "Codex main"]]);
  const both = await read("list=account&range=7d", { accounts });
  expect(both.list.map(row => [row.key, row.name]).sort()).toEqual([["claude:default", "Claude main"], ["codex:default", "Codex main"]]);
  const one = await read("list=account&range=7d&account=codex:default", { accounts });
  expect(one.list.map(row => row.key)).toEqual(["codex:default"]);
  expect(one.totals.input).toBe(both.list.find(row => row.key === "codex:default")!.counts.input);
});
