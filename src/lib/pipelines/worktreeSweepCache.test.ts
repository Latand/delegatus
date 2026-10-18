import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, test } from "bun:test";
import { WorktreeSweepCache, SWEEP_CACHE_TREES } from "./worktreeSweepCache";
import { inspectTree } from "@/lib/tempSweep";
import { allocatedBytes, realGit, sweepMergedWorktrees, type WorktreeSweepPorts } from "./worktreeSweep";
const roots: string[] = [];
const caches: WorktreeSweepCache[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});
function setup(options: { flat?: boolean; bounds?: { trees: number; entries: number; bytes: number; directories?: number } } = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sweep-cache-"));roots.push(root);
  const tree=path.join(root,"tree");
  if(options.flat) { fs.mkdirSync(tree);fs.writeFileSync(path.join(tree,"file"),"cache"); }
  else { fs.mkdirSync(path.join(tree,"nested"),{recursive:true});fs.writeFileSync(path.join(tree,"nested/file"),"cache"); }
  const callbacks = new Map<string,()=>void>();
  const observers = new Map<string,EventEmitter>();
  const closed = new Set<string>();
  const installed: { path: string; closed: boolean }[] = [];
  const watch = ((directory: string, _options: unknown, callback:()=>void) => {
    callbacks.set(directory,callback);
    const entry = { path: directory, closed: false };
    installed.push(entry);
    const emitter=Object.assign(new EventEmitter(),{close:()=>{entry.closed=true;closed.add(directory);}});
    observers.set(directory,emitter);return emitter;
  }) as unknown as typeof fs.watch;
  let now=1_000;
  const file=path.join(root,"cache.json");
  const cache=new WorktreeSweepCache(file,()=>now,watch,options.bounds);caches.push(cache);
  return {root,tree,file,cache,callbacks,observers,closed,installed,setNow:(value:number)=>{now=value;}};
}
async function size(cache: WorktreeSweepCache, tree: string, seen=new Set<string>(), excluded: string[]=[], clock="settled") {
  return cache.allocation(tree,clock,excluded,seen,()=>allocatedBytes(tree,excluded,seen));
}

test("warm cached allocations preserve shared-inode, nested-root and namespace-alias accounting",async()=>{
  const {root,tree,cache}=setup();
  const peer=path.join(root,"peer");fs.mkdirSync(peer);
  fs.linkSync(path.join(tree,"nested/file"),path.join(peer,"shared"));
  const alias=path.join(root,"alias");fs.symlinkSync(tree,alias,"dir");
  for(let pass=0;pass<2;pass++) {
    const actualSeen=new Set<string>(),expectedSeen=new Set<string>();
    for(const directory of [tree,peer,alias])
      expect(await size(cache,directory,actualSeen)).toBe(await allocatedBytes(directory,[],expectedSeen));
    const nested=path.join(tree,"nested");
    expect(await size(cache,tree,new Set(),[nested])).toBe(await allocatedBytes(tree,[nested]));
  }

  // Hard-linked inventories are deliberately fresh; a plain inventory still
  // demonstrates warm reuse in the same cache.
  const plain = path.join(root,"plain");fs.mkdirSync(plain);fs.writeFileSync(path.join(plain,"file"),"plain");
  await size(cache,plain);await size(cache,plain);
  expect(cache.stats.allocationHits).toBeGreaterThan(0);
});

test("native external hard-link writes invalidate a previously warm allocation inventory",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sweep-hardlink-"));roots.push(root);
  const tree=path.join(root,"tree");fs.mkdirSync(tree);
  const file=path.join(tree,"payload"),peer=path.join(root,"peer"),alias=path.join(peer,"payload");
  fs.mkdirSync(peer);fs.writeFileSync(file,"seed");
  const cache=new WorktreeSweepCache(path.join(root,"cache.json"));caches.push(cache);
  const observer=fs.watch(peer,{persistent:false});
  try {
    const before=await size(cache,tree);
    expect(before).toBe(await allocatedBytes(tree));
    await size(cache,tree);
    expect(cache.stats.allocationHits).toBe(1);

    const changed=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("native peer watch event timed out")),3_000);
      observer.once("change",()=>{clearTimeout(timer);resolve();});
      observer.once("error",error=>{clearTimeout(timer);reject(error);});
    });
    fs.linkSync(file,alias);
    fs.writeFileSync(alias,"x".repeat(1024*1024));
    await changed;
    await new Promise<void>(resolve=>setTimeout(resolve,0));

    const after=await size(cache,tree);
    expect(after).toBe(await allocatedBytes(tree));
    expect(after).toBeGreaterThan(before);
    expect(cache.stats.allocationHits).toBe(1);
    expect(cache.stats.allocationMisses).toBe(2);

    const secondTree=path.join(root,"second-tree");fs.mkdirSync(secondTree);
    fs.linkSync(file,path.join(secondTree,"payload"));
    const seen=new Set<string>();
    const expectedSeen=new Set<string>();
    const combined=(await size(cache,tree,seen))+(await size(cache,secondTree,seen));
    const expected=(await allocatedBytes(tree,[],expectedSeen))+(await allocatedBytes(secondTree,[],expectedSeen));
    expect(combined).toBe(expected);
  } finally { observer.close(); }
});

test("deep invalidation, retention-clock changes, expiry and backward clocks require fresh observations",async()=>{
  const {tree,cache,callbacks,setNow}=setup();
  await size(cache,tree);await size(cache,tree);
  expect(cache.stats.allocationMisses).toBe(1);
  fs.writeFileSync(path.join(tree,"nested/file"),"x".repeat(32_768));callbacks.get(tree)!();
  expect(await size(cache,tree)).toBe(await allocatedBytes(tree));
  await size(cache,tree,new Set(),[],"retention-expired");
  setNow(86_401_000);await size(cache,tree,new Set(),[],"retention-expired");
  setNow(1);await size(cache,tree);
  expect(cache.stats.allocationMisses).toBe(5);
});

test("repeated allocation refreshes keep one live file observer and warm reuse",async()=>{
  const {tree,cache,installed,setNow}=setup({flat:true,bounds:{trees:2,entries:2,bytes:4096,directories:4}});
  const file=path.join(tree,"file");
  const liveObservers=()=>installed.filter(observer=>!observer.closed);
  const liveFileObservers=()=>liveObservers().filter(observer=>observer.path===file);

  await size(cache,tree);
  await size(cache,tree);
  expect(cache.stats.allocationHits).toBe(1);
  expect(liveFileObservers()).toHaveLength(1);

  for(let day=1;day<=5;day++) {
    setNow(day*86_400_000+1_000);
    await size(cache,tree);
    expect(cache.stats.allocationMisses).toBe(day+1);
    expect(liveFileObservers()).toHaveLength(1);
    expect(liveObservers()).toHaveLength(2);
    await size(cache,tree);
    expect(cache.stats.allocationHits).toBe(day+1);
    expect(liveFileObservers()).toHaveLength(1);
    expect(liveObservers()).toHaveLength(2);
  }

  await size(cache,tree,new Set(),[],"changed-context");
  expect(cache.stats.allocationMisses).toBe(7);
  expect(liveFileObservers()).toHaveLength(1);
  expect(liveObservers()).toHaveLength(2);
  await size(cache,tree,new Set(),[],"changed-context");
  expect(cache.stats.allocationHits).toBe(7);
  expect(liveFileObservers()).toHaveLength(1);
  expect(liveObservers()).toHaveLength(2);
});

test("discovery reuse never supplies removal authority and observer failures disable reuse",async()=>{
  const {tree,cache,observers,callbacks}=setup();let calls=0;
  const discover=()=>{calls++;return [path.join(tree,"nested")];};
  cache.candidates(tree,"clock",discover);cache.candidates(tree,"clock",discover);expect(calls).toBe(1);
  callbacks.get(tree)!();cache.candidates(tree,"clock",discover);expect(calls).toBe(2);
  observers.get(tree)!.emit("error",new Error("watch unavailable"));
  cache.candidates(tree,"clock",discover);expect(calls).toBe(3);
});

test("persisted rows are bounded, invalid old owners and corrupt files rebuild",async()=>{
  const {root,tree,file,cache}=setup();await size(cache,tree);cache.persist();
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));expect(saved.rows).toHaveLength(1);
  cache.close();
  fs.writeFileSync(path.join(tree,"nested/file"),"offline".repeat(8192));
  for (const contents of [JSON.stringify(saved),"{broken",JSON.stringify({version:999,rows:[]})]) {
    fs.writeFileSync(file,contents);
    const next=new WorktreeSweepCache(file);caches.push(next);
    expect(await size(next,tree)).toBe(await allocatedBytes(tree));expect(next.stats.allocationHits).toBe(0);next.close();
  }
  for(let i=0;i<=SWEEP_CACHE_TREES;i++) {
    const directory=path.join(root,`row-${i}`);fs.mkdirSync(directory);
    cache.candidates(directory,"clock",()=>[]);
  }
  cache.persist();expect(JSON.parse(fs.readFileSync(file,"utf8")).rows).toHaveLength(SWEEP_CACHE_TREES);
});


test("root replacement reattaches its observer and in-flight changes are not cached",async()=>{
  const {root,tree,cache,callbacks,closed}=setup();await size(cache,tree);
  fs.renameSync(tree,path.join(root,"old-tree"));fs.mkdirSync(path.join(tree,"nested"),{recursive:true});
  fs.writeFileSync(path.join(tree,"nested/new-file"),"replacement");
  const pending=size(cache,tree);callbacks.get(tree)!();await pending;
  expect(closed.has(tree)).toBe(true);
  const misses=cache.stats.allocationMisses;
  await size(cache,tree);expect(cache.stats.allocationMisses).toBe(misses+1);
  expect(await size(cache,tree)).toBe(await allocatedBytes(tree));
  expect(cache.stats.allocationHits).toBe(1);
});

test("entry and serialized-byte bounds evict, while an oversized inventory stays uncached",async()=>{
  const {root,tree}=setup();
  const file=path.join(root,"small-cache.json");
  const cache=new WorktreeSweepCache(file,()=>1_000,fs.watch,{trees:2,entries:4,bytes:1024});caches.push(cache);
  await size(cache,tree);await size(cache,tree);expect(cache.stats.allocationHits).toBe(1);
  const other=path.join(root,"other");fs.mkdirSync(other);
  for(let i=0;i<4;i++)fs.writeFileSync(path.join(other,`f${i}`),"x");
  await size(cache,other);await size(cache,other);
  expect(cache.stats.allocationMisses).toBe(3);
  cache.persist();
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  expect(saved.rows.reduce((sum:number,row:[string,{allocation?:unknown[]}])=>sum+(row[1].allocation?.length??0),0)).toBeLessThanOrEqual(4);
  expect(fs.statSync(file).size).toBeLessThanOrEqual(1024);
});

test("an unavailable observer always measures afresh",async()=>{
  const {root,tree}=setup();
  const watch=(()=>{throw new Error("observer quota");}) as unknown as typeof fs.watch;
  const cache=new WorktreeSweepCache(path.join(root,"cache-off.json"),()=>1_000,watch);caches.push(cache);
  await size(cache,tree);await size(cache,tree);
  expect(cache.stats.allocationHits).toBe(0);expect(cache.stats.allocationMisses).toBe(2);
});


for (const hazard of ["none", "nested-evidence", "live-conversation", "recent-writes"] as const)
  test(`warm discovery retains the final trim guards: ${hazard}`,async()=>{
    const {root,cache}=setup();
    const repository=path.join(root,"repo"), checkout=repository+"-pipeline-fixed";
    fs.mkdirSync(repository);
    const git=async(args:string[],cwd=repository)=>{
      const result=await realGit(["-c","user.name=Fixture","-c",`user.email=${["noreply","example.invalid"].join("@")}`,...args],cwd);
      if(result.code!==0)throw new Error(result.stderr);return result.stdout;
    };
    await git(["init","-q","-b","main"]);
    fs.writeFileSync(path.join(repository,".gitignore"),".next/\n");
    fs.writeFileSync(path.join(repository,"source.ts"),"export {};\n");
    await git(["add","."]);await git(["commit","-q","-m","fixture"]);
    await git(["worktree","add","-q","-b","lane",checkout]);
    const output=path.join(checkout,".next");fs.mkdirSync(output);fs.writeFileSync(path.join(output,"generated.js"),"output");
    let armed=false,reads=0,held=false,recent=false;
    const ports:WorktreeSweepPorts={mode:"dry-run",cache,
      pipelines:[{id:"fixed",state:"completed",repoDir:repository,worktreeDir:checkout,branch:"lane",runs:[]}],
      mergedPullRequests:()=>[],recordResolution:()=>true,
      conversationCwds:()=>held?[checkout]:[],scan:()=>({ownNamespace:null,processes:[]}),
      inspect:(directory,options)=>inspectTree(directory,{...options,stat:file=>{
        const stat=fs.lstatSync(file);stat.mtimeMs=recent?Date.now():1;stat.ctimeMs=1;return stat;
      }}),
      git:async(args,cwd)=>{
        const result=await realGit(args,cwd);
        if(armed&&args[0]==="ls-files"&&args.includes(".next")&&++reads===2){
          if(hazard==="nested-evidence"){
            fs.mkdirSync(path.join(output,".artifacts"));fs.writeFileSync(path.join(output,".artifacts/unique.txt"),"keep");
          }
          if(hazard==="live-conversation")held=true;
          if(hazard==="recent-writes")recent=true;
        }
        return result;
      },
    };
    const warm=await sweepMergedWorktrees(ports);expect(warm.trimmed).toHaveLength(1);
    armed=true;
    const report=await sweepMergedWorktrees({...ports,mode:"on"});
    expect(cache.stats.discoveryHits).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
    expect(report.trimmed).toHaveLength(hazard==="none"?1:0);
    expect(fs.existsSync(output)).toBe(hazard!=="none");
    expect(fs.readFileSync(path.join(checkout,"source.ts"),"utf8")).toBe("export {};\n");
  },20_000);


test("native watch-directory admission refuses partial coverage at the bound",async()=>{
  const {root,tree}=setup();let installed=0;
  const watch=(()=>{installed++;throw new Error("must not install a partial plan");}) as typeof fs.watch;
  const cache=new WorktreeSweepCache(path.join(root,"bounded-watch.json"),()=>1_000,watch,{trees:2,entries:8,bytes:1024,directories:1});caches.push(cache);
  await size(cache,tree);await size(cache,tree);
  expect(installed).toBe(0);expect(cache.stats.allocationHits).toBe(0);
});
