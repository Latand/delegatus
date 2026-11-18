import { afterAll, expect, spyOn, test } from "bun:test";
import dns from "node:dns/promises";
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
    // A target refresh can complete while the request body is being read.
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => ({ ...target, answered_elsewhere: false })) })) }));
    const racing = request({ answered_by: "install" });
    const readBody = racing.json.bind(racing);
    racing.json = async () => {
      const body = await readBody();
      updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => ({ ...target, answered_elsewhere: true })) })) }));
      return body;
    };
    expect((await PATCH(racing, context)).status).toBe(400);
    expect(writes).toEqual([]);
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

for (const confirmTakeover of [undefined, false]) {
  test(`ownership discovered during DNS refuses an unconfirmed move (${confirmTakeover}), continues peer adoption and permits a confirmed move`, async () => {
    const ids = ["clone-1", "clone-2", "clone-3", "clone-4", "clone-5"];
    const writes: { id: string; body: unknown }[] = [];
    const bindings = new Map(ids.map(id => [id, id === "clone-3" ? "other-install" : "service"]));
    const remote = (id: string) => ({ target_id: id, name: id, answered_by: "service" as const, fallback: "service" as const, answered_elsewhere: false });
    const service = await startTestRelay((req, body) => {
      const id = req.url!.split("/").at(-1)!;
      expect(req.method).toBe("PATCH");
      writes.push({ id, body });
      // The v1 service accepts takeovers from any pairing of the owner.
      bindings.set(id, "this-install");
      return { body: { ...remote(id), answered_by: "install" } };
    });
    const origin = "http://127.0.0.1:8899";
    const request = (id: string, confirmed = confirmTakeover) => new NextRequest(`${origin}/api/external-relay/relays/dns-ownership/targets/${id}`, {
      method: "PATCH", headers: { origin, host: "127.0.0.1:8899", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json" },
      body: JSON.stringify({ answered_by: "install", ...(confirmed === undefined ? {} : { confirmTakeover: confirmed }) }),
    });
    updateRelayStore(store => ({ ...store, relays: [{ id: "dns-ownership", origin: service.origin,
      api_base: `${service.origin.replace("127.0.0.1", "relay.test")}/v1`, name: "Relay", description: "", credential: "fixture",
      owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-11-17T12:00:00Z", paused: true,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: ids.map(id => newTargetSettings(remote(id))) }] }));
    let discoverElsewhere = false;
    const resolve = async () => {
      // Refresh records another pairing after the route's initial snapshot.
      if (discoverElsewhere) updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => target.id === "clone-3"
        ? { ...target, answered_elsewhere: true } : target) })) }));
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const lookup = spyOn(dns, "lookup").mockImplementation(resolve as unknown as typeof dns.lookup);
    const context = (targetId: string) => ({ params: Promise.resolve({ id: "dns-ownership", targetId }) });
    try {
      for (const id of ids) {
        discoverElsewhere = id === "clone-3";
        const response = await PATCH(request(id), context(id));
        expect(response.status).toBe(id === "clone-3" ? 400 : 200);
        if (id === "clone-3") expect(await response.json()).toEqual({ error: "refused_here" });
      }
      expect(lookup).toHaveBeenCalledTimes(5);
      expect(writes).toEqual(ids.filter(id => id !== "clone-3").map(id => ({ id, body: { answered_by: "install" } })));
      expect([...bindings.values()]).toEqual(["this-install", "this-install", "other-install", "this-install", "this-install"]);
      expect(readRelayStore().relays[0]!.targets[2]).toMatchObject({ answered_by: "service", answered_elsewhere: true });
      const before = writes.length;
      expect((await PATCH(request("clone-3", true), context("clone-3"))).status).toBe(200);
      expect(writes.slice(before)).toEqual([{ id: "clone-3", body: { answered_by: "install" } }]);
      expect(bindings.get("clone-3")).toBe("this-install");
      expect(readRelayStore().relays[0]!.targets[2]).toMatchObject({ answered_by: "install", answered_elsewhere: false });
    } finally { lookup.mockRestore(); await service.close(); }
  });
}

for (const refusal of ["error", "target", "nested-target"] as const) {
  test(`adopting five clones preserves a competing pairing on one service 409 (${refusal}) and adopts every peer`, async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `clone-${i + 1}`);
    const writes: string[] = [];
    const bindings = new Map(ids.map(id => [id, id === "clone-3" ? "other-install" : "service"]));
    const remote = (id: string) => ({ target_id: id, name: id, answered_by: "service" as const, fallback: "service" as const });
    const service = await startTestRelay((req, body) => {
      const id = req.url!.split("/").at(-1)!;
      expect(req.method).toBe("PATCH");
      expect(body).toEqual({ answered_by: "install" });
      writes.push(id);
      if (id === "clone-3") {
        updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay, targets: relay.targets.map(target => target.id === id
          ? { ...target, name: "Updated clone", fallback: "none", concurrency: 2 } : target) })) }));
        const target = { ...remote(id), answered_elsewhere: true };
        return { status: 409, body: refusal === "error" ? { error: "answered_elsewhere", target_id: id, message: "Release it there first" }
          : refusal === "target" ? target : { target } };
      }
      bindings.set(id, "this-install");
      return { body: { ...remote(id), answered_by: "install" } };
    });
    updateRelayStore(store => ({ ...store, relays: [{ id: "adoption", origin: service.origin, api_base: `${service.origin}/v1`, name: "Relay", description: "", credential: "fixture",
      owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-11-17T12:00:00Z", paused: true,
      limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: ids.map(id => newTargetSettings(remote(id))) }] }));
    try {
      for (const id of ids) {
        const origin = "http://127.0.0.1:8899";
        const req = new NextRequest(`${origin}/api/external-relay/relays/adoption/targets/${id}`, { method: "PATCH", headers: {
          origin, host: "127.0.0.1:8899", cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json",
        }, body: JSON.stringify({ answered_by: "install" }) });
        const result = await PATCH(req, { params: Promise.resolve({ id: "adoption", targetId: id }) });
        expect(result.status).toBe(200);
        expect((await result.json()).target).toMatchObject(id === "clone-3" ? { answered_by: "service", answered_elsewhere: true, name: "Updated clone", fallback: "none" } : { answered_by: "install" });
      }
      expect(readRelayStore().relays[0]!.targets[2]).toMatchObject({ name: "Updated clone", fallback: "none", concurrency: 2 });
      expect(writes).toEqual(ids);
      expect([...bindings.values()]).toEqual(["this-install", "this-install", "other-install", "this-install", "this-install"]);
      expect(readRelayStore().relays[0]!.targets.map(t => [t.answered_by, t.answered_elsewhere === true])).toEqual([
        ["install", false], ["install", false], ["service", true], ["install", false], ["install", false],
      ]);
    } finally { await service.close(); }
  });
}
