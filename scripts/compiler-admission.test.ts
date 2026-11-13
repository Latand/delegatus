import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
const head = path.resolve(import.meta.dir, "..");
const { onlineCpuCount } = await import(path.join(head,"src/lib/runtime/cpuPlacement.ts"));
const { CheckAdmission } = await import(path.join(head,"scripts/check-admission.ts"));
const { stopFixtureProcess } = await import(path.join(head,"src/lib/testing/fixtureProcess.ts"));
const { withoutInheritedGate } = await import(path.join(head,"src/lib/testing/inheritedGateEnv.ts"));
const root=path.join(process.env.TMPDIR!,"review-campaign");fs.mkdirSync(root,{recursive:true});
const runner=path.join(head,"scripts/owned-runner.ts");
const quote=(arg:string)=>"'"+arg.replaceAll("'","'\\''")+"'";
function installCompiler(directory:string) {
 fs.cpSync(path.join(head,"node_modules/typescript"),directory,{recursive:true});
 // A baseline runner may expose its own private source mounts. Reproduce a
 // separately installed compiler with its original CLI semantics.
 for(const name of fs.readdirSync(path.join(directory,"lib")).filter(name=>name.endsWith(".js"))) {
   const file=path.join(directory,"lib",name),source=fs.readFileSync(file,"utf8");
   const clean=source.replace(/async (function executeCommandLine\([^)]*\) \{)\n\/\* delegatus compiler entry \*\/\nawait import\([^\n]+\)\.then\(m => m\.admitWorker\("compiler"\)\);/g,"$1");
   if(clean!==source) { fs.chmodSync(file,0o600); fs.writeFileSync(file,clean); }
 }
}
async function until(check:()=>boolean, label:string){const end=performance.now()+15000;while(!check()){if(performance.now()>end)throw Error(label);await Bun.sleep(10);}}
function fixture(name:string,cap=1,service:boolean|"budget"=false){
 const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});
 const env=withoutInheritedGate({...process.env});delete env.BUN_OPTIONS;delete env.NODE_OPTIONS;delete env.LLV_CHECK_BROKER;delete env.DELEGATUS_CHECK_BROKER;
 Object.assign(env,{LLV_CHECK_ADMISSION_FILE:path.join(dir,"checks.sqlite"),DELEGATUS_GATE_CPU_HEADROOM:String(onlineCpuCount()-cap),LLV_OWNED_RUN_TIMEOUT_MS:"25000",LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1",NODE_ENV:"test"});
 for(const key of ["HOME","XDG_CONFIG_HOME","TMPDIR","LLV_STATE_DIR"]){env[key]=path.join(dir,key);fs.mkdirSync(env[key]!,{recursive:true});}
 env.LLV_TEST_STARTUP_HOME=env.HOME;
 fs.writeFileSync(path.join(dir,"bunfig.toml"),"[test]\n");
 new CheckAdmission(env.LLV_CHECK_ADMISSION_FILE).close();const db=new Database(env.LLV_CHECK_ADMISSION_FILE!);
 const children:ReturnType<typeof spawn>[]=[];
 function start(args:string[],name:string,extra={}){let out="",err="";
 // A nested service must establish the same barrier after systemd reparenting.
 const command=service==="budget"?[runner,"--budget","25000",...args]:service?[runner,"--portable",process.execPath,runner,...args]:[runner,"--portable",...args];
 const child=spawn(process.execPath,command,{cwd:dir,env:{...env,...extra},stdio:["ignore","pipe","pipe"]});children.push(child);
 child.stdout!.on("data",v=>out+=v);child.stderr!.on("data",v=>err+=v);const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
 console.log(JSON.stringify({launch:name,pid:child.pid,args}));return {child,exited,out:()=>out,err:()=>err};}
 const rows=()=>db.query<{seq:number;held:number;owner:string},[]>("SELECT * FROM checks ORDER BY seq").all();
 function project(name:string){fs.mkdirSync(path.join(dir,name));fs.writeFileSync(path.join(dir,name,"source.ts"),"export const answer: number=42;\n");fs.writeFileSync(path.join(dir,name,"tsconfig.json"),JSON.stringify({compilerOptions:{types:[],skipLibCheck:true,outDir:"out"},files:["source.ts"]}));return path.join(dir,name,"out/source.js");}
 return {dir,env,start,rows,project,async close(){await Promise.all(children.map(c=>stopFixtureProcess(c)));await until(()=>rows().length===0,"private pool not empty");db.close();}};
}

for(const service of [false,true,"budget"] as const) for(const mode of ["memory-options","module-wrapper","program-api","nested-own-install","external-entry","cleared-environment","copied-supervisor","alias-pool"]) test.skipIf(process.platform !== "linux" || service === true && !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`compiler entry queues ${mode} service=${service} with its own runtime options`, async () => {
 const f=fixture(`${mode}-${service}`,1,service),held=f.project("held"),second=f.project("second");
 fs.mkdirSync(path.join(f.dir,"node_modules/.bin"),{recursive:true});
 installCompiler(path.join(f.dir,"node_modules/typescript"));
 fs.symlinkSync("../typescript/bin/tsc",path.join(f.dir,"node_modules/.bin/tsc"));
 const installed=path.join(f.dir,"node_modules/typescript/bin/tsc");
 // Observe the heap inside the real compiler, after command-line entry.
 const lib=path.join(f.dir,"node_modules/typescript/lib/_tsc.js");
 fs.chmodSync(lib,0o600);
 const measurement = 'require("node:fs").writeFileSync(require("node:path").join(require("node:path").dirname(commandLineArgs[commandLineArgs.indexOf("--project")+1]),"heap.json"),JSON.stringify(require("node:v8").getHeapStatistics()));';
 const compilerSource = fs.readFileSync(lib,"utf8");
 fs.writeFileSync(lib, compilerSource.replace("function executeCommandLine(system, cb, commandLineArgs) {", match => match + measurement));
 const installedSource=fs.readFileSync(lib,"utf8");

 fs.writeFileSync(path.join(f.dir,"wrapper.cjs"),`require(${JSON.stringify(installed)});`);
 fs.writeFileSync(path.join(f.dir,"program.cjs"),`const ts=require("typescript"); const path=require("node:path");
 const config=path.resolve("second/tsconfig.json");
 const read=ts.readConfigFile(config,ts.sys.readFile);
 const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,path.dirname(config));
 const program=ts.createProgram(parsed.fileNames,parsed.options);
 const diagnostics=ts.getPreEmitDiagnostics(program);
 if(diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics,{getCanonicalFileName:v=>v,getCurrentDirectory:ts.sys.getCurrentDirectory,getNewLine:()=>"\\n"}));
 const emitted=program.emit(); if(emitted.emitSkipped) process.exitCode=1;
 console.log("compiled via program API");`);
 let script=mode==="memory-options"?`NODE_OPTIONS=--max-old-space-size=1024 tsc --project second/tsconfig.json --listEmittedFiles`:`node wrapper.cjs --project second/tsconfig.json --listEmittedFiles`;
 if(mode==="program-api") script="node program.cjs";
 if(mode==="cleared-environment") script=`env -i PATH=${quote(process.env.PATH!)} NODE_OPTIONS=--max-old-space-size=1024 node wrapper.cjs --project second/tsconfig.json --listEmittedFiles`;
 if(mode==="copied-supervisor") {
   fs.copyFileSync(path.join(import.meta.dir,"check-worker-entry.py"),path.join(f.dir,"copied-entry.py"));
   script="python3 -I copied-entry.py node wrapper.cjs --project second/tsconfig.json --listEmittedFiles";
 }
 if(mode==="nested-own-install" || mode==="external-entry") {
   // A separate installation, outside the outer cwd's ancestor lookup.
   const other=mode==="nested-own-install"?path.join(f.dir,"nested"):path.join(root,`external-${service}`);
   fs.mkdirSync(path.join(other,"node_modules/.bin"),{recursive:true});
   installCompiler(path.join(other,"node_modules/typescript"));
   const otherLib=path.join(other,"node_modules/typescript/lib/_tsc.js");
   fs.chmodSync(otherLib,0o600);
   fs.writeFileSync(otherLib,fs.readFileSync(otherLib,"utf8").replace("function executeCommandLine(system, cb, commandLineArgs) {",match=>match+measurement));
   fs.symlinkSync("../typescript/bin/tsc",path.join(other,"node_modules/.bin/tsc"));
   fs.writeFileSync(path.join(other,"package.json"),JSON.stringify({scripts:{typecheck:"NODE_OPTIONS=--max-old-space-size=1024 tsc --project ../second/tsconfig.json --listEmittedFiles"}}));
   script=mode==="nested-own-install"?"cd nested && bun run typecheck":`NODE_OPTIONS=--max-old-space-size=1024 node ${quote(path.join(other,"node_modules/typescript/bin/tsc"))} --project second/tsconfig.json --listEmittedFiles`;
 }
 fs.writeFileSync(path.join(f.dir,"package.json"),JSON.stringify({scripts:{typecheck:script}}));
 const holder=f.start([process.execPath,installed,"--project","held/tsconfig.json","--watch","--preserveWatchOutput"],"watch holder");
 try{
 await until(()=>fs.existsSync(held)||holder.child.exitCode!==null,"watch holder not ready");assert.equal(holder.child.exitCode,null,holder.err());
 const worker=f.start([process.execPath,"run","typecheck"],mode,mode==="alias-pool"?{LLV_CHECK_ADMISSION_FILE:undefined,LLV_GATE_CHECK_ADMISSION_FILE:f.env.LLV_CHECK_ADMISSION_FILE}:{});
 await until(()=>f.rows().length===2||worker.child.exitCode!==null,"second compiler neither queued nor exited");
 const observation={mode,code:worker.child.exitCode,holderAlive:holder.child.exitCode===null,rows:f.rows(),emitted:fs.existsSync(second),stdout:worker.out(),stderr:worker.err()};
 console.log(JSON.stringify(observation));
 assert.equal(worker.child.exitCode,null,worker.err());
 assert.equal(fs.existsSync(second),false);
 assert.equal(worker.out(),"");
 assert.deepEqual(f.rows().map(row=>row.held),[1,0]);
 // A later independent compiler cannot overtake this wrapper.
 const third=f.project("third");
 const peer=f.start(["node","wrapper.cjs","--project","third/tsconfig.json","--listEmittedFiles"],"FIFO peer");
 await until(()=>f.rows().length===3||peer.child.exitCode!==null,"peer did not queue");
 assert.deepEqual(f.rows().map(row=>row.held),[1,0,0]);
 assert.equal(fs.existsSync(third),false);
 assert.equal(peer.out(),"");
 await stopFixtureProcess(holder.child);
 assert.equal(await worker.exited,0,worker.err());
 assert.equal(fs.existsSync(second),true);
 if(["memory-options","nested-own-install","external-entry","cleared-environment"].includes(mode)) {
   const heap=JSON.parse(fs.readFileSync(path.join(f.dir,"second/heap.json"),"utf8"));
   assert.ok(heap.heap_size_limit>=1024*1024*1024 && heap.heap_size_limit<1150*1024*1024,JSON.stringify(heap));
 }
 assert.equal(await peer.exited,0,peer.err());
 assert.equal(fs.existsSync(third),true);
 assert.equal(fs.readFileSync(lib,"utf8"),installedSource,"gate changed the installed compiler");
 }finally{await f.close();}
},60_000);

test.skipIf(process.platform !== "linux")("a refused compiler supervisor has no effects while a peer can compile", async () => {
 const f=fixture("supervisor-refusal");
 const refused=f.project("refused"), passed=f.project("passed");
 const bin=path.join(f.dir,"bin");fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,"python3"),"#!/bin/sh\nexit 69\n",{mode:0o700});
 fs.mkdirSync(path.join(f.dir,"node_modules"));
 installCompiler(path.join(f.dir,"node_modules/typescript"));
 const compiler=path.join(f.dir,"node_modules/typescript/bin/tsc");
 const worker=f.start(["node",compiler,"--project","refused/tsconfig.json"],"refused supervisor",{PATH:bin+path.delimiter+process.env.PATH});
 try {
   assert.equal(await worker.exited,69,worker.err());
   assert.equal(fs.existsSync(refused),false);
   assert.equal(worker.out(),"");
   assert.deepEqual(f.rows(),[]);
   const peer=f.start(["node",compiler,"--project","passed/tsconfig.json"],"passing peer");
   assert.equal(await peer.exited,0,peer.err());
   assert.equal(fs.existsSync(passed),true);
 } finally { await f.close(); }
},60_000);

test.skipIf(process.platform !== "linux")("a compiler can typecheck its configured test preload", async () => {
 const f=fixture("preload-typecheck");
 const preload=path.join(f.dir,"setup.ts"),source="export const value: number = 42;\n";
 fs.writeFileSync(preload,source);
 fs.writeFileSync(path.join(f.dir,"bunfig.toml"),'[test]\npreload = ["./setup.ts"]\n');
 fs.writeFileSync(path.join(f.dir,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"ESNext",types:[],skipLibCheck:true,noEmit:true},files:["setup.ts"]}));
 const worker=f.start(["node",path.join(head,"node_modules/typescript/bin/tsc"),"--project","tsconfig.json"],"typecheck configured preload");
 try {
   assert.equal(await worker.exited,0,worker.out()+worker.err());
   assert.equal(fs.readFileSync(preload,"utf8"),source,"gate changed the configured preload");
 } finally { await f.close(); }
},60_000);

for (const explicit of [false,true]) test.skipIf(process.platform !== "linux")(`a nested package retains its own Bun config and preloads behind the same saturated cap explicit=${explicit}`, async () => {
 const f=fixture(`nested-config-${explicit}`);
 const held=f.project("held");
 const child=path.join(f.dir,"child"); fs.mkdirSync(child);
 fs.writeFileSync(path.join(f.dir,"package.json"),JSON.stringify({scripts:{check:`cd child && bun ${explicit?"--config=bunfig.toml ":""}test ./worker.test.ts`}}));
 const settings='[test]\npreload = ["./setup.ts"]\n';
 fs.writeFileSync(path.join(child,"bunfig.toml"),settings);
 fs.writeFileSync(path.join(child,"setup.ts"),'import fs from "node:fs"; globalThis.setupLoaded=true; fs.writeFileSync("configured","yes");');
 fs.writeFileSync(path.join(child,"worker.test.ts"),'import {test,expect} from "bun:test"; test("nested config",()=>expect(globalThis.setupLoaded).toBe(true));');
 const holder=f.start([process.execPath,path.join(head,"node_modules/typescript/bin/tsc"),"--project","held/tsconfig.json","--watch","--preserveWatchOutput"],"watch holder");
 try {
   await until(()=>fs.existsSync(held)||holder.child.exitCode!==null,"holder not ready");
   assert.equal(holder.child.exitCode,null,holder.err());
   const worker=f.start([process.execPath,"run","check"],"child config");
   await until(()=>f.rows().length===2||worker.child.exitCode!==null,"child neither queued nor exited");
   assert.equal(worker.child.exitCode,null,worker.err());
   assert.deepEqual(f.rows().map(row=>row.held),[1,0]);
   assert.equal(fs.existsSync(path.join(child,"configured")),false);
   assert.equal(worker.out(),"");
   await stopFixtureProcess(holder.child);
   assert.equal(await worker.exited,0,worker.out()+worker.err());
   assert.match(worker.err(),/1 pass/);
   assert.equal(fs.readFileSync(path.join(child,"configured"),"utf8"),"yes");
   assert.equal(fs.readFileSync(path.join(child,"bunfig.toml"),"utf8"),settings);
 } finally { await f.close(); }
},60_000);
