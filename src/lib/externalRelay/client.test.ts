import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRelay, ExternalRelayError, relayCall } from "./client";
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
  answered_by: "service",
  fallback: "service",
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
          expires_at: "2026-09-28T12:10:00Z",
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
