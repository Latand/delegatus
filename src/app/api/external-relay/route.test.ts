import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-test-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const { GET } = await import("./route");
const { POST } = await import("./pairings/route");
const origin = "http://127.0.0.1:8899";
const local = { headers: { origin, host: "127.0.0.1:8899" } };
test("status omits credential and poll secret", async () => {
  const { updateRelayStore } = await import("@/lib/externalRelay/store");
  updateRelayStore((store) => ({
    ...store,
    relays: [
      {
        id: "relay",
        origin,
        api_base: `${origin}/v1`,
        name: "Test",
        description: "",
        credential: "secret_credential",
        owner: {
          namespace: "test",
          id: "owner",
          display_name: "Owner",
          handle: null,
        },
        pairedAt: new Date().toISOString(),
        paused: true,
        limits: {
          max_response_bytes: 1048576,
          max_wait_s: 25,
          max_answer_chars: 4000,
        },
        targets: [],
      },
    ],
    pending: [
      {
        id: "pending",
        origin,
        api_base: `${origin}/v1`,
        name: "Test",
        description: "",
        limits: {
          max_response_bytes: 1048576,
          max_wait_s: 25,
          max_answer_chars: 4000,
        },
        pairing_id: "pair",
        poll_secret: "secret_poll",
        code: "1234-5678",
        verify_url: null,
        expires_at: new Date().toISOString(),
        poll_interval_s: 2,
      },
    ],
  }));
  const response = await GET(
    new NextRequest(`${origin}/api/external-relay`, local),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("pending");
  expect(text).not.toContain("secret_credential");
  expect(text).not.toContain("secret_poll");
});
test("mutation guards cross origin and staging", async () => {
  const foreign = await POST(
    new NextRequest(`${origin}/api/external-relay/pairings`, {
      method: "POST",
      headers: { origin: "https://foreign.example", host: "127.0.0.1:8899" },
      body: "{}",
    }),
  );
  expect(foreign.status).toBe(403);
  process.env.LLV_STAGING = "1";
  try {
    const staging = await POST(
      new NextRequest(`${origin}/api/external-relay/pairings`, {
        method: "POST",
        headers: { origin, host: "127.0.0.1:8899" },
        body: "{}",
      }),
    );
    expect(staging.status).toBe(409);
  } finally {
    delete process.env.LLV_STAGING;
  }
});
test("agent capability cannot read or mutate relay settings", async () => {
  const { setCallerConversationResolverForTests } = await import(
    "@/lib/agent/operatorAuthority"
  );
  const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import(
    "@/lib/agent/capabilityHeader"
  );
  setCallerConversationResolverForTests((digest) => (digest ? "agent" : null));
  try {
    const headers = {
      origin,
      host: "127.0.0.1:8899",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: "A".repeat(43),
    };
    expect(
      (await GET(new NextRequest(`${origin}/api/external-relay`, { headers })))
        .status,
    ).toBe(403);
    expect(
      (
        await POST(
          new NextRequest(`${origin}/api/external-relay/pairings`, {
            method: "POST",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
  } finally {
    setCallerConversationResolverForTests(null);
  }
});
test("a pairing the service ended leaves the store after one check", async () => {
  const { startTestRelay } = await import("@/lib/externalRelay/testRelay");
  const { updateRelayStore } = await import("@/lib/externalRelay/store");
  const { GET: CHECK } = await import("./pairings/[id]/route");
  const server = await startTestRelay(() => ({
    body: { status: "denied", reason: "Declined by the owner" },
  }));
  try {
    updateRelayStore((store) => ({
      ...store,
      pending: [
        {
          id: "ended",
          origin: server.origin,
          api_base: `${server.origin}/v1`,
          name: "Test",
          description: "",
          limits: {
            max_response_bytes: 1048576,
            max_wait_s: 25,
            max_answer_chars: 4000,
          },
          pairing_id: "pair-ended",
          poll_secret: "secret_poll",
          code: "1234-5678",
          verify_url: null,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          poll_interval_s: 2,
        },
      ],
    }));
    const checked = await CHECK(
      new NextRequest(`${origin}/api/external-relay/pairings/ended`, local),
      { params: Promise.resolve({ id: "ended" }) },
    );
    expect(await checked.json()).toMatchObject({
      pairing: { status: "denied", reason: "Declined by the owner" },
    });
    const listed = await (
      await GET(new NextRequest(`${origin}/api/external-relay`, local))
    ).json();
    expect(
      listed.pending.some((item: { id: string }) => item.id === "ended"),
    ).toBe(false);
  } finally {
    await server.close();
  }
});
