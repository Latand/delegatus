import { expect, test } from "bun:test";
import { applyEvent, installSnapshot, type RuntimeEnvelope } from "@/components/runtime/runtimeModel";
import { applyBoardDelta, type BoardDelta } from "@/lib/boardDelta";
import { isolationCatalogReplies } from "./composerIsolationCatalog.fixture";
import type { FileEntry } from "@/lib/types";
import { installIsolationStream, isolationCorpus } from "./composerIsolation.fixture";

test("the timing streams update the intended conversations and replay all six envelopes in order", async () => {
  function row(id: string): FileEntry {
    return { path: `/fixture/${id}.jsonl`, name: id, conversationId:id, project:"atlas", title:id,
      root:"claude-projects", engine:"claude", kind:"session", fmt:"claude", parent:null,
      mtime:100, size:20, activity:"live", proc:"running", pid:null, model:null,
      pendingQuestion:null, waitingInput:null } as FileEntry;
  }
  const seat = row("seat"), sibling = row("sibling"), files = [seat, sibling];
  const corpus = isolationCorpus(files, "atlas", seat, sibling);
  let store = installSnapshot({ schemaVersion:1, snapshotSeq:0, retentionFloorSeq:0,
    runtime:{ hostEpoch:1, health:"ready" }, filesRevision:1, sessions:corpus.sessions,
    attentions:[], recentOperations:[], edges:[], flows:[], workflows:[], tasks:[] });
  const envelopes: RuntimeEnvelope[] = [];
  const stream = installIsolationStream(corpus, files,
    { getState: () => ({store, connection:"live", resyncedAt:null, lastEventAt:null, enabled:true, structuredHostsEnabled:true}) },
    envelope => {
      const result = applyEvent(store, envelope);
      if (result.outcome !== "applied") throw Error("invalid fixture envelope: " + result.outcome);
      store = result.store; envelopes.push(envelope);
    }, () => ({}));
  const health = stream.fileProbe("GET",new URLSearchParams("view=storage-health"));
  expect(health?.headers.get("cache-control")).toBe("no-store");
  expect(await health?.json()).toEqual({state:"ok",since:null,freeBytes:1024 ** 3,registryIssues:[]});
  expect(stream.fileProbe("HEAD",new URLSearchParams("project=atlas"))?.status).toBe(204);
  expect(stream.reads).toMatchObject({storageHealth:1,presence:1,catalog:0});
  expect(stream.fileProbe("GET",new URLSearchParams("view=summary"))).toBeUndefined();
  expect(stream.reads.catalog).toBe(1);
  stream.admitCatalog(files);
  expect(stream.census()).toMatchObject({ sessions:1710, projectSessions:1500, otherSessions:210, openId:"seat" });
  expect(files.find(f => f.path === corpus.subagentPath)?.parent).toBe(store.sessions[corpus.missingId]!.artifactPath);
  expect(files.some(f => f.conversationId === corpus.missingId)).toBe(false);
  expect(files.find(f => f.path === corpus.subagentPath)).toMatchObject({ root:"claude-projects", engine:"claude", kind:"subagent" });
  expect(store.sessions[corpus.missingId]?.hostKind).toBe("claude-broker");
  expect(files.find(f => f.migratedTo === sibling.path)?.path).toBe(sibling.path + ".previous");
  for (let i=0; i<6; i++) stream.event("mixed",i);
  expect(envelopes.map(e => e.kind)).toEqual(["turn-started","delta","delta","turn-started","turn-ended","turn-ended"]);
  expect(envelopes.map(e => e.seq)).toEqual([1,2,3,4,5,6]);
  const foreign = envelopes[0]!.scope.id;
  expect(files.find(f => f.conversationId === foreign)?.project).toBe("isolation-other");
  expect(envelopes.map(e => e.scope.id)).toEqual([foreign,foreign,foreign,"sibling",foreign,"sibling"]);
  expect(store.sessions[foreign]!.settledTurnId).toBe("fixture-turn-0");
  expect(store.sessions.sibling!.settledTurnId).toBe("fixture-turn-0");
  const old = files[corpus.foreignFile]!;
  stream.event("catalog",0);
  expect(store.filesRevision).toBe(2);
  expect(files[corpus.foreignFile]!.size).toBe(old.size + 1);
  stream.ownReceipt();
  expect(store.sessions.seat!.recentReceipts[0]?.status).toBe("rejected");
  expect(store.sessions.sibling!.recentReceipts).toHaveLength(0);
});

test("the routed catalog returns 304 and changes one real row across two missed revisions", () => {
  const body = { boardProtocol:2, boardScope:"fixture.global", tasks:[], files:[
    {path:"/fixture/open",size:2,mtime:5}, {path:"/fixture/foreign",size:9,mtime:10},
  ] };
  const wire = isolationCatalogReplies(JSON.stringify(body),"/fixture/foreign",true);
  const first = wire.reply(1);
  const raw = JSON.parse(first.body) as typeof body;
  expect(wire.reply(1,first.headers.etag).status).toBe(304);
  const changed = wire.reply(3,first.headers.etag,true);
  expect(changed.headers["x-llv-files-delta-base"]).toBe(first.headers.etag);
  const deltas = (JSON.parse(changed.body) as { deltas: BoardDelta[] }).deltas;
  expect(deltas).toHaveLength(2);
  const next = deltas.reduce((value,delta) => applyBoardDelta(value,delta) as typeof body, raw);
  expect(next.files[0]).toBe(raw.files[0]);
  expect(next.files[1]).toEqual({path:"/fixture/foreign",size:11,mtime:12});
  expect(next.tasks).toBe(raw.tasks);
  expect(JSON.parse(wire.reply(3,first.headers.etag,false).body)).toEqual(next);
});
