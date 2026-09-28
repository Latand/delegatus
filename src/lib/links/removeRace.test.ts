import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import * as peerRoute from "@/app/api/peer/v1/[...path]/route";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { syncPeer, removeConnectedPeer } from "./client";
import { remoteProjects, remoteStore } from "./boardLinks";
import { findPeer, putPeer, revokeGrant, sharedDigest } from "./protocol";
import { readGrants, setShared, sha, writeGrants, type Grant, type Link } from "./state";

for (const status of [503, 401, 200]) {
  test(`a late ${status} sync response cannot restore a removed link`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-remove-race-"));
    const previousState = process.env.LLV_STATE_DIR;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.LLV_STATE_DIR = path.join(root, "state");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    let release!: () => void;
    let seen!: () => void;
    const pending = new Promise<void>((resolve) => { seen = resolve; });
    const peer: Link = { id: randomUUID(), install: randomUUID(), url: "", label: "B", token: "A".repeat(43), grantId: randomUUID(),
      store: randomUUID(), state: "active", lastCall: null, error: null };
    const server = http.createServer((request, response) => {
      request.resume();
      if (request.method === "DELETE") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"removed":true}');
        return;
      }
      release = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 200
          ? { v: 1, store: peer.store, s: sharedDigest([]), need: false }
          : { error: status === 401 ? "unauthorized" : "unavailable" }));
      };
      seen();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    peer.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    putPeer(peer);
    try {
      const inFlight = syncPeer(peer.id);
      await pending;
      await removeConnectedPeer(peer.id);
      expect(findPeer(peer.id)).toBeUndefined();
      release();
      await expect(inFlight).rejects.toMatchObject({ code: "not-found" });
      expect(findPeer(peer.id)).toBeUndefined();
      expect(remoteStore(peer.id)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a grant revoked while the sync body is still arriving answers 401 and writes nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-revoke-race-"));
  const previous = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME, token: process.env.LLV_TOKEN };
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.LLV_TOKEN = "key";
  try {
    const remote = "code.example.test/acme/revoked";
    const localKey = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
    fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [localKey]: remote } }));
    setShared({ v: 1, all: false, projects: [localKey] });
    const token = "T".repeat(43);
    const grant: Grant = { id: randomUUID(), hash: sha(token), install: randomUUID(), label: "A", scopes: ["board:sync"], created: Date.now(),
      lastUsed: null, requests: 0, movedAt: null, flushedAt: null };
    writeGrants({ v: 1, codes: [], grants: [grant] });
    const theirs = [{ key: `repo-${"b".repeat(32)}`, name: "theirs" }];
    const body = JSON.stringify({ v: 1, store: randomUUID(), now: Date.now(), s: sharedDigest(theirs), have: "00000000", shared: theirs, index: 0, total: 1 });
    const context = { params: Promise.resolve({ path: ["boards", "sync"] }) };
    const sync = (stream: ReadableStream<Uint8Array> | string) => peerRoute.POST(new NextRequest("http://127.0.0.1/api/peer/v1/boards/sync", {
      method: "POST", headers: { "content-type": "application/json", "x-delegatus-peer": `${grant.id}.${token}` }, body: stream,
      ...(typeof stream === "string" ? {} : { duplex: "half" }),
    } as ConstructorParameters<typeof NextRequest>[1]), context);

    // The same exchange with the grant intact discloses the shared project and records theirs.
    const granted = await sync(body);
    expect(granted.status).toBe(200);
    expect(await granted.text()).toContain(localKey);
    expect(remoteProjects(grant.id)).toEqual(theirs);

    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const held = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; }, pull() { reading(); } });
    const answer = sync(held);
    await started;
    expect(revokeGrant(grant.id)).toBe(true);
    expect(remoteStore(grant.id)).toBeNull();
    feed.enqueue(new TextEncoder().encode(body));
    feed.close();
    const revoked = await answer;
    expect(revoked.status).toBe(401);
    const text = await revoked.text();
    expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
    expect(text).not.toContain(localKey);
    expect(remoteStore(grant.id)).toBeNull();
    expect(remoteProjects(grant.id)).toEqual([]);
    expect(readGrants().grants).toEqual([]);
  } finally {
    for (const [name, value] of [["LLV_STATE_DIR", previous.state], ["XDG_CONFIG_HOME", previous.config], ["LLV_TOKEN", previous.token]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
