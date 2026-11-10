import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StageTurnEvidence } from "./durableEvidence";
import type { PipelinePorts } from "./engine";

// Literal-object helpers append to the process's Git configuration. Clear
// launch identity/configuration here as well as in each fixture's subprocess.
const inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
for (const key of Object.keys(inheritedGit)) delete process.env[key];
const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repair-state-"));
process.env.LLV_STATE_DIR = state;
const { defaultPipelinePorts, tickPipelines, patchPipeline } = await import("./engine");
const { savePipelines, findPipelineRecord } = await import("./store");
const { pipelineCorpus } = await import("./fixtures/corpus");
const { realExec } = await import("@/lib/workflows/provision");
const { registerPipelineTick } = await import("./controllerSignal");
const restore = registerPipelineTick(async () => {});
afterAll(() => { restore(); Object.assign(process.env, inheritedGit); fs.rmSync(state, { recursive: true, force: true }); });

function fixture({ emptyAccepted = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repair-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  let workingRepo = repo;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) env[key] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_AUTHOR_DATE: "2026-10-11T04:00:00Z", GIT_COMMITTER_DATE: "2026-10-11T04:00:00Z" });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: workingRepo, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("init", "-q", "--bare", remote);
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const deliveryRemote = "https://github.com/example/widgets.git";
  git("config", `url.${remote}.insteadOf`, deliveryRemote);
  git("remote", "add", "origin", deliveryRemote); git("push", "-q", "origin", "main");
  const lane = pipelineCorpus(2, 1)[1]!;
  git("checkout", "-q", "-b", lane.branch);
  fs.mkdirSync(path.join(repo, "src"));
  if (emptyAccepted) git("commit", "-q", "--allow-empty", "-m", "accepted stage");
  else {
    fs.writeFileSync(path.join(repo, "src/work.ts"), "export const work = 1;\n");
    git("add", "."); git("commit", "-q", "-m", "accepted stage");
  }
  const accepted = git("rev-parse", "HEAD");
  const checkout = `${repo}-pipeline-${lane.id}`;
  git("checkout", "-q", "main"); git("worktree", "add", "-q", checkout, lane.branch); workingRepo = checkout;
  Object.assign(lane, { repoDir: repo, worktreeDir: checkout, baseRef: base, baseBranch: "main", state: "running", closedAt: null,
    stateDetail: null, publication: "remote-branch", lastPassedCommit: accepted, publishedCommit: null,
    cursor: { stageId: "build", state: "committing", input: null, activatedBy: null } });
  lane.stages = [lane.stages[0]!]; lane.stages[0]!.next = null; lane.runs = [lane.runs[0]!];
  const attempt = lane.runs[0]!.attempts[0]!;
  Object.assign(attempt, { state: "passed", verdict: { status: "pass", findings: [] },
    conversationId: "conversation_producer", agentPath: "/codex/producer.jsonl", paneId: null,
    startedAt: "2026-10-11T04:00:00.000Z", completedAt: "2026-10-11T04:01:00.000Z" });
  lane.delivery = { target: { repository: "fixture", remote: deliveryRemote, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([lane]);
  let wall = Date.parse("2026-10-11T04:02:00.000Z");
  let turn: StageTurnEvidence = { turn: "terminal", message: { text: "accepted", ts: wall - 60_000 }, lastRecordAt: wall - 60_000 };
  const requests: Array<{ text: string; clientMessageId: string; conversationId: string }> = [];
  const checkpoints: unknown[] = [];
  let pushes = 0;
  const ports = { ...defaultPipelinePorts(),
    exec: async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") pushes++;
      if (args[0] === "gh") {
        const argv = args[1];
        if (argv[0] !== "pr" || !["list", "view"].includes(argv[1]!)
          || argv[argv.indexOf("--repo") + 1] !== "example/widgets") {
          return { code: 1, stdout: "", stderr: "fixture PR service unavailable" };
        }
        // The verifier reads the head actually published to the bare remote.
        const headRefName = git("symbolic-ref", "--short", "HEAD");
        const headRefOid = git("ls-remote", "origin", `refs/heads/${headRefName}`).split(/\s+/)[0];
        const pr = { number: 17, headRefName, headRefOid, baseRefName: "main", state: "OPEN", isCrossRepository: false };
        return { code: 0, stdout: JSON.stringify(argv[1] === "list" ? [pr] : pr), stderr: "" };
      }
      return realExec(args[0], args[1], args[2], { ...env, ...args[3] }, args[4]);
    },
    now: () => new Date(wall).toISOString(), scheduleTick: () => {},
    durableTurnEvidence: async () => turn, conversationDeliveryOutstanding: () => false,
    conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false,
    stageRepairDelivery: async (_conversationId: string, _clientMessageId: string, deadline: number) => ({ operationId: null,
      state: wall >= deadline ? "failed" as const : "unavailable" as const, safeToReplace: false }),
    getFlow: () => null, worktreePresent: () => true,
    spawnAgent: async () => { throw new Error("this fixture cannot launch a real agent"); },
    resumeSeveredTurn: async (input: { text: string; clientMessageId: string; conversationId: string }) => {
      requests.push(input);
      checkpoints.push(structuredClone(findPipelineRecord(lane.id)!.runs[0]!.attempts[0]));
      turn = { ...turn, turn: "busy" };
      return true;
    },
  };
  return { root, repo: checkout, git, lane, accepted, base, requests, checkpoints, ports,
    hook: path.join(repo, ".git/hooks/pre-push"), pushes: () => pushes,
    current: () => findPipelineRecord(lane.id)!,
    tick: async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); },
    endTurn: (text = "repaired") => { wall += 1_000; turn = { turn: "terminal", message: { text, ts: wall }, lastRecordAt: wall }; },
    advance: (ms: number) => { wall += ms; },
    cleanup: () => { savePipelines([]); fs.rmSync(root, { recursive: true, force: true }); } };
}


test.each([
 { label: "pending attention", host: "hosted", turn: "running", attentionIds: ["permission-1"] },
 { label: "conflicting host", host: "conflict", turn: "idle", attentionIds: [] },
])("retry treats fresh $label evidence conservatively", async fresh => {
 const h=fixture();
 const { RuntimeJournal }=await import("@/runtime-host/journal");
 const { RuntimeHost }=await import("@/runtime-host/host");
 const { serveRuntimeHost }=await import("@/runtime-host/socket");
 const { once }=await import("node:events");
 const journal=new RuntimeJournal(path.join(h.root,"recovery.sqlite"));
 const host=new RuntimeHost(journal);
 const socketDirectory=fs.openSync(h.root,"r");
 const previous=process.env.LLV_RUNTIME_HOST_SOCKET;
 let server:ReturnType<typeof serveRuntimeHost>|undefined;
 try {
  fs.writeFileSync(h.hook,"#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n",{mode:0o700});
  h.ports.resumeSeveredTurn=async()=>false;
  await h.tick(); h.advance(21*60_000); await h.tick();
  expect(h.current().state).toBe("needs_decision");
  const socket=`/proc/${process.pid}/fd/${socketDirectory}/runtime.sock`; process.env.LLV_RUNTIME_HOST_SOCKET=socket;
  server=serveRuntimeHost(socket,{handle:request=>host.handle(request)}); await once(server,"listening");
  const publish=(state:"dead"|"hosted"|"conflict", turn?:"running"|"idle", attentionIds:readonly string[]=[])=>journal.append({scope:{type:"session",id:"conversation_producer"},kind:"session-status",payload:{
   conversationId:"conversation_producer",sessionKey:{engine:"codex",sessionId:"repair-owner"},hostKind:"codex-app-server",
   host:state,turn:turn??(state==="hosted"?"running":"idle"),attentionIds:[...attentionIds],activeTurnId:state==="hosted"?"repair-running":null,
  }});
  publish("dead");
  const native=defaultPipelinePorts();
  const ports = h.ports as PipelinePorts;
  const proof:boolean[]=[];
  ports.conversationAgentActive=native.conversationAgentActive;
  ports.conversationTurnInterrupted=native.conversationTurnInterrupted;
  ports.publicationRepairProducerGone=async id=>{const answer=await native.publicationRepairProducerGone!(id); proof.push(answer as boolean);return answer;};
  ports.stageRepairDelivery=async()=>({operationId:"uncertain-repair",state:"failed",safeToReplace:false});
  ports.conversationDeliveryOutstanding=()=>false;
  ports.durableTurnEvidence=async()=>{
   publish(fresh.host as "hosted"|"conflict",fresh.turn as "running"|"idle",fresh.attentionIds);
   return {turn:"terminal",message:{text:"accepted",ts:Date.parse("2026-10-11T04:01:00Z")}};
  };
  const {patchPipeline}=await import("./engine");
  await patchPipeline(h.lane.id,{action:"retry-stage"},ports);
  expect(proof.every(gone=>gone!==true)).toBe(true);
  expect(journal.readSession({conversationId:"conversation_producer"})).toMatchObject({host:fresh.host,turn:fresh.turn,attentionIds:fresh.attentionIds});
  expect(h.current().runs[0]!.attempts).toHaveLength(1);
 } finally {
  if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
  if(previous===undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET=previous;
  fs.closeSync(socketDirectory);journal.close();h.cleanup();
 }
});


test.each([
 { receipt: "delivered", now: "2026-10-11T04:23:00.000Z" },
 { receipt: "failed", now: "2026-10-11T04:23:00.000Z" },
 { receipt: "delivered", now: "2027-10-11T04:23:00.000Z" },
 { receipt: "failed", now: "2027-10-11T04:23:00.000Z" },
])("an expired $receipt repair retries behind held work at $now after producer death", async ({ receipt, now }) => {
 const h=fixture();
 const {AgentRegistry,setAgentRegistryForTests}=await import("@/lib/agent/registry");
 const {emptyLaunchProfile}=await import("@/lib/accounts/migration/contracts");
 const {RuntimeJournal}=await import("@/runtime-host/journal");
 const {RuntimeHost}=await import("@/runtime-host/host");
 const {serveRuntimeHost}=await import("@/runtime-host/socket");
 const {once}=await import("node:events");
 const file=path.join(h.root,"registry.json");
 const registry=new AgentRegistry(file);
 const ports = h.ports as PipelinePorts;
 const conversation=registry.ensureForkedConversation("codex",path.join(h.root,"producer.jsonl"),"fixture-account",emptyLaunchProfile({cwd:h.repo}));
 registry.requestConversationReseat(conversation.id,"successor-account");
 const held=registry.holdDelivery(conversation.id,"earlier message","earlier-message","text",[],null,{operationId:"older-message-operation",kind:"send",policy:"queue"});
 expect(held.state).toBe("held");
 const lane=h.current();lane.runs[0]!.attempts[0]!.conversationId=conversation.id;savePipelines([lane]);
 setAgentRegistryForTests(registry);
 const production=defaultPipelinePorts();
 ports.conversationDeliveryOutstanding=production.conversationDeliveryOutstanding;
 ports.stageRepairDelivery=production.stageRepairDelivery;
 const journal=new RuntimeJournal(path.join(h.root,"dead-runtime.sqlite"));
 const host=new RuntimeHost(journal);
 const socketDirectory=fs.openSync(h.root,"r");
 const previous=process.env.LLV_RUNTIME_HOST_SOCKET;
 let server:ReturnType<typeof serveRuntimeHost>|undefined;
 try {
  fs.writeFileSync(h.hook,"#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n",{mode:0o700});
  await h.tick();h.advance(21*60_000);await h.tick();
  expect(h.current().state).toBe("needs_decision");
  expect(h.current().runs[0]!.attempts[0]!.publicationRepair?.delivery?.safeToReplace).toBe(true);
  const persisted = h.current();
  persisted.runs[0]!.attempts[0]!.publicationRepair!.delivery = {
   operationId:"terminal-repair-operation",state:receipt,safeToReplace:false,
  };
  savePipelines([persisted]);
  const override = await patchPipeline(h.lane.id, { action: "override-stage", stageId: "build",
   ["prompt"]: "Use the current stage instruction to repair the refusal." }, h.ports);
  expect(override.error).toBeUndefined();
  const socket=`/proc/${process.pid}/fd/${socketDirectory}/dead.sock`; process.env.LLV_RUNTIME_HOST_SOCKET=socket;
  server=serveRuntimeHost(socket,{handle:request=>host.handle(request)});await once(server,"listening");
  journal.append({scope:{type:"session",id:conversation.id},kind:"session-status",payload:{
   conversationId:conversation.id,sessionKey:{engine:"codex",sessionId:"dead-owner"},hostKind:"codex-app-server",host:"dead",turn:"idle",attentionIds:[],
  }});
  const child=Bun.spawn([process.execPath,"-e",`
   const {AgentRegistry,setAgentRegistryForTests}=await import("./src/lib/agent/registry");
   const registry=new AgentRegistry(${JSON.stringify(file)});setAgentRegistryForTests(registry);
   const {defaultPipelinePorts,patchPipeline}=await import("./src/lib/pipelines/engine");
   const {findPipelineRecord}=await import("./src/lib/pipelines/store");
   const ports={...defaultPipelinePorts(),now:()=>${JSON.stringify(now)},durableTurnEvidence:async()=>null,
    stageRepairDelivery:async()=>({operationId:"terminal-repair-operation",state:${JSON.stringify(receipt)},safeToReplace:false})};
   const gone=await ports.publicationRepairProducerGone(${JSON.stringify(conversation.id)});
   const answer=await patchPipeline(${JSON.stringify(h.lane.id)},{action:"retry-stage"},ports);
   const lane=findPipelineRecord(${JSON.stringify(h.lane.id)});
   console.log(JSON.stringify({gone,status:answer.status??200,error:answer.error,attempts:lane.runs[0].attempts.length,
    cursor:lane.cursor,input:lane.cursor.input,prompt:lane.stages[0].prompt,lastPassedCommit:lane.lastPassedCommit}));
   registry.close();
  `],{cwd:process.cwd(),env:process.env,stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);
  const result=JSON.parse(out);
  expect(result.gone).toBe(true);
  expect(result).toMatchObject({ status: 200, attempts: 2, prompt: "Use the current stage instruction to repair the refusal." });
  expect(result.error).toBeUndefined();
  expect(result.input).toContain("pre-push: eslint");
  expect(h.current().runs[0]!.attempts).toHaveLength(2);
  expect(h.current().cursor).toMatchObject({ stageId: "build", state: "pending" });
  expect(h.current().lastPassedCommit).toBe(h.accepted);
  expect(registry.pendingDeliveries(conversation.id)).toContainEqual(expect.objectContaining({
   clientMessageId:"earlier-message",state:"held",text:"earlier message",
  }));
 } finally {
  if(server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
  if(previous===undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;else process.env.LLV_RUNTIME_HOST_SOCKET=previous;
  setAgentRegistryForTests(null);fs.closeSync(socketDirectory);journal.close();registry.close();h.cleanup();
 }
});
