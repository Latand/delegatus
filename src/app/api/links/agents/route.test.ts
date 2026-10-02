import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { markPeerCall, markGrantSync } from "@/lib/links/protocol";
import { GET } from "./route";
import { writeGrants, writePeers, type Link } from "@/lib/links/state";

// Exercise the real route and disk stores, without the operator's state.
test("agents host metadata preserves sync failure and last success for peers and grants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agents-health-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const install = randomUUID(), grantInstall = randomUUID();
  const peer: Link = { id: randomUUID(), install, label: "Stage", url: "https://stage.example.test", token: "fixture", grantId: randomUUID(), store: randomUUID(), state: "active", lastCall: 1234, error: null };
  try {
    fs.mkdirSync(path.join(root, "links"));
    fs.writeFileSync(path.join(root, "links/self.json"), JSON.stringify({ v: 1, installId: randomUUID() }));
    const read = async () => (await GET(new NextRequest("http://localhost/api/links/agents", { headers: { host: "localhost" } })).json()).hosts;
    for (const state of ["active", "failing", "revoked"] as const) {
      writePeers({ v: 1, peers: [{ ...peer, state }] });
      expect((await read())[install]).toMatchObject(state === "revoked" ? { label: "Stage", linked: false } : { label: "Stage", linked: true, state, lastCall: 1234 });
    }
    for (const syncError of [null, "malformed"]) {
      writeGrants({ v: 1, codes: [], grants: [{ id: randomUUID(), hash: "fixture", install: grantInstall, label: "Machine B", scopes: ["board:sync"], created: 1, lastUsed: 9999, requests: 3, movedAt: null, flushedAt: null, lastCall: 2345, syncError }] });
      expect((await read())[grantInstall]).toMatchObject({ label: "Machine B", linked: true, state: syncError ? "failing" : "active", lastCall: 2345 });
    }
    // A healthy incoming grant must not hide a failing outgoing peer to the
    // same install, and lastUsed must not replace the last sync success.
    writePeers({ v: 1, peers: [{ ...peer, state: "failing" }] });
    writeGrants({ v: 1, codes: [], grants: [{ id: randomUUID(), hash: "fixture", install, label: "Stage", scopes: ["board:sync"], created: 1, lastUsed: 9999, requests: 3, movedAt: null, flushedAt: null, lastCall: 2345, syncError: null }] });
    expect((await read())[install]).toMatchObject({ linked: true, state: "failing", lastCall: 2345 });
    writePeers({ v: 1, peers: [{ ...peer, lastCall: null }] });
    writeGrants({ v: 1, codes: [], grants: [] });
    expect((await read())[install]).toMatchObject({ linked: true, state: "active", lastCall: null });
    markPeerCall(peer.id, 3456);
    expect((await read())[install]).toMatchObject({ state: "active", lastCall: 3456 });
    const grant = { id: randomUUID(), hash: "fixture", install: grantInstall, label: "Machine B", scopes: ["board:sync" as const], created: 1, lastUsed: 9999, requests: 3, movedAt: null, flushedAt: null, lastCall: 2345, syncError: null };
    writeGrants({ v: 1, codes: [], grants: [grant] });
    markGrantSync(grant, null);
    const healthy = (await read())[grantInstall];
    expect(healthy.lastCall).toBeGreaterThan(2345);
    markGrantSync(grant, "malformed");
    expect((await read())[grantInstall]).toMatchObject({ state: "failing", lastCall: healthy.lastCall });

  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
