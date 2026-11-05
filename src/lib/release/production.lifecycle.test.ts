import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as runModule from "./run";
import { ready } from "./policy.fixture";
import { releaseState } from "./policy";
import { releaseControllerForSources } from "./production";
import { releaseStages, releasePublishStages } from "./stages";
import { mutateReleaseProject, readReleaseProject } from "./store";
import { normalizeStages } from "@/lib/pipelines/engine";
import { pipelineRoleLookup } from "@/lib/pipelines/roles";
import { buildPipeline } from "@/lib/pipelines/store";
import { resetAutoMergeForTests, sweepAutoMerge, type AutoMergePorts } from "@/lib/forge/autoMerge";
import { defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { CreatePipelineRequest, Pipeline } from "@/lib/pipelines/types";

const project = "release-lifecycle", at = "2026-11-01T00:00:00Z", head = "b".repeat(40);
const brief = { cut: "a".repeat(40), lastTag: "v1.0.0", changes: [], askBeforePublish: true };
let directory: string;
const originalState = process.env.LLV_STATE_DIR;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-lifecycle-"));
  process.env.LLV_STATE_DIR = directory;
  resetAutoMergeForTests();
});
afterEach(() => {
  process.env.LLV_STATE_DIR = originalState;
  resetAutoMergeForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});
function lane(id: string, publish = false): Pipeline {
  const normalized = normalizeStages(publish ? releasePublishStages({ ...brief, commit: head, pr: 7 }) : releaseStages(brief), pipelineRoleLookup);
  expect(normalized.error).toBeUndefined();
  const row = buildPipeline({ id, task: publish ? "Реліз Delegatus: публікація" : "Реліз Delegatus", project,
    repoDir: process.cwd(), stages: normalized.stages!, srcPath: null, srcConversationId: null, now: at });
  return Object.assign(row, { state: "completed" as const, lastPassedCommit: head, baseRef: head, closedAt: at });
}
function merge(state: NonNullable<Pipeline["merge"]>["state"]): NonNullable<Pipeline["merge"]> {
  return { state, by: "auto-merge", repository: "example/release", prNumber: 7, policyChangedAt: at,
    reviewedHead: head, chain: [head], updates: [], seenChecks: [], head, headSeenAt: at, lastChecks: [], readAt: at,
    nextReadAt: null, requestedAt: at, mergedHead: state === "merged" ? head : null, mergeCommit: state === "merged" ? head : null,
    method: "squash", mergedAt: state === "merged" ? at : null, attempts: 1, reason: null, blockedAt: null, updatedAt: at };
}
function capture(sources: Partial<SeatTickSources>) {
  let ports!: runModule.ReleasePorts;
  const real = runModule.productionReleaseController;
  const spy = spyOn(runModule, "productionReleaseController").mockImplementation(value => { ports = value; return real(value); });
  try { return { controller: releaseControllerForSources(sources as SeatTickSources), get ports() { return ports; } }; }
  finally { spy.mockRestore(); }
}
function fixture() {
  const parent = lane("release-parent"), child = lane("refresh-child");
  for (const [row, epoch] of [[parent, 1], [child, 2]] as const) {
    row.delivery = { target: { repository: project, remote: "fixture", branch: "refs/heads/release", pr: 7 },
      disposition: "owner", publish: "enabled", active: false, ownerId: row.id, epoch, journal: [] };
  }
  parent.merge = { ...merge("refreshing"), refresh: { attempt: 1, base: head, head, key: "refresh", digest: "d", requestedAt: at, pipelineId: child.id } };
  child.refreshOf = { pipelineId: parent.id, base: head }; child.merge = merge("merged");
  const rows = [parent, child];
  const sources = { now: () => Date.parse(at), pipelines: () => rows, archivedPipelines: () => [], settings: () => defaultSeatTickSettings(project) };
  const adapter = capture(sources);
  const requests: CreatePipelineRequest[] = [];
  adapter.ports.settings = () => ({ enabled: true, askBeforePublish: true, minChanges: 30, minGapHours: 12,
    updatedAt: at, setBy: { kind: "gateway", project, conversationId: null, seatEpoch: null }, why: null });
  adapter.ports.observe = async () => ({ policy: { ...ready(), mainVersion: "1.1.0", deployments: [{ revision: brief.cut, at: 0 }] }, repoDir: process.cwd(), src: "seat" });
  adapter.ports.create = async request => { requests.push(request); return "publisher"; };
  mutateReleaseProject(project, row => ({ ...row, live: { key: "release-key", cut: brief.cut, lastTag: brief.lastTag,
    trigger: "amount", startedAt: 0, taskId: "task", pipelineId: parent.id,
    request: { task: parent.task, repoDir: parent.repoDir, src: "seat", baseBranch: "main", publication: "remote-branch", stages: releaseStages(brief) } } }));
  return { parent, child, rows, sources, ...adapter, requests };
}

test("a release follows its merged refresh delivery owner", async () => {
  const h = fixture();
  await sweepAutoMerge({ now: () => Date.parse(at), loadPipelines: () => h.rows,
    mutate: async (id, change) => change(h.rows.find(row => row.id === id)!),
    setting: () => ({ enabled: true, changedAt: at, changedBy: "fixture" }),
    pullRequestOf: () => ({ repository: "example/release", number: 7 }), cachedState: () => "merged",
    run: async () => { throw Error("unexpected forge read"); }, write: async () => { throw Error("unexpected write"); },
  } as AutoMergePorts);
  expect(h.parent.merge!.state).toBe("cancelled");
  expect(h.child.merge!.state).toBe("merged");
  await h.controller.reconcile(project);
  expect(readReleaseProject(project).live).toMatchObject({ phase: "publish", pipelineId: "publisher" });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0].baseRef).toBe(head);
});

test.each(["open", "different-pr", "different-target", "different-project", "comparison", "wrong-owner", "same-epoch", "closed", "no-merge", "missing-commit"])(
  "%s successor cannot authorize publication", async barrier => {
    const h = fixture();
    if (barrier === "open") h.child.merge = merge("waiting-checks");
    if (barrier === "different-pr") { h.child.delivery!.target.pr = 8; h.child.merge!.prNumber = 8; }
    if (barrier === "different-target") { h.child.delivery!.target.repository = "other"; h.child.merge!.repository = "example/other"; }
    if (barrier === "different-project") h.child.project = "other";
    if (barrier === "comparison") h.child.delivery!.disposition = "comparison";
    if (barrier === "wrong-owner") h.child.delivery!.ownerId = "other";
    if (barrier === "same-epoch") h.child.delivery!.epoch = 1;
    if (barrier === "closed") h.child.state = "closed";
    if (barrier === "no-merge") h.child.merge = undefined;
    if (barrier === "missing-commit") h.child.merge!.mergeCommit = null;
    await h.controller.reconcile(project);
    expect(h.requests).toEqual([]);
    expect(readReleaseProject(project).live?.phase).toBeUndefined();
  });

// Retain the reviewer's real adapter observation, with local CLI/registry fixtures.
async function observe(rows: Pipeline[], archived: Pipeline[] = []) {
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin, { recursive: true });
  const priorPath = process.env.PATH, priorFetch = globalThis.fetch;
  let archiveReads = 0;
  const script = `#!${process.execPath}\nconst tool=process.argv[1].split('/').at(-1),a=process.argv.slice(2);let out='';
if(tool==='git'){if(a[0]==='for-each-ref')out='v1.0.0 1793318400';else if(a[0]==='rev-parse')out='${head}';else if(a[0]==='show')out=JSON.stringify({name:'package-example',version:'1.0.0'});}
if(tool==='gh'){if(a[0]==='repo')out='example/release';else if(a[1]?.includes('/branches/'))out=JSON.stringify({protection:{required_status_checks:{contexts:[]}}});else if(a[1]?.includes('/check-runs'))out=JSON.stringify({check_runs:[]});else out=JSON.stringify({statuses:[]});}
if(tool==='bun')out=JSON.stringify({missing:[],chrome:'/fixture/chrome'});console.log(out);`;
  try {
    for (const name of ["git", "gh", "bun"]) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
    process.env.PATH = bin + path.delimiter + priorPath;
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })) as unknown as typeof fetch;
    const { ports } = capture({ now: () => Date.parse(at), pipelines: () => rows, archivedPipelines: () => { archiveReads++; return archived; },
      settings: () => defaultSeatTickSettings(project), seatFor: () => ({ active: { conversationId: "seat" } }),
      registry: () => ({ conversation: () => ({ generations: [{ path: "fixture-seat" }] }) }),
    } as unknown as Partial<SeatTickSources>);
    return { ...await ports.observe(project), archiveReads };
  } finally { process.env.PATH = priorPath; globalThis.fetch = priorFetch; }
}
test("a successful publish lane ceases to block future releases", async () => {
  const { policy, archiveReads } = await observe([lane("completed-publish", true)], Array.from({ length: 256 }, (_, i) => lane(`cold-${i}`)));
  expect(policy.live).toBe(false);
  expect(archiveReads).toBe(0);
  expect(await releaseState({ ...ready(), live: policy.live })).toMatchObject({ state: "due" });
});
test.each(["running", "needs_decision", "preparing", "legacy"])("%s release still blocks another release", async state => {
  const row = lane("blocking", state !== "preparing");
  if (state === "running" || state === "needs_decision") row.state = state;
  if (state === "legacy") row.stages.unshift(lane("prepare").stages[0]);
  const { policy } = await observe([row]);
  expect(policy.live).toBe(true);
  expect(await releaseState({ ...ready(), requested: true, live: policy.live })).toMatchObject({ reason: "release-in-flight" });
});
test.each([false, true])("merged successor is excluded from in-flight, archived=%s", async archived => {
  const h = fixture();
  const observed = await observe(archived ? [h.parent] : h.rows, archived ? [h.child] : []);
  expect(observed.policy.live).toBe(false);
  expect(observed.archiveReads).toBe(1);
  h.child.merge = merge("waiting-checks");
  expect((await observe(h.rows)).policy.live).toBe(true);
});

test("a lost successor handoff receipt recovers one real publish lane across process restarts", async () => {
  const h = fixture();
  const fixturePath = path.join(directory, "lanes.json");
  fs.writeFileSync(fixturePath, JSON.stringify(h.rows));
  const script = `
    const fs = await import("node:fs");
    const rows = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
    const {spyOn} = await import("bun:test");
    const run = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    const {releaseControllerForSources, createReleasePipeline} = await import(${JSON.stringify(new URL("./production.ts", import.meta.url).href)});
    const {createPipelineFromRequest} = await import(${JSON.stringify(new URL("../pipelines/engine.ts", import.meta.url).href)});
    const {pipelineRoleLookup} = await import(${JSON.stringify(new URL("../pipelines/roles.ts", import.meta.url).href)});
    const {loadPipelines} = await import(${JSON.stringify(new URL("../pipelines/store.ts", import.meta.url).href)});
    const {readReleaseProject} = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const project = ${JSON.stringify(project)}, at = ${JSON.stringify(at)};
    let ports;
    const real = run.productionReleaseController;
    const spy = spyOn(run, "productionReleaseController").mockImplementation(value => {ports=value; return real(value);});
    const controller = releaseControllerForSources({now:()=>Date.parse(at), settings:()=>({release:{enabled:true,askBeforePublish:true}}),
      pipelines:()=>[...rows, ...loadPipelines()], archivedPipelines:()=>[]});
    spy.mockRestore();
    ports.observe = async()=>({policy:{...${JSON.stringify({ ...ready(), mainVersion: "1.1.0", deployments: [{ revision: brief.cut, at: 0 }] })},isAncestor:()=>true},repoDir:process.cwd(),src:"seat"});
    const enginePorts = {roleLookup:pipelineRoleLookup,projectForCwd:()=>project,sourcePathAllowed:()=>true,conversationIdForPath:()=>"creator",now:()=>at,
      preflightRepo:async()=>({ok:true,repoDir:process.cwd(),gitCommonDir:process.cwd()+"/.git",worktreeParent:process.cwd()}),
      exec:async(_file,args)=>{
        if(args.length===1&&args[0]==="remote")return {code:0,stdout:"origin\\n",stderr:""};
        if(args[0]==="-c"&&args[2]==="remote"&&args[3]==="-v"){
          const probe=/^remote\\.([^=]+)\\.url=(.*)$/.exec(args[1]);
          if(probe)return {code:0,stdout:probe[1]+"\\t"+probe[2]+" (fetch)\\n"+probe[1]+"\\t"+probe[2]+" (push)\\n",stderr:""};
        }
        return {code:0,stdout:args[0]==="rev-parse"?${JSON.stringify(head)}:process.cwd()+"/fixture.git",stderr:""};
      }};
    let creates=0,error=null;
    ports.create=async(request,key)=>{creates++;const id=await createReleasePipeline(request,key,(req,_p,options)=>createPipelineFromRequest(req,enginePorts,options));
      if(process.argv[2]==="lose")throw new Error("lost receipt");return id;};
    try{await controller.reconcile(project);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,creates,row:readReleaseProject(project),lanes:loadPipelines().map(p=>({id:p.id,baseRef:p.baseRef,creationRequest:p.creationRequest}))}));
  `;
  const scriptPath = path.join(directory, "restart.ts");
  fs.writeFileSync(scriptPath, script);
  const restart = async (mode: string) => JSON.parse((await promisify(execFile)(process.execPath, [scriptPath, mode],
    { env: { ...process.env }, timeout: 30_000 })).stdout);
  const lost = await restart("lose");
  expect(lost.error).toBe("lost receipt");
  expect(lost.creates).toBe(1);
  expect(lost.lanes).toHaveLength(1);
  expect(lost.row.live).toMatchObject({ phase: "publish", pipelineId: null });
  for (const mode of ["recover", "again"]) {
    const next = await restart(mode);
    expect(next.error).toBeNull(); expect(next.creates).toBe(0);
    expect(next.lanes).toEqual(lost.lanes);
    expect(next.lanes[0]).toMatchObject({ baseRef: head, creationRequest: { key: "release-key:publish" } });
    expect(next.row.live).toMatchObject({ phase: "publish", pipelineId: lost.lanes[0].id });
  }
});
