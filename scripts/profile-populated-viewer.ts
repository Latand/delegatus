/** Production React Viewer profile over an invented populated board.
 * Usage: bun scripts/profile-populated-viewer.ts <source-root> <output-dir>
 * Bundles the real Viewer; all API/stream traffic terminates in the fixture.
 * This measures client work, separately from production HTTP/server latency.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const sameAnswer = process.argv[4] === "same-answer" || process.argv[4] === "cpu";
const cpuProfile = process.argv[4] === "cpu";
const repo = path.resolve(process.argv[2] ?? ".");
const out = path.resolve(process.argv[3] ?? ".artifacts/performance/browser");
fs.mkdirSync(out, { recursive: true });
let fixture = fs.readFileSync(path.join(repo, "src/components/kanban/issue1695Evidence.fixture.tsx"), "utf8");
fixture = fixture.replace('const PIPELINES = SCENARIO === "pipelines" || STAGES;', 'const PIPELINES = true;');
fixture = fixture.replace('let revision = 1;', `
for (let i = 0; i < 317; i++) {
  const builder = add(conversation('history-builder-' + i, 'Historical work ' + i));
  const reviewers = [0, 1].map(j => add(conversation('history-review-' + i + '-' + j, 'Historical review ' + i)));
  const flow = reviewFlow('history-flow-' + i, builder, reviewers[1], ['REQUEST_CHANGES', 'REQUEST_CHANGES', 'REQUEST_CHANGES', 'APPROVE'], 100000);
  flow.state = 'closed';
  for (const [j, file] of reviewers.entries()) file.durableLineage = {
    kind: 'review', role: 'reviewer', parentConversationId: builder.conversationId,
    memberships: flow.rounds.map(round => ({ kind: 'flow', containerId: flow.id, role: 'reviewer', round: round.n, slot: 'reviewer:' + round.n + ':binding-' + j, stageId: null, stageOrder: null, parentConversationId: builder.conversationId })),
  };
  flows.push(flow);
}
exportExplore.fmt = "codex"; exportExplore.root = "codex-sessions";
let revision = 1;`);
fixture = fixture.replace('if (EDITING) {\n  const at', `
for (let i = 0; i < 1188; i++) tasks.push(task('history-task-' + i, 'done', 'Historical task ' + i, 'Synthetic acceptance notes. '.repeat(22), 100000, i < 65 ? [files.find(f => f.name === 'history-builder-' + i + '.jsonl')] : [], i < 65 ? {} : { board: 'hidden' }));
if (EDITING) {\n  const at`);
fixture = fixture.replace('const file = files.find((entry) => entry.path === pathname);\n  if (!file', `const file = files.find((entry) => entry.path === pathname);
  if (file && ['export-impl.jsonl', 'export-explore.jsonl'].includes(file.name)) {
    const codex = file.name === 'export-explore.jsonl';
    const rows = [];
    for (let n = 0; n < 1000; n++) rows.push(codex
      ? JSON.stringify({type:'response_item', timestamp:iso(60), payload:{type:'message',role:n%2?'assistant':'user',content:[{type:n%2?'output_text':'input_text',text:'Synthetic history ' + n + ' ' + 'detail '.repeat(100)}]}})
      : said(60, 'Synthetic history ' + n + ' ' + 'detail '.repeat(100)));
    return rows.join('\\n') + '\\n';
  }
  if (!file`);
if (!sameAnswer) fixture = fixture.replace('timestamp:iso(60), payload:{type:', 'timestamp:iso(1060-n), payload:{type:')
  .replace("said(60, 'Synthetic history '", "said(1060-n, 'Synthetic history '");
if (!sameAnswer) {
  fixture = fixture.replace('function transcriptOf(pathname: string): string {', 'let profileRevision = 0;\nfunction transcriptOf(pathname: string): string {');
  fixture = fixture.replace("    return rows.join('\\n') + '\\n';", `
    for (let n = 0; n < 60; n++) {
      if (codex) rows.push(
        JSON.stringify({type:'response_item',timestamp:iso(59-n/10),payload:{type:'function_call',call_id:'call-'+n,name:'exec_command',arguments:JSON.stringify({cmd:'synthetic command'})}}),
        JSON.stringify({type:'response_item',timestamp:iso(59-n/10),payload:{type:'function_call_output',call_id:'call-'+n,output:'Synthetic tool result'}}));
      else rows.push(...tool(59-n/10, 'call-'+n, 'Read', {file_path:'src/example.ts'}));
    }
    if (profileRevision) rows.push(codex
      ? JSON.stringify({type:'response_item',timestamp:iso(0),payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Streamed update '+profileRevision}]}})
      : said(0, 'Streamed update '+profileRevision));
    return rows.join('\\n') + '\\n';`);
}
// Record API wait/serialization and JSON parsing separately. All responses
// are generated locally; these are not measurements of a deployed server.
fixture = fixture.replace('localStorage.setItem("llvProject", PROJECT);', `
const profileFetch = window.fetch;
window.fetch = async (input, init) => {
  const start = performance.now();
  const response = await profileFetch(input, init);
  const route = new URL(String(input), location.origin).pathname;
  response.headers.set('x-profile-route', route);
  window.metrics.api.push({route, phase:'wait', ms:performance.now()-start});
  return response;
};
const profileJson = Response.prototype.json;
Response.prototype.json = async function() {
  const start = performance.now();
  const result = await profileJson.call(this);
  window.metrics.api.push({route:this.headers.get('x-profile-route'), phase:'parse', ms:performance.now()-start});
  return result;
};
localStorage.setItem("llvProject", PROJECT);`);
// Expose only invented identities and local update traffic to the driver.
fixture = fixture.replace('Object.assign(window, { evidence });', `Object.assign(window, { evidence, profileCorpus: { files: files.length, flows: flows.length, tasks: tasks.length }, profileUpdate: () => { ${sameAnswer ? '' : 'profileRevision++;'} files[0] = {...files[0], size: files[0].size + 1}; window.dispatchEvent(new Event('llv:files-changed')); } });`);
const fixturePath = path.join(out, "fixture.tsx");
fs.writeFileSync(fixturePath, fixture);
const build = Bun.spawnSync([process.execPath, "build", fixturePath, "--target=browser", `--outdir=${out}/bundle`, ...(cpuProfile ? ["--sourcemap=external"] : ["--minify"]), "--define", 'process.env.NODE_ENV="production"', "--define", 'process.env={}', `--tsconfig-override=${repo}/tsconfig.json`], {cwd:repo,stdout:"pipe",stderr:"pipe"});
if (build.exitCode) throw new Error(build.stderr.toString());
const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(repo,"src/app/globals.css"),"utf8"), {from:path.join(repo,"src/app/globals.css")});
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
  const p = new URL(req.url).pathname;
  if (p === '/app.js') return new Response(Bun.file(path.join(out,'bundle/fixture.js')), {headers:{'content-type':'text/javascript'}});
  if (p === '/style.css') return new Response(css.css, {headers:{'content-type':'text/css'}});
  return new Response('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>', {headers:{'content-type':'text/html'}});
}});
const browser = await chromium.launch({executablePath:process.env.LLV_PROFILE_CHROME ?? '/usr/bin/google-chrome-stable',headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage({viewport:{width:1600,height:1000}});
 const errors:string[] = [];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(() => {
   const w = window as any; w.metrics={longTasks:[],inputs:[],opens:[],api:[]};
   new PerformanceObserver(list => { for(const e of list.getEntries()) w.metrics.longTasks.push({at:e.startTime,ms:e.duration}); }).observe({type:'longtask',buffered:true});
   document.addEventListener('keydown',e=> { const at=performance.now();requestAnimationFrame(()=>w.metrics.inputs.push({queueMs:at-e.timeStamp,paintMs:performance.now()-e.timeStamp}));},true);
 });
 await page.goto(`http://127.0.0.1:${server.port}/?scenario=pipelines`);
 await page.waitForSelector('[data-kanban-board]');
 await page.waitForTimeout(1000);
 // Current Kanban mounts working readers on entry. Close them before the
 // interaction sample; startup remains in the long-task trace separately.
 for (const id of ['export-impl','export-explore','auth-impl']) {
   const close = page.locator(`[data-reader-close="conversation_${id}"]`);
   if (await close.count()) await close.first().click();
 }
 await page.waitForTimeout(200);
 const cdp = cpuProfile ? await page.context().newCDPSession(page) : null;
 if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
 for (const id of (cpuProfile ? ['export-impl','export-impl'] : ['export-impl','export-explore','auth-impl','export-impl','export-explore'])) {
   console.log('Opening', id);
   // The ordinary card's conversation entry is the click target.
   const selector = `[data-kanban-board] [data-member="/repo/${id}.jsonl"]`;
   const candidates = await page.locator(`[data-kanban-board]`).evaluate(el=>Array.from(el.querySelectorAll('[data-conversation],button')).map(e=>e.outerHTML.slice(0,250)));
   if (!(await page.locator(selector).count())) {
     fs.writeFileSync(path.join(out,'selectors.json'),JSON.stringify(candidates));
     throw new Error('conversation click target unavailable: '+id);
   }
   await page.evaluate(id => {
     const w = window as any;
     w.lastOpen = null;
     document.addEventListener('click', () => {
       const start=performance.now();let frames=0;
       const observe=()=>{
         frames++;
         const reader=document.querySelector(`[data-kanban-reader="conversation_${id}"]`);
         const field=reader?.querySelector('textarea');
         const readable=reader?.querySelector('[data-feed-key]');
         if(readable && readable.getBoundingClientRect().width>0) w.lastOpen={clickToReadableMs:performance.now()-start,frames};
         else if(performance.now()-start<15000) requestAnimationFrame(observe);
       };requestAnimationFrame(observe);
     },{once:true,capture:true});
   }, id);
   const start = await page.evaluate(()=>performance.now());
   await page.locator(selector).first().click();
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(e=>e.getBoundingClientRect().width>0 && !e.disabled));
   const elapsed = await page.evaluate(start=>new Promise<number>(resolve=>requestAnimationFrame(()=>resolve(performance.now()-start))),start);
   await page.waitForFunction(()=>(window as any).lastOpen !== null);
   await page.evaluate(({id,elapsed})=>(window as any).metrics.opens.push({id,driverElapsedMs:elapsed,...(window as any).lastOpen}),{id,elapsed});
   const textarea=page.locator(`[data-reader-close="conversation_${id}"]`).locator('xpath=ancestor::*[contains(@class,"reader")][1]').locator('textarea').first();
   await textarea.focus();
   // Concurrent synthetic catalog updates include parsing, React and layout.
   await page.evaluate(()=>{(window as any).updateTimer=setInterval(()=>(window as any).profileUpdate(),250);});
   await page.keyboard.type('sample input latency measurement', {delay:15});
   await page.evaluate(()=>clearInterval((window as any).updateTimer));
   const close=page.locator(`[data-reader-close="conversation_${id}"]`);
   if (await close.count()) await close.first().click();
 }
 if (cdp) fs.writeFileSync(path.join(out,'cpu.json'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
 const result=await page.evaluate(()=>({corpus:(window as any).profileCorpus,metrics:(window as any).metrics,domNodes:document.querySelectorAll('*').length}));
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({...result,errors},null,2));
 console.log(JSON.stringify({...result,errors}));
} finally {await browser.close();server.stop(true);}
