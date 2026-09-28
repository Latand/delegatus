import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { syncPeer, removeConnectedPeer } from "./client";
import { remoteStore } from "./boardLinks";
import { findPeer, putPeer, sharedDigest } from "./protocol";
import type { Link } from "./state";

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
