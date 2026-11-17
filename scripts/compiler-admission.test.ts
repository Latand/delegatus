import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { head, root, daemonCompiler, installCompiler, until, fixture, stopFixtureProcess } from "./compiler-admission.fixture";

test("a private compiler installation can be removed after copying a read-only store", () => {
 const directory=path.join(root,"removable-compiler");
 const store=path.join(root,"readonly-store"),lib=path.join(store,"lib");
 fs.mkdirSync(lib,{recursive:true});
 fs.writeFileSync(path.join(lib,"compiler.js"),"// fixture\n");
 fs.chmodSync(lib,0o555);fs.chmodSync(store,0o555);
 try {
   installCompiler(directory,store);
   fs.rmSync(directory,{recursive:true});
   assert.equal(fs.existsSync(directory),false);
 } finally {
   fs.chmodSync(store,0o700);fs.chmodSync(lib,0o700);
   fs.rmSync(store,{recursive:true});
 }
});
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

test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP)("a script's admitted test owns its teardown scope behind a saturated compiler", async () => {
 const f=fixture("script-test-scope",1,true),held=f.project("held");
 const file=path.join(f.dir,"child.test.ts");
 fs.writeFileSync(file,'import {test,expect} from "bun:test"; test("script child",()=>expect(true).toBe(true));');
 const holder=f.start([process.execPath,path.join(head,"node_modules/typescript/bin/tsc"),"--project","held/tsconfig.json","--watch","--preserveWatchOutput"],"watch holder");
 try {
   await until(()=>fs.existsSync(held)||holder.child.exitCode!==null,"holder not ready");
   assert.equal(holder.child.exitCode,null,holder.err());
   const script=`const child=Bun.spawn([process.execPath,"test",${JSON.stringify(file)}],{cwd:${JSON.stringify(head)},stdout:"inherit",stderr:"inherit",env:process.env}); process.exit(await child.exited);`;
   const worker=f.start([process.execPath,"-e",script],"script test");
   await until(()=>f.rows().length===2||worker.child.exitCode!==null,"test neither queued nor exited");
   assert.equal(worker.child.exitCode,null,worker.err());
   assert.deepEqual(f.rows().map(row=>row.held),[1,0]);
   assert.equal(worker.out(),"");
   await stopFixtureProcess(holder.child);
   assert.equal(await worker.exited,0,worker.out()+worker.err());
   assert.match(worker.err(),/1 pass/);
   assert.match(worker.err(),/0 fail/);
 } finally { await f.close(); }
},60_000);

for (const interrupted of [false,true]) for (const explicit of [false,true]) test.skipIf(process.platform !== "linux")(`a nested package retains its own Bun config and preloads behind the same saturated cap explicit=${explicit} interrupted=${interrupted}`, async () => {
 const f=fixture(`nested-config-${explicit}-${interrupted}`);
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
   if(interrupted) {
     const pid=JSON.parse(f.rows()[1].owner).pid as number;
     process.kill(pid,"SIGSTOP");
     await until(()=>/^State:\s+T/m.test(fs.readFileSync(`/proc/${pid}/status`,"utf8")),"queued test did not stop");
     process.kill(pid,"SIGCONT");
   }
   await stopFixtureProcess(holder.child);
   assert.equal(await worker.exited,0,worker.out()+worker.err());
   assert.match(worker.err(),/1 pass/);
   assert.equal(fs.readFileSync(path.join(child,"configured"),"utf8"),"yes");
   assert.equal(fs.readFileSync(path.join(child,"bunfig.toml"),"utf8"),settings);
 } finally { await f.close(); }
},60_000);


test.skipIf(process.platform !== "linux")("cancelling a nested daemon reclaims its wait without later compiler effects", async () => {
 const f=fixture("daemon-cancel"),held=f.project("held"),second=f.project("second"),peerOutput=f.project("peer");
 const compiler=path.join(head,"node_modules/typescript/bin/tsc");
 fs.writeFileSync(path.join(f.dir,"wrapper.cjs"),`require(${JSON.stringify(compiler)});`);
 const holder=f.start([process.execPath,compiler,"--project","held/tsconfig.json","--watch","--preserveWatchOutput"],"watch holder");
 try {
   await until(()=>fs.existsSync(held)||holder.child.exitCode!==null,"holder not ready");
   assert.equal(holder.child.exitCode,null,holder.err());
   const worker=f.start(["python3","-c",daemonCompiler()],"nested daemon");
   await until(()=>f.rows().length===2||worker.child.exitCode!==null,"daemon did not queue");
   assert.equal(worker.child.exitCode,null,worker.err());
   assert.deepEqual(f.rows().map(row=>row.held),[1,0]);
   assert.equal(fs.existsSync(second),false);
   await stopFixtureProcess(worker.child);
   await until(()=>f.rows().length===1,"cancelled daemon retained its ticket");
   await stopFixtureProcess(holder.child);
   const peer=f.start(["node",compiler,"--project","peer/tsconfig.json"],"peer after cancellation");
   assert.equal(await peer.exited,0,peer.err());
   assert.equal(fs.existsSync(peerOutput),true);
   assert.equal(fs.existsSync(second),false);
 } finally { await f.close(); }
},60_000);
