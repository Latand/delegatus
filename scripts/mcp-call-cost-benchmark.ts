import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- generated fixture records cross many domain unions. */
const runSide = process.argv.includes('--run-side');
const OPTIONAL_READ_KEY_TOOLS = new Set([
 'message_receipt', 'list_conversations', 'search_transcripts', 'get_conversation',
 'conversation_deliverability', 'conversation_messages', 'get_pipeline', 'board_snapshot',
 'list_flows', 'get_flow', 'list_pipelines', 'list_tasks', 'get_task',
 'deployment_status', 'resources', 'get_orchestrator', 'account_limits',
]);

async function runPair() {
 const base = process.argv[process.argv.indexOf('--base') + 1];
 if (!base || base.startsWith('--')) throw new Error('Usage: bun run scripts/mcp-call-cost-benchmark.ts --base <exact-commit>');
 const proc = Bun.spawnSync(['git', 'rev-parse', '--verify', `${base}^{commit}`], { stdout: 'pipe', stderr: 'pipe' });
 if (proc.exitCode !== 0) throw new Error(`Base is not an available commit: ${base}`);
 const baseCommit = proc.stdout.toString().trim();
 const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
 const work = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'delegatus-mcp-cost-'));
 const script = fs.readFileSync(new URL(import.meta.url), 'utf8');
 const output: Record<string, unknown> = {};
 try {
  for (const [side, revision] of [['base', baseCommit], ['head', head]] as const) {
   const checkout = path.join(work, side);
   const outputDir = path.join(work, `${side}-output`);
   fs.mkdirSync(checkout);
   const archive = Bun.spawnSync(['git', 'archive', revision], { stdout: 'pipe', stderr: 'pipe' });
   if (archive.exitCode !== 0) throw new Error(`Could not archive ${side} ${revision}`);
   const archiveFile = path.join(work, `${side}.tar`);
   fs.writeFileSync(archiveFile, archive.stdout);
   const unpack = Bun.spawnSync(['tar', '-xf', archiveFile, '-C', checkout], { stdout: 'pipe', stderr: 'pipe' });
   if (unpack.exitCode !== 0) throw new Error(`Could not unpack ${side} source`);
   fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
   fs.writeFileSync(path.join(checkout, 'scripts/mcp-call-cost-benchmark.ts'), script);
   fs.symlinkSync(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'dir');
   const child = Bun.spawnSync(['bun', 'run', 'scripts/mcp-call-cost-benchmark.ts', '--run-side'], {
    cwd: checkout,
    env: { ...process.env, NODE_ENV: 'test', COST_CANDIDATE: side === 'head' ? '1' : '0', AUDIT_OUTPUT: outputDir, LLV_STATE_DIR: path.join(work, `${side}-state`), COST_REPO: process.cwd() },
    stdout: 'pipe', stderr: 'pipe',
   });
   if (child.exitCode !== 0) {
    const stderr = child.stderr.toString();
    const stdout = child.stdout.toString();
    const faults = fs.existsSync(path.join(outputDir, 'faults.json')) ? fs.readFileSync(path.join(outputDir, 'faults.json'), 'utf8') : 'fault summary unavailable';
    throw new Error(`${side} harness failed (exit ${child.exitCode}):\nFault rows: ${faults}\n${stderr.slice(-700)}\n${stdout.slice(-500)}`);
   }
   output[side] = {
    profile: JSON.parse(fs.readFileSync(path.join(outputDir, 'profile.json'), 'utf8')),
    faults: JSON.parse(fs.readFileSync(path.join(outputDir, 'faults.json'), 'utf8')),
   };
   process.stdout.write(`${side} ${revision}: ${child.stdout.toString().trim()}\n`);
  }
  const baseRows = (output.base as any).profile.grouped as any[];
  const headRows = (output.head as any).profile.grouped as any[];
  if (baseRows.reduce((sum, row) => sum + row.n, 0) !== 303 || headRows.reduce((sum, row) => sum + row.n, 0) !== 303) throw new Error('Expected 303 healthy MCP calls per side');
  if ([...baseRows, ...headRows].some(row => row.ok !== row.n)) throw new Error('A healthy fixture call failed');
  const headByKey = new Map(headRows.map(row => [row.key, row]));
  for (const row of baseRows) {
   const paired = headByKey.get(row.key);
   if (!paired || paired.n !== row.n || paired.inputKeys.join(',') !== row.inputKeys.join(',') || paired.inTokP50 !== row.inTokP50) throw new Error(`Healthy request shape or input token count differs between revisions for ${row.key}`);
  }
  const faultRows = [...(output.base as any).faults, ...(output.head as any).faults];
  if (faultRows.length !== 18 || faultRows.some(row => row.ok || row.attempts !== (row.side === 'base' ? 11 : 1))) throw new Error('Expected three failed-verdict fault scenarios, n=3 per side, with 11 to 1 HTTP attempts');
  process.stdout.write(JSON.stringify({ base: baseCommit, head, healthyCallsPerSide: 303, scenarios: baseRows.length, profiles: { base: baseRows, head: headRows }, faultRows }, null, 2) + '\n');
 } finally {
  fs.rmSync(work, { recursive: true, force: true });
 }
}

if (!runSide) {
 await runPair();
} else {
const root=process.env.AUDIT_OUTPUT!,runTag=String(Date.now()),candidate=process.env.COST_CANDIDATE==='1';
fs.mkdirSync(root,{recursive:true});
for(const key of Object.keys(process.env))if(key.startsWith('LLV_'))delete process.env[key];
for(const key of ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','LLV_STATE_DIR','CODEX_HOME','LLV_CODEX_HOME','CLAUDE_CONFIG_DIR','LLV_CLAUDE_HOME']){process.env[key]=path.join(root,'sandbox-'+runTag,key);fs.mkdirSync(process.env[key]!,{recursive:true});}
process.env.LLV_STATE_ACTIVATION='sqlite';
const serverMod=await import('@/lib/mcp/server');
const {viewerMcpBindings,productionDomainDependencies,productionViewerControlDependencies,viewerMcpToolPolicy}=await import('@/lib/mcp/bindings');
const {pipelineCorpus}=await import('@/lib/pipelines/fixtures/corpus');
const {savePipelines,findPipelineRecord,loadPipelines}=await import('@/lib/pipelines/store');
const {saveTasks}=await import('@/lib/tasks/store');
const {agentRegistry}=await import('@/lib/agent/registry');
const {defaultPipelinePorts,patchPipeline,reportStageCompletion}=await import('@/lib/pipelines/engine');
const {registerPipelineTick}=await import('@/lib/pipelines/controllerSignal');
const {indexTranscriptSources}=await import('@/lib/search/transcriptSearch');
const {GET:filesGET}=await import('@/app/api/files/route');
const {GET:conversationsGET}=await import('@/app/api/conversations/route');
const memoryRoutes=await import('@/app/api/search/memory/route');
const transcriptRoutes=await import('@/app/api/search/transcripts/route');
const {createAttentionRequest}=await import('@/lib/attention/store');
const {awaitAttentionArrival,answerAttentionRequest}=await import('@/lib/attention/service');
const restoreTick=registerPipelineTick(async()=>{});
const at='2026-10-02T00:00:00.000Z',sha='a'.repeat(40),project='audit-project';
const transcripts=path.join(process.env.LLV_CODEX_HOME!,'sessions','2026','10','02');fs.mkdirSync(transcripts,{recursive:true});
const transcript=path.join(transcripts,'audit.jsonl');
const rows=[{timestamp:at,type:'session_meta',payload:{id:'audit-session-0001',cwd:root}}];
for(let i=0;i<1000;i++)rows.push({timestamp:at,type:'response_item',payload:{type:'message',role:i%2?'assistant':'user',content:[{type:'output_text',text:'audit common index text '+i+' '+ 'sample '.repeat(150)}]}} as any);
fs.writeFileSync(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const {beginLegacySpawnFixture}=await import('@/lib/agent/registryTestFixtures');
const {runAsMcpHttpCaller}=await import('@/lib/mcp/callerContext');
const registry=agentRegistry();
const begun=beginLegacySpawnFixture(registry,{engine:'codex',cwd:root,role:'builder',origin:{kind:'operator'}});
if(begun.kind!=='created')throw new Error('fixture admission');
const settled=registry.settleSpawn(begun.receipt.launchId,{key:{engine:'codex',sessionId:'audit-session-0001'},artifactPath:transcript,cwd:root,accountId:null,status:'live',host:null,claimEpoch:0,claimOwner:null,pendingAction:null});
if(settled.kind!=='settled')throw new Error('fixture settlement');
const cid=settled.conversation.id,capability=registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
const sources=[{path:transcript,engine:'codex' as const,project,size:fs.statSync(transcript).size,mtimeMs:fs.statSync(transcript).mtimeMs}];
await indexTranscriptSources(sources);
const lanes=pipelineCorpus(27,6);for(const lane of lanes){lane.project=project;lane.taskIds=[];lane.repoDir=root;lane.worktreeDir=path.join(path.dirname(root),`${path.basename(root)}-pipeline-${lane.id}`);lane.publication='internal';}
const reportLane=lanes[1]!;reportLane.runs[0]!.attempts.at(-1)!.conversationId=cid;reportLane.runs[0]!.attempts.at(-1)!.state='running';
reportLane.runs[0]!.attempts.at(-1)!.agentPath=null;
const tasks=Array.from({length:107},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,project,status:i%4?'inbox':'done',text:`Audit task ${i}\n${'Outcome detail. '.repeat(30)}`,details:'Working context. '.repeat(100),placement:'unplaced',assignments:[],createdAt:at,updatedAt:at}));
saveTasks(tasks as any);
savePipelines(lanes);
let externalDelay=0;const execSamples:any[]=[];
const exec=(command:string,args:string[])=>{
 const started=performance.now();let stdout='';const code=0;
 const category=command==='timeout'&&args.includes('gh')?'forge':command==='timeout'?'git-remote':args[0]==='ls-remote'||args[0]==='fetch'?'git-remote':'git-local';
 if(externalDelay&&category!=='git-local')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,externalDelay);
 if(command==='timeout'&&args.includes('gh'))stdout='[]';
 else if(command==='timeout'&&args.includes('ls-remote'))stdout=sha+'\trefs/heads/'+reportLane.branch+'\n';
 else if(args[0]==='branch')stdout=reportLane.branch;
 else if(args[0]==='rev-parse')stdout=sha;
 else if(args[0]==='ls-remote')stdout=sha+'\trefs/heads/'+reportLane.branch+'\n';
 execSamples.push({category,ms:performance.now()-started});return {code,stdout,stderr:''};
};
const ports={...defaultPipelinePorts(),exec,spawnAgent:async()=>{throw new Error('Audit never launches agents')},paneAgentAlive:async()=>false,conversationAgentActive:async()=>false,stageHostResident:async()=>false,stopStageAgent:async()=>({outcome:'not-running'}),stopStagePane:async()=>({outcome:'not-running'}),closeFlow:async()=>({}),durableTurnEvidence:async()=>null,conversationRegistered:()=>true};
const sessionRows=Array.from({length:24},(_,i)=>({target:'fixture-'+i,panePid:i+1,path:null,engine:'codex',title:'Fixture worker '+i,project,activity:'live',lastActiveAt:at,cwd:null,rssBytes:1024*(i+1),swapBytes:0,procCount:2}));
const activityFiles=Array.from({length:10},(_,i)=>({path:path.join(root,'generated-'+i+'.jsonl'),conversationId:'conversation_fixture_'+i,project,engine:'codex',title:'Fixture worker '+i,kind:'session',root:'codex',name:'worker-'+i,fmt:'jsonl',parent:null,mtime:Date.parse(at)/1000,size:1024,activity:'idle',proc:null,pid:null}));
const domain={...productionDomainDependencies,
 readResourcesWithDiagnostic:undefined,readResources:async()=>({system:null,sessions:sessionRows,sessionsCapturedAt:at,sessionsStale:false,viewer:null,viewerUnavailable:'not-the-viewer'}),
 refreshLifecycleJournal:()=>({appended:0}),
 livenessSources:()=>({now:()=>Date.parse(at),probe:{now:()=>Date.parse(at),pidAlive:()=>false,processIdentity:()=>null},registrySnapshot:()=>({entries:{},conversations:{}}),pipelines:()=>[],listFiles:async()=>activityFiles,describeTranscript:async()=>null,transcriptEvidence:async()=>({turn:'idle',lastRecordTs:Date.parse(at),providerProgressAt:null})}),attentionAuthority:()=>({kind:'root',conversationId:cid}),callerAttribution:()=>({kind:'agent',conversationId:cid,role:'reviewer'}),patchPipeline:(id:any,req:any,_p:any,actor:any)=>patchPipeline(id,req,ports as any,actor),reportStageCompletion:(req:any,actor:any)=>reportStageCompletion(req,actor,ports as any)};
let routeRequests=0;
const viewer=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){routeRequests++;const p=new URL(req.url).pathname;try{if(p==='/api/search/memory')return await (req.method==='POST'?memoryRoutes.POST(req):memoryRoutes.GET(req));if(p==='/api/search/transcripts')return await transcriptRoutes.GET(req);if(p==='/api/conversations')return await conversationsGET(req);if(p==='/api/files')return await filesGET(req as any);return Response.json({error:'route not exposed in audit'},{status:404});}catch{return new Response('<html>Internal server error</html>',{status:500});}}});
process.env.LLV_VIEWER_CONTROL_URL=`http://127.0.0.1:${viewer.port}`;
const timings=new serverMod.McpToolTimingAggregate();
const receipts=new serverMod.SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!,'audit-receipts.sqlite'));
const bindings=viewerMcpBindings(undefined,productionViewerControlDependencies(true),domain as any);
const service=serverMod.createMcpToolService(bindings,receipts,viewerMcpToolPolicy(domain as any),{timings});
const mcp=serverMod.createViewerMcpServer(service);
const client=new Client({name:'private-audit',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),mcp.connect(b)]);
const listed=await client.listTools();let common=listed.tools[0]!.description??'';for(const t of listed.tools){while(!t.description?.startsWith(common))common=common.slice(0,-1);}
const schemaCost={tools:listed.tools.length,totalTok:JSON.stringify(listed).length/4,commonPrefixChars:common.length,repeatedPrefixTok:common.length*(listed.tools.length-1)/4};
let seq=0;const measurements:any[]=[];
async function call(tool:string,fields:any,scenario:string){const args:any={clientRequestId:`audit-${++seq}`,...fields};
 // Request shape is fixed across revisions so the profile measures server behavior,
 // not a different caller input. The pinned base already supports these options.
 if(OPTIONAL_READ_KEY_TOOLS.has(tool))delete args.clientRequestId;
 if(tool==='create_pipeline')delete args.src;
 const start=performance.now();const answer:any=await runAsMcpHttpCaller({capability},()=>client.callTool({name:tool,arguments:args}));const elapsed=performance.now()-start;const result=answer.structuredContent??JSON.parse(answer.content[0].text);if(result.ok===false)console.log(JSON.stringify({refusalTool:tool,scenario,code:result.code,error:result.error}));measurements.push({tool,scenario,ms:elapsed,inTok:JSON.stringify(args).length/4,outTok:JSON.stringify(result).length/4,ok:result.ok,inputKeys:Object.keys(args).sort(),fieldNames:Object.keys(result)});return result;}
try{
 console.log('Profile: baseline begins');
 for(let i=0;i<20;i++){
  await call('get_pipeline',{pipelineId:reportLane.id,stageId:'build'},'stage');
  await call('get_pipeline',{pipelineId:reportLane.id,compact:true},'compact');
  if(i<3)await call('get_pipeline',{pipelineId:reportLane.id,full:true},'full');
  await call('get_pipeline',{pipelineId:reportLane.id},'default');
  await call('list_tasks',{project,limit:200},'limit200');
  await call('list_tasks',{project,limit:5},'limit5');
  await call('list_pipelines',{project,state:'open',limit:100},'open');
  await call('list_pipelines',{project,state:'open',limit:100,statusOnly:true},'status-only');
  await call('search_transcripts',{query:'audit',project,limit:3},'indexed3');
  await call('conversation_messages',{transcriptPath:transcript,limit:10,maxChars:1200},'page10');
  await call('resources',{},'system-summary');
  await call('agent_activity',{project},'compact');
  await call('update_task',{taskId:tasks[0]!.id,status:i%2?'inbox':'blocked'},'status');
  await call('pipeline_action',{pipelineId:lanes[0]!.id,action:'pause'},'routine');
  await call('stage_report',{verdict:'pass',summary:'Audit fixture'},'forge-fast');
 }
 await call('list_conversations',{query:'audit',limit:3},'isolated-scan');
 for(let i=0;i<3;i++){
  externalDelay=1200;
  await call('stage_report',{verdict:'pass',summary:'Audit fixture'},'forge-delay1200');
  await Promise.all([call('stage_report',{verdict:'pass',summary:'Audit fixture'},'concurrent-forge1200'),call('get_pipeline',{pipelineId:reportLane.id,stageId:'build'},'concurrent-forge1200')]);
  externalDelay=0;
 }
 for(let i=0;i<3;i++){
  const trial=findPipelineRecord(reportLane.id)!;trial.state='needs_decision';trial.cursor={stageId:'review',state:'pending',input:null,activatedBy:null} as any;trial.stages[1]!.kind='review-loop';trial.runs[1]!.attempts.at(-1)!.paneId=null;trial.runs[1]!.attempts.at(-1)!.launchId=null;trial.branch=reportLane.branch;
  trial.publication='remote-branch';trial.delivery={target:{repository:'audit-repo',branch:`refs/heads/${trial.branch}`,remote:'origin'},disposition:'owner',publish:'enabled',ownerId:trial.id,epoch:1,active:true,journal:[]} as any;
  const all=loadPipelines();all[all.findIndex(p=>p.id===trial.id)]=trial;savePipelines(all);
  externalDelay=i===0?0:1200;await call('pipeline_action',{pipelineId:trial.id,action:'retry-stage'},externalDelay?'retry-remote1200':'retry-remote-fast');externalDelay=0;
 }
 for(let i=0;i<5;i++)await call('create_pipeline',{task:'Audit admission fixture '+i,spec:'Acceptance statement. '.repeat(100),src:transcript,repoDir:process.env.COST_REPO,autoStart:false,stages:[{id:'build',kind:'run',prompt:'Audit only',next:null}]},'draft-admission');
 for(let i=0;i<2;i++){
  const target={kind:'point',project,x:0,y:0};
  const created=createAttentionRequest({rootId:'audit-root',origin:'root-agent',target,frameAtCreation:{project,rect:{x:0,y:0,w:400,h:600},boardRevision:null},intent:'show',reason:'Audit arrival',directedAt:'audit-device',directedAtSession:'audit-view'} as any);
  (domain as any).authorizedSeats=()=>[];(domain as any).findAttentionByOperation=()=>created.request;
  (domain as any).awaitAttentionArrival=(id:any,options:any)=>awaitAttentionArrival(id,options);
  const timer=setTimeout(()=>answerAttentionRequest(created.request.id,{kind:'arrive',deviceId:'audit-device',returnPoint:{deviceId:'audit-device',mode:'scheme',camera:{x:0,y:0,zoom:1},focusedPath:null,capturedAt:new Date().toISOString()},resolution:'exact'} as any),1200);
  try{await call('request_attention',{target,reason:'Audit arrival'},'browser-arrival1200');}finally{clearTimeout(timer);}
 }
 const groups=new Map<string,any[]>();for(const m of measurements){const k=m.tool+'/'+m.scenario;if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(m);}
 const q=(a:number[],p:number)=>a.toSorted((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)];
 const grouped=[...groups].map(([key,ms])=>({key,n:ms.length,ok:ms.filter(m=>m.ok).length,inputKeys:[...new Set(ms.flatMap(m=>m.inputKeys))].sort(),p50ms:+q(ms.map(m=>m.ms),.5).toFixed(2),p95ms:+q(ms.map(m=>m.ms),.95).toFixed(2),maxMs:+Math.max(...ms.map(m=>m.ms)).toFixed(2),inTokP50:q(ms.map(m=>m.inTok),.5),outTokP50:q(ms.map(m=>m.outTok),.5)}));
 if(measurements.some(m=>!m.ok))throw new Error('Measurement refused; inspect local log');
 const phases=timings.snapshot().filter(t=>t.calls).map(t=>({tool:t.toolName,calls:t.calls,phases:t.phases,outcomes:t.outcomes}));
 const output={schemaCost,seed:{tasks:107,pipelines:27,stagesPerPipeline:2,attemptsPerStage:6,transcriptMessages:1000,transcriptBytes:fs.statSync(transcript).size},transport:'MCP SDK in-memory plus loopback Viewer route handlers',grouped,phases,externalCommands:execSamples};
 fs.writeFileSync(path.join(root,'profile.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({seed:output.seed,grouped},null,2));
 const faults:any[]=[];
 const originalConsoleError=console.error;
 console.error=()=>{};
 try {
 for(const scenario of ['memory-search','memory-open','transcript-search'])for(let i=0;i<3;i++){
  const state=path.join(root,'fault-state',`${scenario}-${i}`);fs.mkdirSync(state,{recursive:true});process.env.LLV_STATE_DIR=state;
  fs.writeFileSync(path.join(state,scenario.startsWith('memory')?'memory-index.sqlite':'transcript-search.sqlite'),'invalid database fixture');
  const tool=scenario.startsWith('memory')?'search_memory':'search_transcripts';
  const args=scenario==='memory-open'?{id:'m_fixture',clientRequestId:`fault-${scenario}-${i}`}:{query:'widget',clientRequestId:`fault-${scenario}-${i}`};
  routeRequests=0;const started=performance.now();
  const answer:any=await runAsMcpHttpCaller({capability},()=>client.callTool({name:tool,arguments:args}));
  const result=answer.structuredContent??JSON.parse(answer.content[0].text);
  faults.push({side:candidate?'head':'base',scenario,ms:+(performance.now()-started).toFixed(2),attempts:routeRequests,ok:result.ok===true,outputTokens:JSON.stringify(result).length/4});
 }
 } finally { console.error=originalConsoleError; }
 const expectedAttempts=candidate?1:11;
 fs.writeFileSync(path.join(root,'faults.json'),JSON.stringify(faults,null,2));
 if(faults.some(row=>row.ok||row.attempts!==expectedAttempts))throw new Error(`Fault acceptance failed; expected failed verdict and ${expectedAttempts} route attempt(s): ${JSON.stringify(faults)}`);
}finally{await client.close();await mcp.close();viewer.stop(true);receipts.close();restoreTick();}
}
