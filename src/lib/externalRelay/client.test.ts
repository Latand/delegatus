import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverRelay,
  ExternalRelayError,
  fetchRelayTargets,
  relayCall,
} from "./client";
import {
  startRelayPairing,
  checkRelayPairing,
  confirmRelayPairing,
} from "./pairing";
import { readRelayStore } from "./store";
import { startTestRelay } from "./testRelay";
const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-client-state-"));
process.env.LLV_STATE_DIR = state;
afterEach(() => {
  fs.rmSync(path.join(state, "external-relay"), {
    recursive: true,
    force: true,
  });
});
const secret = "a".repeat(43);
const owner = {
  namespace: "test",
  id: "owner_1",
  display_name: "Owner",
  handle: "@owner",
};
const target = {
  target_id: "target_1",
  name: "Helper",
  answered_by: "service" as const,
  fallback: "service" as const,
};
function descriptor(origin: string) {
  return {
    protocol: "delegatus-relay",
    versions: [1],
    name: "Test relay",
    description: "Test",
    api_base: `${origin}/v1`,
    kinds: ["answer"],
    liveness: {
      poll_freshness_s: 60,
      claim_window_s: 5,
      ack_window_s: 10,
      heartbeat_interval_s: 10,
      stall_window_s: 45,
    },
    limits: {
      max_response_bytes: 1048576,
      max_wait_s: 25,
      max_answer_chars: 4000,
    },
  };
}
test("pairing confirms the identity shown locally and stores credential privately", async () => {
  let origin = "";
  const server = await startTestRelay((req) => {
    if (req.url === "/.well-known/delegatus-relay.json")
      return { body: descriptor(origin) };
    if (req.url === "/v1/pairings" && req.method === "POST")
      return {
        status: 201,
        body: {
          pairing_id: "pair_1",
          poll_secret: secret,
          code: "1234-5678",
          verify_url: null,
          expires_at: "2099-09-28T12:10:00Z",
          poll_interval_s: 2,
        },
      };
    if (req.url === "/v1/pairings/pair_1" && req.method === "GET")
      return { body: { status: "awaiting_install", owner, targets: [target] } };
    if (req.url === "/v1/pairings/pair_1/confirm")
      return {
        body: { credential: secret, version: 1, owner, targets: [target] },
      };
    return {
      status: 404,
      body: { error: { code: "not_found", message: "missing" } },
    };
  });
  origin = server.origin;
  try {
    const pending = await startRelayPairing(origin);
    expect(JSON.stringify(pending)).not.toContain("poll_secret");
    expect((await checkRelayPairing(pending.id)).owner?.id).toBe(owner.id);
    await expect(
      confirmRelayPairing(pending.id, "other"),
    ).rejects.toMatchObject({ code: "owner_changed" });
    const relay = await confirmRelayPairing(pending.id, owner.id);
    expect(JSON.stringify(relay)).not.toContain("credential");
    expect(readRelayStore().relays[0]?.credential).toBe(secret);
    expect(
      fs.statSync(path.join(state, "external-relay", "relays.json")).mode &
        0o777,
    ).toBe(0o600);
  } finally {
    await server.close();
  }
});
test("descriptor refuses cross origin and public HTTP", async () => {
  let origin = "";
  const server = await startTestRelay(() => ({
    body: { ...descriptor(origin), api_base: "https://other.example/v1" },
  }));
  origin = server.origin;
  try {
    await expect(discoverRelay(origin)).rejects.toMatchObject({
      code: "cross_origin",
    });
    await expect(discoverRelay("http://example.com/")).rejects.toBeInstanceOf(
      ExternalRelayError,
    );
  } finally {
    await server.close();
  }
});

test("F4 discovery features are retained through pending pairing and confirmation", async () => {
  const features = ["requester_context", "relay_tool_calls", "relay_tool_actions", "relay_owner_tools"];
  const server = await startTestRelay((req) => {
    if (req.url === "/.well-known/delegatus-relay.json") return { body: { ...descriptor(server.origin), features } };
    if (req.url === "/v1/pairings") return { status: 201, body: { pairing_id: "pair_features", poll_secret: secret,
      code: "1234-5678", verify_url: null, expires_at: "2099-09-28T12:10:00Z", poll_interval_s: 2 } };
    if (req.url?.endsWith("/confirm")) return { body: { credential: secret, version: 1, owner, targets: [target] } };
    return { body: { status: "awaiting_install", owner, targets: [target] } };
  });
  try {
    const pending = await startRelayPairing(server.origin);
    expect(readRelayStore().pending[0]!.features).toEqual(features);
    await checkRelayPairing(pending.id);
    await confirmRelayPairing(pending.id, owner.id);
    expect(readRelayStore().relays[0]!.features).toEqual(features);
  } finally { await server.close(); }
});
test("a prefixed API pairs and carries claims and heartbeats under its prefix", async () => {
  let origin = "";
  const paths: string[] = [];
  const server = await startTestRelay((req) => {
    paths.push(req.url ?? "");
    if (req.url === "/.well-known/delegatus-relay.json")
      return { body: { ...descriptor(origin), api_base: `${origin}/relay/v1` } };
    if (req.url === "/relay/v1/pairings")
      return { status: 201, body: {
        pairing_id: "prefixed", poll_secret: secret, code: "1234-5678",
        verify_url: null, expires_at: "2099-09-28T12:10:00Z", poll_interval_s: 2,
      } };
    if (req.url === "/relay/v1/requests/claim") return { status: 204 };
    if (req.url === "/relay/v1/requests/request_1/heartbeat")
      return { body: { status: "ok" } };
    return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
  });
  origin = server.origin;
  try {
    const pending = await startRelayPairing(origin);
    expect(pending.api_base).toBe(`${origin}/relay/v1`);
    await relayCall(pending.api_base, "/requests/claim", "POST", { wait_s: 0 });
    await relayCall(pending.api_base, "/requests/request_1/heartbeat", "POST", {
      lease_id: "lease_1", seq: 1, progress: null,
    });
    expect(paths).toContain("/relay/v1/pairings");
    expect(paths).toContain("/relay/v1/requests/claim");
    expect(paths).toContain("/relay/v1/requests/request_1/heartbeat");
  } finally {
    await server.close();
  }
});
test("descriptor reports a same-origin API path mismatch separately", async () => {
  let origin = "";
  let suffix = "/relay/v2";
  const server = await startTestRelay(() => ({
    body: { ...descriptor(origin), api_base: `${origin}${suffix}` },
  }));
  origin = server.origin;
  try {
    for (const [path, code] of [
      ["/relay/v2", "invalid_api_path"],
      ["/relay/v1?query=1", "invalid_address"],
      ["/relay/v1#fragment", "invalid_address"],
    ]) {
      suffix = path;
      await expect(discoverRelay(origin)).rejects.toMatchObject({ code });
    }
  } finally {
    await server.close();
  }
});
test("claim 204, redirect and oversized body", async () => {
  const server = await startTestRelay((req) =>
    req.url === "/v1/requests/claim"
      ? { status: 204 }
      : req.url === "/v1/redirect"
        ? { status: 302, headers: { location: "https://other.example/" } }
        : { body: { data: "x".repeat(1_048_576) } },
  );
  try {
    expect(
      (
        await relayCall(`${server.origin}/v1`, "/requests/claim", "POST", {
          wait_s: 0,
        })
      ).status,
    ).toBe(204);
    await expect(
      relayCall(`${server.origin}/v1`, "/redirect", "GET"),
    ).rejects.toMatchObject({ code: "unreachable" });
    await expect(
      relayCall(`${server.origin}/v1`, "/large", "GET"),
    ).rejects.toMatchObject({ code: "too_large" });
  } finally {
    await server.close();
  }
});
const limits = {
  max_response_bytes: 1048576,
  max_wait_s: 25,
  max_answer_chars: 4000,
};
test("targets are read with the credential and refused when the body fails the schema", async () => {
  let reply: { status?: number; body?: unknown; drop?: boolean } = {
    body: { targets: [target], extra: true },
  };
  const seen: { url?: string; method?: string; auth?: string }[] = [];
  const server = await startTestRelay((req) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    return reply;
  });
  const relay = { api_base: `${server.origin}/v1`, credential: secret, limits };
  try {
    expect(await fetchRelayTargets(relay)).toEqual([target]);
    expect(seen).toEqual([
      { url: "/v1/targets", method: "GET", auth: `Bearer ${secret}` },
    ]);
    for (const body of [
      { targets: [{ ...target, answered_by: "someone" }] },
      { targets: [target, { ...target, name: "Twice" }] },
      { targets: [{ ...target, name: "bad\u0007name" }] },
      { items: [target] },
      null,
    ]) {
      reply = { body };
      await expect(fetchRelayTargets(relay)).rejects.toMatchObject({
        code: "malformed",
      });
    }
    reply = { status: 204 };
    await expect(fetchRelayTargets(relay)).rejects.toMatchObject({
      code: "malformed",
    });
    reply = {
      status: 401,
      body: { error: { code: "unauthorized", message: "revoked" } },
    };
    await expect(fetchRelayTargets(relay)).rejects.toMatchObject({
      status: 401,
    });
    reply = { status: 503 };
    await expect(fetchRelayTargets(relay)).rejects.toMatchObject({
      code: "unreachable",
      status: 503,
    });
  } finally {
    await server.close();
  }
  // Nothing listens any more: a network error, never an empty list.
  await expect(fetchRelayTargets(relay)).rejects.toBeDefined();
});
test("a confirm that lists no targets reads them once from the service", async () => {
  let origin = "";
  let listed: unknown[] = [];
  let targetReads = 0;
  const server = await startTestRelay((req) => {
    if (req.url === "/.well-known/delegatus-relay.json")
      return { body: descriptor(origin) };
    if (req.url === "/v1/pairings" && req.method === "POST")
      return {
        status: 201,
        body: {
          pairing_id: "pair_2", poll_secret: secret, code: "1234-5678",
          verify_url: null, expires_at: "2099-09-28T12:10:00Z", poll_interval_s: 2,
        },
      };
    if (req.url === "/v1/pairings/pair_2" && req.method === "GET")
      return { body: { status: "awaiting_install", owner, targets: [] } };
    if (req.url === "/v1/pairings/pair_2/confirm")
      return { body: { credential: secret, version: 1, owner, targets: listed } };
    if (req.url === "/v1/targets")
      return (targetReads++, { body: { targets: [target] } });
    return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
  });
  origin = server.origin;
  try {
    let pending = await startRelayPairing(origin);
    await checkRelayPairing(pending.id);
    const relay = await confirmRelayPairing(pending.id, owner.id);
    expect(targetReads).toBe(1);
    expect(relay.targets).toMatchObject([
      { id: target.target_id, name: target.name, engine: null, model: null },
    ]);
    expect(readRelayStore().relays[0]?.targets.map((item) => item.id)).toEqual([
      target.target_id,
    ]);
    // A confirm that already carries targets needs no second read.
    listed = [{ ...target, target_id: "target_2" }];
    pending = await startRelayPairing(origin);
    await checkRelayPairing(pending.id);
    expect(
      (await confirmRelayPairing(pending.id, owner.id)).targets.map((item) => item.id),
    ).toEqual(["target_2"]);
    expect(targetReads).toBe(1);
  } finally {
    await server.close();
  }
});
