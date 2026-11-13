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
 // The service starts from an already mounted portable command. Its manager
 // must reconstruct the source hook after crossing that namespace boundary.
 const command=service==="budget"?[runner,"--budget","25000",...args]:service?[runner,"--portable",process.execPath,runner,...args]:[runner,"--portable",...args];
 const child=spawn(process.execPath,command,{cwd:dir,env:{...env,...extra},stdio:["ignore","pipe","pipe"]});children.push(child);
 child.stdout!.on("data",v=>out+=v);child.stderr!.on("data",v=>err+=v);const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
 console.log(JSON.stringify({launch:name,pid:child.pid,args}));return {child,exited,out:()=>out,err:()=>err};}
 const rows=()=>db.query<{seq:number;held:number;owner:string},[]>("SELECT * FROM checks ORDER BY seq").all();
 function project(name:string){fs.mkdirSync(path.join(dir,name));fs.writeFileSync(path.join(dir,name,"source.ts"),"export const answer: number=42;\n");fs.writeFileSync(path.join(dir,name,"tsconfig.json"),JSON.stringify({compilerOptions:{types:[],skipLibCheck:true,outDir:"out"},files:["source.ts"]}));return path.join(dir,name,"out/source.js");}
 return {dir,env,start,rows,project,async close(){await Promise.all(children.map(c=>stopFixtureProcess(c)));await until(()=>rows().length===0,"private pool not empty");db.close();}};
}

for(const service of [false,true,"budget"] as const) for(const mode of ["memory-options","module-wrapper"]) test.skipIf(process.platform !== "linux" || service === true && !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`compiler entry queues ${mode} service=${service} with its own runtime options`, async () => {
 const f=fixture(`${mode}-${service}`,1,service),held=f.project("held"),second=f.project("second");
 fs.mkdirSync(path.join(f.dir,"node_modules/.bin"),{recursive:true});
 fs.cpSync(path.join(head,"node_modules/typescript"),path.join(f.dir,"node_modules/typescript"),{recursive:true});
 fs.symlinkSync("../typescript/bin/tsc",path.join(f.dir,"node_modules/.bin/tsc"));
 const installed=path.join(f.dir,"node_modules/typescript/bin/tsc");
 // Observe the heap inside the real compiler, after command-line entry.
 const lib=path.join(f.dir,"node_modules/typescript/lib/_tsc.js");
 fs.chmodSync(lib,0o600);
 const measurement = 'require("node:fs").writeFileSync(require("node:path").join(require("node:path").dirname(commandLineArgs[commandLineArgs.indexOf("--project")+1]),"heap.json"),JSON.stringify(require("node:v8").getHeapStatistics()));';
 const compilerSource = fs.readFileSync(lib,"utf8");
 fs.writeFileSync(lib, compilerSource.includes("/* delegatus compiler entry */")
   ? compilerSource.replace(/(await import\([^\n]+\)\.then\(m => m\.admitWorker\("compiler"\)\);)/, "$1\n" + measurement)
   : compilerSource.replace("function executeCommandLine(system, cb, commandLineArgs) {", match => match + measurement));
 const installedSource=fs.readFileSync(lib,"utf8");

 fs.writeFileSync(path.join(f.dir,"wrapper.cjs"),`require(${JSON.stringify(installed)});`);
 const script=mode==="memory-options"?`NODE_OPTIONS=--max-old-space-size=1024 tsc --project second/tsconfig.json --listEmittedFiles`:`node wrapper.cjs --project second/tsconfig.json --listEmittedFiles`;
 fs.writeFileSync(path.join(f.dir,"package.json"),JSON.stringify({scripts:{typecheck:script}}));
 const holder=f.start([process.execPath,installed,"--project","held/tsconfig.json","--watch","--preserveWatchOutput"],"watch holder");
 try{
 await until(()=>fs.existsSync(held)||holder.child.exitCode!==null,"watch holder not ready");assert.equal(holder.child.exitCode,null,holder.err());
 const worker=f.start([process.execPath,"run","typecheck"],mode);
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
 const heap=JSON.parse(fs.readFileSync(path.join(f.dir,"second/heap.json"),"utf8"));
 if(mode==="memory-options") assert.ok(heap.heap_size_limit>=1024*1024*1024 && heap.heap_size_limit<1150*1024*1024,JSON.stringify(heap));
 assert.equal(await peer.exited,0,peer.err());
 assert.equal(fs.existsSync(third),true);
 assert.equal(fs.readFileSync(lib,"utf8"),installedSource,"gate mounts changed the installed compiler");
 }finally{await f.close();}
},60_000);

test.skipIf(process.platform !== "linux")("a refused compiler mount has no effects while a peer can compile", async () => {
 const f=fixture("mount-refusal");
 const refused=f.project("refused"), passed=f.project("passed");
 const bin=path.join(f.dir,"bin");fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,"unshare"),"#!/bin/sh\nexit 69\n",{mode:0o700});
 fs.mkdirSync(path.join(f.dir,"node_modules"));
 fs.cpSync(path.join(head,"node_modules/typescript"),path.join(f.dir,"node_modules/typescript"),{recursive:true});
 const lib=path.join(f.dir,"node_modules/typescript/lib");
 for(const name of fs.readdirSync(lib).filter(name=>name.endsWith(".js"))) {
   const file=path.join(lib,name),source=fs.readFileSync(file,"utf8");
   if(!source.includes("/* delegatus compiler entry */")) continue;
   fs.chmodSync(file,0o600);
   fs.writeFileSync(file,source.replace(/async (function executeCommandLine\([^)]*\) \{)\n\/\* delegatus compiler entry \*\/\nawait import\([^\n]+\)\.then\(m => m\.admitWorker\("compiler"\)\);/g,"$1"));
 }
 const compiler=path.join(f.dir,"node_modules/typescript/bin/tsc");
 const worker=f.start(["node",compiler,"--project","refused/tsconfig.json"],"refused mount",{PATH:bin+path.delimiter+process.env.PATH});
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
 const worker=f.start(["node",path.join(head,"node_modules/typescript/bin/tsc"),"--project","tsconfig.json"],"typecheck mounted preload");
 try {
   assert.equal(await worker.exited,0,worker.out()+worker.err());
   assert.equal(fs.readFileSync(preload,"utf8"),source,"gate mounts changed the configured preload");
 } finally { await f.close(); }
},60_000);
