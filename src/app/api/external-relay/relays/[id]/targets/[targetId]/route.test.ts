import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { newTargetSettings, readRelayStore, updateRelayStore } from "@/lib/externalRelay/store";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { PATCH } from "./route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-routing-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("elsewhere takeover requires explicit confirmation and sends exactly one service PATCH without local confirmation fields", async () => {
  const writes: unknown[] = [];
  let fail = false;
  const remote = { target_id: "clone", name: "Clone", answered_by: "service", fallback: "service", answered_elsewhere: true } as const;
  const service = await startTestRelay((req, body) => {
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("/v1/targets/clone");
    writes.push(body);
    return fail ? { status: 503, body: { error: "unavailable" } } : { body: { ...remote, answered_by: "install", answered_elsewhere: false } };
  });
  const origin = "http://127.0.0.1:8899";
  const request = (body: unknown) => new NextRequest(`${origin}/api/external-relay/relays/ownership/targets/clone`, { method: "PATCH",
    headers: { origin, host: "127.0.0.1:8899", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const context = { params: Promise.resolve({ id: "ownership", targetId: "clone" }) };
  updateRelayStore(store => ({ ...store, relays: [{ id: "ownership", origin: service.origin, api_base: `${service.origin}/v1`, name: "Relay", description: "", credential: "fixture",
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-11-17T12:00:00Z", paused: true,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: [newTargetSettings(remote)] }] }));
  try {
    for (const patch of [{ answered_by: "install" }, { answered_by: "install", confirmTakeover: false }, { answered_by: "install", confirmTakeover: "true" }, { answered_by: "install", answered_elsewhere: false, confirmTakeover: true }]) {
      expect((await PATCH(request(patch), context)).status).toBe(400);
      expect(writes).toEqual([]);
    }
    fail = true;
    expect((await PATCH(request({ answered_by: "install", confirmTakeover: true }), context)).status).toBe(409);
    expect(readRelayStore().relays[0]!.targets[0]!.answered_elsewhere).toBe(true);
    fail = false;
    const before = writes.length;
    const response = await PATCH(request({ answered_by: "install", confirmTakeover: true }), context);
    expect(response.status).toBe(200);
    expect(writes.slice(before)).toEqual([{ answered_by: "install" }]);
    expect((await response.json()).target.answered_elsewhere).toBe(false);
    expect(readRelayStore().relays[0]!.targets[0]).toMatchObject({ answered_by: "install", answered_elsewhere: false });
  } finally { await service.close(); }
});
