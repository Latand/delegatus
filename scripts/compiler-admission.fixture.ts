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
function daemonCompiler() { return `import os,select,time
read,write=os.pipe()
parent=os.fork()
if parent:
 os.close(write)
 pid=int(os.read(read,64))
 os.waitpid(parent,0)
 fd=os.pidfd_open(pid)
 poll=select.poll();poll.register(fd,select.POLLIN);poll.poll()
 os._exit(0)
os.close(read);os.setsid()
if os.fork(): os._exit(0)
os.write(write,str(os.getpid()).encode());os.close(write)
while os.getppid()!=int(os.environ["LLV_CHECK_ENTRY_SUPERVISOR"]): time.sleep(0.001)
os.execvp("node",["node","wrapper.cjs","--project","second/tsconfig.json","--listEmittedFiles"])
`; }
function installCompiler(directory:string,source=path.join(head,"node_modules/typescript")) {
 fs.cpSync(source,directory,{recursive:true});
 // Package-manager stores can expose read-only directories. These are private
 // fixture copies, and the owning runner must be able to remove every copy.
 const writable = (dir:string) => {
   fs.chmodSync(dir,fs.statSync(dir).mode | 0o700);
   for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
     if(entry.isDirectory()) writable(path.join(dir,entry.name));
   }
 };
 writable(directory);
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

export function compilerEntryCases(service: boolean | "budget") {
for(const mode of ["memory-options","module-wrapper","program-api","nested-own-install","external-entry","cleared-environment","copied-supervisor","alias-pool","threaded-exec","double-fork","stopped-waiter","inherited-descriptor"]) test.skipIf(process.platform !== "linux" || service === true && !process.env.LLV_OWNED_TEST_RUN_CGROUP)(`compiler entry queues ${mode} service=${service} with its own runtime options`, async () => {
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
 if(mode==="inherited-descriptor") {
   // Count the original O_PATH open before the same process execs an
   // interpreter and reads the inherited descriptor through procfs.
   fs.writeFileSync(path.join(f.dir,"descriptor.cjs"),`const fs=require("node:fs"),path=require("node:path"),{createRequire}=require("node:module");
const filename=path.resolve("node_modules/typescript/lib/_tsc.js"),moduleObject={exports:{}};
new Function("module","exports","require","__filename","__dirname",fs.readFileSync("/proc/self/fd/99","utf8"))(moduleObject,moduleObject.exports,createRequire(filename),filename,path.dirname(filename));`);
   script=`python3 -c ${quote('import os; fd=os.open("node_modules/typescript/lib/_tsc.js",os.O_PATH); os.dup2(fd,99,inheritable=True); os.close(fd); os.execvp("node",["node","descriptor.cjs","--project","second/tsconfig.json","--listEmittedFiles"])')}`;
 }

 if(mode==="threaded-exec") script=`python3 -c ${quote('import os,threading; threading.Thread(target=lambda: os.execvp("node",["node","wrapper.cjs","--project","second/tsconfig.json","--listEmittedFiles"])).start()')}`;
 if(mode==="cleared-environment") script=`env -i PATH=${quote(process.env.PATH!)} NODE_OPTIONS=--max-old-space-size=1024 node wrapper.cjs --project second/tsconfig.json --listEmittedFiles`;
 if(mode==="double-fork") {
   const daemon = daemonCompiler();
   script=`python3 -c ${quote(daemon)}`;
 }
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
 if(mode==="stopped-waiter") {
   const pid=JSON.parse(f.rows()[1].owner).pid as number;
   const state=()=>/^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`,"utf8"))?.[1];
   await until(()=>state()==="S","queued compiler is not sleeping");
   process.kill(pid,"SIGSTOP");
   await until(()=>state()==="T","queued compiler did not stop");
   assert.equal(fs.existsSync(second),false);
   process.kill(pid,"SIGCONT");
   await until(()=>state()==="S","queued compiler did not resume its held open");
   assert.deepEqual(f.rows().map(row=>row.held),[1,0]);
   assert.equal(worker.out(),"");
 }
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
}

export { head, root, quote, daemonCompiler, installCompiler, until, fixture, stopFixtureProcess };
