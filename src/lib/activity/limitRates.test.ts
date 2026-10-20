import { expect, test } from "bun:test";
import { risesFromSamples, limitWeight, dayRate, planMedian, nearestRate } from "./limitRates";
import { emptyTokens } from "./tokenUsage";
import { tokenCost } from "./tokenPrices";
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
test("Codex ultrafast weight uses fast pricing and unpriced tokens remain unknown", () => {
  const counts = { ...emptyTokens(), input: 1000, output: 300 };
  expect(limitWeight("gpt-6.1-sol", "ultrafast", "codex", counts)).toBe(tokenCost("gpt-6.1-sol", "fast", counts));
  expect(limitWeight("unpriced", "standard", "claude", counts)).toBeNull();
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
    let series={"claude|a|weekly":[{t:first/1000,remaining:90},{t:(first+300000)/1000,remaining:70},{t:today/1000,remaining:50}]};
    const run=()=>refreshLimitRates(store.db,now,{history:()=>({series}),observations},async work=>{store.transaction(work);});
    await run();
    const rows=()=>store.db.query<{account:string;rate:number|null;source:string;frozen:number},[string]>("SELECT account,rate,source,frozen FROM usage_limit_rates WHERE window='weekly' AND day=? ORDER BY account").all("2026-10-18");
    expect(rows()).toEqual([{account:"claude:a",rate:10,source:"own",frozen:0},{account:"claude:b",rate:10,source:"plan",frozen:0},{account:"claude:c",rate:null,source:"none",frozen:0}]);
    const frozen=store.db.query("SELECT * FROM usage_limit_rates WHERE day='2026-10-17'").all();
    store.close();store=ActivityStore.open(file);series={"claude|a|weekly":[{t:first/1000,remaining:90},{t:today/1000,remaining:5}]};
    await run(); expect(store.db.query("SELECT * FROM usage_limit_rates WHERE day='2026-10-17'").all()).toEqual(frozen);
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});
