# Typing latency: the measurement procedure

Retained beside `campaigns.json` so that a later run can repeat the numbers on the same terms. The
procedure is the one of the diagnosis that named the cause (keystroke input-to-paint with Event
Timing, headless Chromium, 60 ms per character); the scripts below are the ones that produced the
runs in `campaigns.json`, with absolute paths written as `$HOME`. They are kept as text, not as a
driver in the tree.

## Setup

1. **Builds.** Base is the release the diagnosis measured (`c62bc941`, built and kept by the
   self-update). Head is a production build (`bun run build`) of the head commit from a `git archive`
   export, under an isolated HOME, XDG_CONFIG_HOME, TMPDIR and state directory with the control URL on
   a closed port, run through `scripts/gate-slot.sh`. The release for each side is copied to a scratch
   directory (without `node_modules`, linked back) and served with `next start` by
   `start-viewer.sh`.
2. **Fixtures.** One sandbox per side, each holding the same two seat transcripts under
   `.claude/projects/<encoded cwd>/`: the previous seat transcript unchanged (13,769,543 bytes) and the
   first 7,962,203 bytes of the current one (the length it had when the diagnosis copied it). The
   fingerprints are in `campaigns.json` under `fixtures`. The conversation id of each copy comes from
   the sandbox's own `/api/files`. The Viewers run until their startup scan has settled (about 0.25 CPU
   seconds per ten) before the first run.
3. **Seat runs** (`measure.mjs`): open `#c=<conversation id>`, wait for the composer, wait 8 s, dismiss
   the telemetry notice, click the field, type the first 60 characters of a fixed phrase at 60 ms per
   character, read the Event Timing entries of at least 16 ms. `seat-current` has its attention ring
   active in the transcript's state; `reduced` runs the same page with `prefers-reduced-motion: reduce`.
4. **Board runs** (`board-measure.ts`, from inside the scratch copy so it uses that copy's kanban
   harness): the fixture `?scenario=seat-head&many=1`, 53 characters at 60 ms. `INJECT_RING` adds the
   pane ring to the seat's wrapper the way that side's `BranchPane` draws it, `INJECT_BREATHE=8` gives
   eight cards `.card-status-attention`.
5. **Campaign** (`campaign.sh`): for each repetition, both sides in swapping order, each running the
   three seat runs and the three board runs; the machine's one-minute load is read before each run.

## Reading the numbers

Event Timing reports in 8 ms steps and leaves out events under 16 ms. The diagnosis's p50 and p90 are
over the reported events only, so a run where most keys were fast shows the few slow ones. `reported`
says how many keys were over the floor, and `allKeysP50` counts every key once, an unreported key as
8 ms. The limits are p50 of 20 ms and p90 of 32 ms.

## start-viewer.sh

```bash
#!/bin/bash
# usage: start-viewer.sh <app-dir> <sandbox-dir> <port-file>
set -u
app="$1"; sb="$2"; portfile="$3"
port=$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()')
echo "$port" > "$portfile"
cd "$app"
exec env -i \
  PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_RUNTIME_UI=1 \
  HOME="$sb" XDG_CONFIG_HOME="$sb/config" TMPDIR="$sb" \
  LLV_STATE_DIR="$sb/state" LLV_STATE_OWNER=viewer \
  LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1" \
  LLV_CLAUDE_HOME="$sb/.claude" LLV_CODEX_HOME="$sb/.codex" \
  LLV_LANG=uk LLV_REAPER_ENABLED=0 \
  "$HOME/.bun/bin/bun" --bun node_modules/.bin/next start --hostname 127.0.0.1 --port "$port"
```

## measure.mjs

```js
// Keystroke-to-paint measurement against an isolated Viewer (diagnosis procedure, d1d531e0).
// usage: bun measure.mjs <baseUrl> <hash> <label> [chars]
// env: MEASURE_OUT (dir for raw events), REDUCED_MOTION=1, CHROME_BIN, PW_REQUIRE_ROOT
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(process.env.PW_REQUIRE_ROOT);
const { chromium } = require("playwright-core");
const [base, hash, label, charsArg] = process.argv.slice(2);
const chars = Number(charsArg ?? 60);
const out = process.env.MEASURE_OUT;
const exe = process.env.CHROME_BIN;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "uk" });
const page = await ctx.newPage();
if (process.env.REDUCED_MOTION) await page.emulateMedia({ reducedMotion: "reduce" });
const cdp = await ctx.newCDPSession(page);
await page.addInitScript(() => {
  window.__ev = []; window.__lt = [];
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__ev.push({ name: e.name, start: e.startTime, dur: e.duration, pt: e.processingStart - e.startTime, pe: e.processingEnd - e.processingStart, target: e.target && e.target.tagName }); }).observe({ type: "event", durationThreshold: 16, buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration }); }).observe({ type: "longtask", buffered: true });
});
await page.goto(base + "/" + hash, { waitUntil: "domcontentloaded" });
const ta = page.locator('textarea[aria-label="Текст для агента"]').first();
await ta.waitFor({ state: "visible", timeout: 120000 });
await page.waitForTimeout(8000); // let feed settle / ramp
const ack = page.getByText("Зрозуміло", { exact: true }); if (await ack.count()) { await ack.first().click(); await page.waitForTimeout(500); }
if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
await ta.click();
const anims = await page.evaluate(() => document.getAnimations().map(a => a.animationName + "@" + (a.effect?.target?.tagName || "?")));
const ringEls = await page.evaluate(() => [...document.querySelectorAll(".pane-attention,.pane-attention-ring")].map(e => e.className));
await page.waitForTimeout(500);
await page.evaluate(() => { window.__ev.length = 0; window.__lt.length = 0; });
const text = "Операторе, перевір будь ласка стан лейнів і доповідай ".repeat(4).slice(0, chars);
const typeStart = Date.now();
await page.keyboard.type(text, { delay: 60 });
const typeMs = Date.now() - typeStart;
await page.waitForTimeout(500);
const ev = await page.evaluate(() => ({ ev: window.__ev, lt: window.__lt }));
const keyEv = ev.ev.filter(e => ["keydown", "keypress", "input", "keyup"].includes(e.name));
const durs = keyEv.map(e => e.dur).sort((a, b) => a - b);
const p = q => durs.length ? durs[Math.min(durs.length - 1, Math.floor(q * durs.length))] : 0;
const res = { label, chars, typeMs, reported: durs.length, p50: p(0.5), p90: p(0.9), max: p(1),
  longtasks: ev.lt.length, longtaskMaxMs: Math.round(Math.max(0, ...ev.lt.map(l => l.dur))), animations: anims, ringEls };
console.log("RESULT " + JSON.stringify(res));
if (out) fs.writeFileSync(path.join(out, `${label}.events.json`), JSON.stringify({ res, ev }));
await browser.close();
```

## board-measure.ts

```ts
// Seat-over-board fixture (kanban harness, ?scenario=seat-head&many=1): typing into the seat composer (diagnosis procedure, d1d531e0).
// env: SCENARIOS, MOTIONS, INJECT_BREATHE=<n>, INJECT_RING=legacy|compositor, MEASURE_OUT, CHROME_BIN
import { createRequire } from "node:module";
import fs from "node:fs";
import { serveEvidenceFixture } from "./src/components/kanban/issue1695BrowserHarness";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const out = process.env.MEASURE_OUT!;
const label = process.env.LABEL || "board";
const { base, stop } = await serveEvidenceFixture(out);
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
for (const scenario of (process.env.SCENARIOS || "seat-head").split(",")) for (const motion of (process.env.MOTIONS || "no-preference").split(",") as ("no-preference" | "reduce")[]) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "light", reducedMotion: motion });
  await ctx.addInitScript(`try { localStorage.setItem("llv_lang", "uk"); } catch {}`);
  const page = await ctx.newPage();
  await page.addInitScript(() => { (window as any).__ev = []; new PerformanceObserver(l => { for (const e of l.getEntries() as any[]) if (e.name === "input") (window as any).__ev.push(e.duration); }).observe({ type: "event", durationThreshold: 16, buffered: true } as any); });
  const url = `${base}?scenario=${scenario}&many=1`;
  await page.goto(url); await page.waitForTimeout(6000);
  if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
  const inject = Number(process.env.INJECT_BREATHE || 0);
  let injected = "";
  if (inject) injected += "breathing cards:" + await page.evaluate((n) => { const cards = [...document.querySelectorAll("[data-kanban-card],[data-card-id],article")].slice(0, n); for (const c of cards) (c as HTMLElement).classList.add("card-status-attention"); return cards.length; }, inject);
  const ring = process.env.INJECT_RING;
  if (ring) injected += " seat ring(" + ring + "):" + await page.evaluate((style) => {
    const el = document.querySelector("[data-orchestrator-conversation]")?.parentElement as HTMLElement | null; if (!el) return 0;
    el.classList.add("relative"); el.style.setProperty("--pane-glow", "var(--color-warning)");
    if (style === "legacy") el.classList.add("pane-attention");
    else el.insertAdjacentHTML("afterbegin", '<span aria-hidden class="pane-attention-ring"><span class="pane-attention-comets"></span></span>');
    return 1;
  }, ring);
  if (process.env.LIST_ANIMS) console.log('ANIMS', JSON.stringify(await page.evaluate(() => document.getAnimations().map((a: any) => a.animationName + ' ' + (a.effect?.target?.outerHTML || '').slice(0, 220) + ' | parent:' + (a.effect?.target?.parentElement?.className || '').toString().slice(0, 80)))));
  const info = await page.evaluate(() => ({ anims: Object.entries(document.getAnimations().reduce((m: any, a: any) => { const k = (a.animationName || "?") + "@" + (a.effect?.target?.tagName || (a.effect?.pseudoElement ? "::before" : "?")); m[k] = (m[k] || 0) + 1; return m; }, {})), nodes: document.getElementsByTagName("*").length }));
  const ta = page.locator('textarea[aria-label="Текст для агента"]').first();
  let res: any = { label, scenario, motion, injected, nodes: info.nodes, animations: info.anims };
  if (await ta.count() && await ta.isVisible()) {
    await ta.click(); await page.waitForTimeout(500);
    if (process.env.PAUSE_ANIMS) { const names = process.env.PAUSE_ANIMS.split(","); res.paused = await page.evaluate((n) => { let c = 0; for (const a of document.getAnimations() as any[]) if (n.includes(a.animationName)) { a.pause(); c++; } return c; }, names); await page.waitForTimeout(300); } await page.evaluate(() => { (window as any).__ev.length = 0; });
    await page.keyboard.type("Перевір стан лейнів і доповідай, будь ласка, зараз же ", { delay: 60 });
    await page.waitForTimeout(500);
    const d: number[] = (await page.evaluate(() => (window as any).__ev)).sort((a: number, b: number) => a - b);
    res = { ...res, chars: 53, reported: d.length, p50: d[Math.floor(d.length / 2)] ?? 0, p90: d[Math.floor(d.length * .9)] ?? 0, max: d[d.length - 1] ?? 0, durs: d };
  } else res.error = "no visible seat composer textarea";
  console.log("RESULT " + JSON.stringify(res));
  await ctx.close();
}
await browser.close(); stop(); process.exit(0);
```

## campaign.sh

```bash
#!/bin/bash
# usage: campaign.sh <reps> <results.jsonl>
# base = diagnosis release c62bc941 (composer/ring files identical to the branch base); head = production build of the final head.
set -u
reps="$1"; res="$2"
CT=$(cat chrome-tmp.path)
export CHROME_BIN=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
export PW_REQUIRE_ROOT=$HOME/.cache/delegatus/self-update/bb38046574072bf9/releases/c62bc941aefd/node_modules/
mkdir -p raw
PIN="${PIN_CPUS:+taskset -c $PIN_CPUS}"
cid() { # variant, uuid prefix
  curl -s --max-time 60 "http://127.0.0.1:$(cat $1.port)/api/files" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); [print(f["conversationId"]) for f in d["files"] if "'$2'" in f["path"]]'
}
rec() { # variant scenario rep fixture; reads RESULT line on stdin
  local load; load=$(cut -d' ' -f1 /proc/loadavg)
  grep '^RESULT ' | sed 's/^RESULT //' | python3 -I -c '
import json,sys
v,s,r,f,l=sys.argv[1:6]
for line in sys.stdin:
    d=json.loads(line); d.update(variant=v,scenario=s,rep=int(r),fixture=f,load1=float(l)); print(json.dumps(d))
' "$1" "$2" "$3" "$4" "$load" >> "$res"
}
for rep in $(seq 1 "$reps"); do
  if [ $((rep % 2)) = 1 ]; then order="base head"; else order="head base"; fi
  for v in $order; do
    app=$TMPDIR/$( [ $v = base ] && echo base-app || echo head-app )
    port=$(cat $v.port)
    for fx in "75cdf38f seat-current" "9066f52e seat-long"; do
      set -- $fx; id=$(cid $v $1)
      env TMPDIR=$CT MEASURE_OUT=$TMPDIR/raw timeout 240 $PIN bun measure.mjs http://127.0.0.1:$port "#c=$id" "$v-$2-r$rep" 60 2>&1 | rec $v ring $rep "$2"
    done
    set -- 75cdf38f seat-current; id=$(cid $v $1)
    env TMPDIR=$CT MEASURE_OUT=$TMPDIR/raw REDUCED_MOTION=1 timeout 240 $PIN bun measure.mjs http://127.0.0.1:$port "#c=$id" "$v-reduced-r$rep" 60 2>&1 | rec $v reduced $rep seat-current
    ring=$( [ $v = base ] && echo legacy || echo compositor )
    for cfg in "baseline|" "ring|INJECT_RING=$ring" "breathe8|INJECT_BREATHE=8"; do
      name=${cfg%%|*}; envs=${cfg#*|}
      (cd $app && env $envs LABEL=$v-board-$name-r$rep HOME=$TMPDIR/sb-$v XDG_CONFIG_HOME=$TMPDIR/sb-$v/config TMPDIR=$CT LLV_STATE_DIR=$TMPDIR/sb-$v/state2 LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 MEASURE_OUT=$TMPDIR/raw SCENARIOS=seat-head timeout 400 $PIN bun board-measure.ts 2>&1) | rec $v board-$name $rep seat-over-board
    done
  done
done
```
