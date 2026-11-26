import { expect, test } from "bun:test";
import { applyEvent, installSnapshot, type RuntimeEnvelope } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";
import { installIsolationStream, isolationCorpus } from "./composerIsolation.fixture";

test("the timing streams update the intended conversations and replay all six envelopes in order", () => {
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
  stream.admitCatalog(files);
  expect(stream.census()).toMatchObject({ sessions:1710, projectSessions:1500, otherSessions:210, openId:"seat" });
  expect(files.find(f => f.path === corpus.subagentPath)?.parent).toBe(store.sessions[corpus.missingId]!.artifactPath);
  expect(files.some(f => f.conversationId === corpus.missingId)).toBe(false);
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
