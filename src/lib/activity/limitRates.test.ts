import { expect, test } from "bun:test";
import { risesFromSamples, dayRate, planMedian, nearestRate } from "./limitRates";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "./store";
import { refreshLimitRates } from "./limitRates";
import { DAY, HOUR } from "./tokenStore";

const samples = (used: number[]) => used.map((v, i) => ({ t: i * 300, remaining: 100 - v }));
test("method R counts rises, ignores dips, rebases falls and recognises confirmed restarts", () => {
  expect(risesFromSamples(samples([20, 25, 24, 27]))).toEqual([{ t: 300, rise: 5 }, { t: 900, rise: 2 }]);
  expect(risesFromSamples(samples([88, 44, 88]))).toEqual([]);
  expect(risesFromSamples(samples([80, 3, 7, 12]))).toEqual([{ t: 300, rise: 3 }, { t: 600, rise: 4 }, { t: 900, rise: 5 }]);
  expect(risesFromSamples(samples([80, 30, 40]))).toEqual([{ t: 600, rise: 10 }]);
});
test("rates require ten percentage points and a positive priced denominator; medians ignore unknown plans", () => {
  expect(dayRate(9.9, 2)).toBeNull(); expect(dayRate(10, 2)).toBe(5); expect(dayRate(20, 0)).toBeNull();
  expect(planMedian([1, 9, 3, 5])).toBe(4); expect(planMedian([])).toBeNull();
  expect(nearestRate([{ day: "2026-10-18", rate: 2 }, { day: "2026-10-20", rate: 4 }], "2026-10-19")).toBe(2);
  expect(nearestRate([{ day: "2026-10-20", rate: 4 }], "2026-10-19")).toBe(4);
});
test("hourly calibration uses the seven-day span, borrows only within a plan, and freezes prior days across reopen", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"limit-rates-")), file=path.join(root,"records.sqlite");
  let store=ActivityStore.open(file);
  const now=Date.parse("2026-10-18T12:00:00Z"), today=Date.parse("2026-10-18"), first=today-6*DAY;
  try {
    const put=store.db.query(`INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)`);
    for (const [account,hour] of [["claude:a",first/HOUR],["claude:a",(first-DAY)/HOUR],["claude:a",today/HOUR],["claude:b",today/HOUR],["claude:c",today/HOUR]] as const) {
      put.run(hour,`${account}-${hour}`,"claude-sonnet-5","standard",account,"claude");
    }
    const obs=(plan:string)=>({session:null,weekly:null,plan,capturedAt:null});
    const observations=new Map([["claude:a",obs("max")],["claude:b",obs("max")],["claude:c",obs("pro")]]);
    let series={"claude|a|weekly":[{t:(first-DAY)/1000,remaining:90},{t:first/1000,remaining:90},{t:(first+300000)/1000,remaining:70},{t:today/1000,remaining:50},{t:(now-60_000)/1000,remaining:50}]};
    const run=()=>refreshLimitRates(store.db,now,{history:()=>({series}),observations},async work=>{store.transaction(work);});
    await run();
    const rows=()=>store.db.query<{account:string;rate:number|null;source:string;frozen:number},[string]>("SELECT account,rate,source,frozen FROM usage_limit_rates WHERE window='weekly' AND day=? ORDER BY account").all("2026-10-18");
    expect(rows()).toEqual([{account:"claude:a",rate:10,source:"own",frozen:0},{account:"claude:b",rate:10,source:"plan",frozen:0},{account:"claude:c",rate:null,source:"none",frozen:0}]);
    const frozen=store.db.query("SELECT * FROM usage_limit_rates WHERE day='2026-10-17'").all();
    store.close();store=ActivityStore.open(file);series={"claude|a|weekly":[{t:first/1000,remaining:90},{t:today/1000,remaining:5}]};
    await run(); expect(store.db.query("SELECT * FROM usage_limit_rates WHERE day='2026-10-17'").all()).toEqual(frozen);
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("incomplete token coverage keeps yesterday provisional until the full denominator arrives", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"limit-rates-coverage-")),store=ActivityStore.open(path.join(root,"records.sqlite"));
  const now=Date.parse("2026-10-18T12:00:00Z"), yesterday=Date.parse("2026-10-17T00:00:00Z");
  const put=store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)");
  const add=(label:string,at:number)=>put.run(Math.floor(at/HOUR),label,"claude-sonnet-5","standard","claude:a","claude");
  const observations=new Map([["claude:a",{session:null,weekly:null,plan:"max",capturedAt:null}]]);
  const history=()=>({series:{"claude|a|weekly":[{t:(yesterday-6*DAY)/1000,remaining:100},{t:(yesterday+3600000)/1000,remaining:100},{t:(yesterday+7200000)/1000,remaining:80},{t:(now-60_000)/1000,remaining:80}]}});
  const run=(coverageComplete:boolean)=>refreshLimitRates(store.db,now,{history,observations,coverageComplete},async work=>{store.transaction(work);});
  try {
    add("first",yesterday+3600000);
    await run(false);
    const row=()=>store.db.query<{rate:number;frozen:number;weight:number},[]>("SELECT rate,frozen,weight FROM usage_limit_rates WHERE account='claude:a' AND window='weekly' AND day='2026-10-17'").get()!;
    expect(row().frozen).toBe(0);
    const partialRate=row().rate,partialWeight=row().weight;
    add("deferred",yesterday+3*3600000);
    const changed=await run(true);
    expect(row().weight).toBeCloseTo(2*partialWeight);
    expect(row().rate).toBeCloseTo(partialRate/2);
    expect(row().frozen).toBe(1);
    expect(changed).toContainEqual({account:"claude:a",day:"2026-10-17"});
    expect(store.db.query("SELECT account,day FROM limit_spend_rate_changes").all()).toContainEqual({account:"claude:a",day:"2026-10-17"});
    store.db.query("UPDATE usage_limit_rates SET rate=?,frozen=1 WHERE account='claude:a' AND window='weekly' AND day='2026-10-17'").run(partialRate);
    const repaired=await refreshLimitRates(store.db,now,{history,observations,coverageComplete:true,revalidateFrozen:true},async work=>{store.transaction(work);});
    expect(row().rate).toBeCloseTo(partialRate/2);
    expect(repaired).toContainEqual({account:"claude:a",day:"2026-10-17"});
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("truncated limit history cannot freeze an own rate against a full seven-day token denominator", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"limit-rates-truncated-")),store=ActivityStore.open(path.join(root,"records.sqlite"));
  const now=Date.parse("2026-10-18T12:00:00Z"), first=Date.parse("2026-10-10T12:00:00Z");
  try {
    const put=store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)");
    for(let day=0;day<15;day++)put.run(Math.floor((first+day*DAY)/HOUR),`day-${day}`,"claude-sonnet-5","standard","claude:a","claude");
    const series: Record<string,{t:number;remaining:number}[]>={"claude|a|weekly":[{t:first/1000,remaining:100},{t:(first+5*60_000)/1000,remaining:90}]};
    for(let day=1;day<=8;day++)series["claude|a|weekly"]!.push({t:(first+day*DAY)/1000,remaining:90-day*10});
    const observations=new Map([["claude:a",{session:null,weekly:null,plan:null,capturedAt:null}]]);
    await refreshLimitRates(store.db,now,{history:()=>({series}),observations,coverageComplete:true},async work=>{store.transaction(work);});
    const truncated=store.db.query<{rate:number|null;source:string;frozen:number},[]>("SELECT rate,source,frozen FROM usage_limit_rates WHERE account='claude:a' AND window='weekly' AND day='2026-10-10'").get()!;
    expect(truncated).toEqual({rate:null,source:"none",frozen:0});
    const supported=store.db.query<{rate:number|null;source:string},[]>("SELECT rate,source FROM usage_limit_rates WHERE account='claude:a' AND window='weekly' AND day='2026-10-17'").get()!;
    expect(supported.source).toBe("own"); expect(supported.rate).toBeCloseTo(5);
    store.db.query("UPDATE usage_limit_rates SET rate=0.714,frozen=1,source='own' WHERE account='claude:a' AND window='weekly' AND day='2026-10-10'").run();
    const repaired=await refreshLimitRates(store.db,now,{history:()=>({series}),observations,coverageComplete:true,revalidateFrozen:true},async work=>{store.transaction(work);});
    expect(store.db.query<{rate:number|null;frozen:number},[]>("SELECT rate,frozen FROM usage_limit_rates WHERE account='claude:a' AND window='weekly' AND day='2026-10-10'").get())
      .toEqual({rate:null,frozen:0});
    expect(repaired).toContainEqual({account:"claude:a",day:"2026-10-10"});
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("a provisional measured rate and its plan tier survive the loss of its sample window", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "limit-rates-retention-"));
  const file = path.join(root, "records.sqlite");
  let store = ActivityStore.open(file);
  const date = "2026-11-19", start = Date.parse(date), now = start + 12 * HOUR;
  const first = start - 6 * DAY;
  const account = "claude:a";
  const plan = { plan: "max", planTier: "default_claude_max_20x", session: null, weekly: null, capturedAt: null };
  const reading = (at: number, remaining: number) => ({ t: at / 1000, remaining });
  let series = { "claude|a|weekly": [reading(first, 100), reading(start + HOUR, 80), reading(now, 80)] };
  const run = (at: number, observation: typeof plan | null) => refreshLimitRates(store.db, at,
    { history: () => ({ series }), observations: new Map(observation ? [[account, observation]] : []), coverageComplete: false },
    async work => { store.transaction(work); });
  const row = () => store.db.query("SELECT * FROM usage_limit_rates WHERE account=? AND day=? AND window='weekly'").get(account, date);
  try {
    store.db.query("INSERT INTO usage_hours VALUES('',?,?,?,?,?,?,NULL,'builder','operator',NULL,NULL,1,1000000,0,0,0,0,0)")
      .run(start / HOUR, "fixture", "claude-sonnet-5-5", "standard", account, "claude");
    await run(now, plan);
    const saved = row();
    expect(saved).toMatchObject({ rate: 10, plan: "max", plan_tier: "default_claude_max_20x", frozen: 0 });
    store.close();
    store = ActivityStore.open(file);
    series = { "claude|a|weekly": [reading(first + DAY, 100), reading(now, 80), reading(now + 3 * DAY, 70)] };
    expect(await run(now + 3 * DAY, null)).not.toContainEqual({ account, day: date });
    expect(row()).toEqual(saved);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
