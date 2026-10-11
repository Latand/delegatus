import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { ExternalRelayError } from "./client";
import {
  cancelCloneRequest,
  checkCloneRequest,
  cloneJpeg,
  createCloneRequest,
  generateCloneAvatars,
} from "./cloneCreate";
import { relayActivity } from "./activity";
import { refreshTargetsForRead } from "./poller";
import { readRelayStore, updateRelayStore, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-clone-state-"));
process.env.LLV_STATE_DIR = state;
afterEach(() => fs.rmSync(path.join(state, "external-relay"), { recursive: true, force: true }));
afterAll(() => fs.rmSync(state, { recursive: true, force: true }));

const CREATE_URL = "https://t.me/newbot/manager_bot/nichna_sova_bot?name=%D0%9D%D1%96%D1%87%D0%BD%D0%B0";
const limits = { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 };

function pair(origin: string, features: string[] = ["clone_create"]): PairedRelay {
  const relay: PairedRelay = {
    id: "celestia", origin, api_base: `${origin}/v1`, name: "Fake relay", description: "",
    credential: "c".repeat(43), features,
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: "@owner" },
    pairedAt: "2026-10-11T12:00:00Z", paused: true, limits,
    targets: [{ id: "old", name: "Old", answered_by: "install", fallback: "service", enabled: true, engine: "claude",
      model: null, effort: null, project: null, concurrency: 1, hardCapMinutes: 30 }],
  };
  updateRelayStore((store) => ({ ...store, relays: [relay] }));
  return relay;
}
const stored = () => readRelayStore().relays.find((relay) => relay.id === "celestia")!;
async function refused(promise: Promise<unknown>): Promise<ExternalRelayError> {
  try { await promise; } catch (error) { if (error instanceof ExternalRelayError) return error; throw error; }
  throw new Error("expected a refusal");
}
const png = (color: string, size = 300) => sharp({ create: { width: size, height: Math.round(size * 0.6), channels: 3, background: color } }).png().toBuffer();

type Seen = { method: string; url: string; body: unknown; auth: string | undefined };

test("a relay whose descriptor lacks clone_create gets no clone call", async () => {
  const seen: Seen[] = [];
  const server = await startTestRelay((req, body) => { seen.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization }); return { status: 500 }; });
  try {
    pair(server.origin, ["requester_context"]);
    const error = await refused(createCloneRequest("celestia", { name: "Нічна Сова", username: "nichna_sova_bot", photo: null }));
    expect(error.code).toBe("clone_create_unsupported");
    expect((await refused(generateCloneAvatars("celestia", "owl"))).code).toBe("clone_create_unsupported");
    expect(seen).toEqual([]);
  } finally { await server.close(); }
});

test("request, poll and creation: the upload goes as a square JPEG, the new target is listed and the request turns into a created record", async () => {
  const seen: Seen[] = [];
  let status: Record<string, unknown> = { status: "pending" };
  let targets = [{ target_id: "old", name: "Old", answered_by: "install", fallback: "service" }];
  const server = await startTestRelay((req, body) => {
    seen.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
    if (req.url === "/v1/clone-requests" && req.method === "POST")
      return { status: 201, body: { request_id: "req_1", create_url: CREATE_URL, expires_at: "2099-01-01T00:10:00Z" } };
    if (req.url === "/v1/clone-requests/req_1" && req.method === "GET") return { body: status };
    if (req.url === "/v1/targets") return { body: { targets } };
    return { status: 404 };
  });
  try {
    pair(server.origin);
    const upload = (await png("#3b4a8f")).toString("base64");
    const request = await createCloneRequest("celestia", { name: "  Нічна Сова ", username: "nichna_sova_bot", photo: { kind: "upload", data: upload } });
    expect(request).toMatchObject({ request_id: "req_1", create_url: CREATE_URL, name: "Нічна Сова", username: "nichna_sova_bot" });
    expect(stored().cloneRequest?.request_id).toBe("req_1");
    const sent = seen[0]!;
    expect(sent.auth).toBe(`Bearer ${"c".repeat(43)}`);
    const wire = sent.body as { name: string; username: string; photo: { kind: string; data: string } };
    expect(wire.name).toBe("Нічна Сова");
    expect(wire.username).toBe("nichna_sova_bot");
    expect(wire.photo.kind).toBe("jpeg");
    const meta = await sharp(Buffer.from(wire.photo.data, "base64")).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: "jpeg", width: 640, height: 640 });

    expect(await checkCloneRequest("celestia", "req_1")).toEqual({ status: "pending" });
    expect(stored().cloneRequest?.request_id).toBe("req_1");

    status = { status: "created", target_id: "fresh", username: "nichna_sova_bot" };
    targets = [...targets, { target_id: "fresh", name: "Нічна Сова", answered_by: "install", fallback: "service" }];
    expect(await checkCloneRequest("celestia", "req_1")).toEqual({ status: "created", target_id: "fresh", username: "nichna_sova_bot" });
    expect(stored().cloneRequest).toBeUndefined();
    expect(stored().cloneCreated).toMatchObject({ request_id: "req_1", target_id: "fresh", name: "Нічна Сова", username: "nichna_sova_bot", photo_failed: false });
    expect(stored().targets.map((target) => [target.id, target.engine, target.answered_by])).toEqual([["old", "claude", "install"], ["fresh", null, "install"]]);
  } finally { await server.close(); }
});

test("a created record outlives the page that missed the answer, takes the name confirmed in Telegram, and only the card's DELETE forgets it", async () => {
  const seen: string[] = [];
  let posts = 0;
  const server = await startTestRelay((req) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/clone-requests" && req.method === "POST")
      return { status: 201, body: { request_id: `req_${++posts}`, create_url: CREATE_URL, expires_at: "2099-01-01T00:10:00Z" } };
    if (req.url === "/v1/clone-requests/req_1" && req.method === "GET") return { body: { status: "created", target_id: "fresh", username: "silver_fox_bot", reason: "photo_failed" } };
    if (req.url === "/v1/clone-requests/req_9" && req.method === "GET") return { body: { status: "created", target_id: "other" } };
    if (req.url === "/v1/targets") return { body: { targets: [{ target_id: "old", name: "Old", answered_by: "install", fallback: "service" }, { target_id: "fresh", name: "Silver Fox", answered_by: "service", fallback: "service" }] } };
    return { status: 500 };
  });
  try {
    pair(server.origin);
    await createCloneRequest("celestia", { name: "Нічна Сова", username: "nichna_sova_bot", photo: null });
    await checkCloneRequest("celestia", "req_1");
    const record = stored().cloneCreated;
    expect(record).toMatchObject({ request_id: "req_1", target_id: "fresh", name: "Silver Fox", username: "silver_fox_bot", photo_failed: true });
    // A second read of the same answer, and an answer for a request never open here, leave the record as it is.
    await checkCloneRequest("celestia", "req_1");
    await checkCloneRequest("celestia", "req_9");
    expect(stored().cloneCreated).toEqual(record);
    // A new request keeps the earlier clone's record until its setup is done.
    await createCloneRequest("celestia", { name: "Тихий Лис", username: "tykhyi_lys_bot", photo: null });
    expect(stored().cloneCreated?.request_id).toBe("req_1");
    seen.length = 0;
    await cancelCloneRequest("celestia", "req_1");
    expect(seen).toEqual([]);
    expect(stored().cloneCreated).toBeUndefined();
    expect(stored().cloneRequest?.request_id).toBe("req_2");
  } finally { await server.close(); }
});

test("a candidate photo goes by its storage key, and no photo goes as null", async () => {
  const bodies: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    bodies.push(body);
    return { status: 201, body: { request_id: `req_${bodies.length}`, create_url: CREATE_URL, expires_at: "2099-01-01T00:10:00Z" } };
  });
  try {
    pair(server.origin);
    await createCloneRequest("celestia", { name: "Night Owl", username: "night_owl_bot", photo: { kind: "candidate", storage_key: "avatars/one.png" } });
    await createCloneRequest("celestia", { name: "Quiet Fox", username: "quiet_fox_bot", photo: null });
    expect(bodies).toEqual([
      { name: "Night Owl", username: "night_owl_bot", photo: { kind: "candidate", storage_key: "avatars/one.png" } },
      { name: "Quiet Fox", username: "quiet_fox_bot", photo: null },
    ]);
    // One open request per owner: the newer replaces the stored one.
    expect(stored().cloneRequest?.request_id).toBe("req_2");
  } finally { await server.close(); }
});

test("invalid input and an unreadable upload are refused before any relay call", async () => {
  let calls = 0;
  const server = await startTestRelay(() => { calls++; return { status: 500 }; });
  try {
    pair(server.origin);
    expect((await refused(createCloneRequest("celestia", { name: "", username: "night_owl_bot", photo: null }))).code).toBe("refused_here");
    expect((await refused(createCloneRequest("celestia", { name: "Owl", username: "owl", photo: null }))).code).toBe("refused_here");
    expect((await refused(createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: { kind: "upload", data: Buffer.from("not an image").toString("base64") } }))).code).toBe("photo_unreadable");
    expect((await refused(createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: { kind: "upload", data: "%%%" } }))).code).toBe("photo_unreadable");
    expect((await refused(cloneJpeg("A".repeat(12 * 1024 * 1024)))).code).toBe("photo_unreadable");
    expect(calls).toBe(0);
    expect((await refused(createCloneRequest("missing", { name: "Owl", username: "owl_bot", photo: null }))).code).toBe("not_found");
  } finally { await server.close(); }
});

test("a link that is not t.me/newbot is refused and nothing is stored", async () => {
  const server = await startTestRelay(() => ({ status: 201, body: { request_id: "req_1", create_url: "https://example.com/newbot/x/y_bot", expires_at: "2099-01-01T00:10:00Z" } }));
  try {
    pair(server.origin);
    expect((await refused(createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null }))).code).toBe("malformed");
    expect(stored().cloneRequest).toBeUndefined();
  } finally { await server.close(); }
});

test("the relay's 429 is its daily limit, for a request and for generated photos", async () => {
  const server = await startTestRelay(() => ({ status: 429, body: { error: { code: "rate_limited" } }, headers: { "retry-after": "3600" } }));
  try {
    pair(server.origin);
    const request = await refused(createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null }));
    expect([request.code, request.status, request.retryAfterSeconds]).toEqual(["clone_daily_limit", 429, 3600]);
    const avatars = await refused(generateCloneAvatars("celestia", "owl"));
    expect([avatars.code, avatars.status]).toEqual(["clone_daily_limit", 429]);
  } finally { await server.close(); }
});

test("expired and failed requests leave the store and keep their reason", async () => {
  let status: Record<string, unknown> = { status: "expired" };
  const server = await startTestRelay((req) => {
    if (req.method === "POST") return { status: 201, body: { request_id: "req_1", create_url: CREATE_URL, expires_at: "2099-01-01T00:10:00Z" } };
    return { body: status };
  });
  try {
    pair(server.origin);
    await createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null });
    expect(await checkCloneRequest("celestia", "req_1")).toEqual({ status: "expired" });
    expect(stored().cloneRequest).toBeUndefined();
    await createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null });
    status = { status: "failed", reason: "bot limit reached" };
    expect(await checkCloneRequest("celestia", "req_1")).toEqual({ status: "failed", reason: "bot limit reached" });
    expect(stored().cloneRequest).toBeUndefined();
    status = { status: "created", target_id: "fresh", reason: "photo_failed" };
    expect(await checkCloneRequest("celestia", "req_1")).toMatchObject({ status: "created", reason: "photo_failed" });
    status = { status: "built" };
    await expect(checkCloneRequest("celestia", "req_1")).rejects.toThrow();
  } finally { await server.close(); }
});

test("cancel deletes the request on the relay, and one the relay no longer knows is gone too", async () => {
  const deletes: string[] = [];
  let answer = 204;
  const server = await startTestRelay((req) => {
    if (req.method === "POST") return { status: 201, body: { request_id: "req_1", create_url: CREATE_URL, expires_at: "2099-01-01T00:10:00Z" } };
    if (req.method === "DELETE") { deletes.push(req.url!); return { status: answer }; }
    return { status: 404 };
  });
  try {
    pair(server.origin);
    await createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null });
    await cancelCloneRequest("celestia", "req_1");
    expect(deletes).toEqual(["/v1/clone-requests/req_1"]);
    expect(stored().cloneRequest).toBeUndefined();
    await createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null });
    answer = 404;
    await cancelCloneRequest("celestia", "req_1");
    expect(stored().cloneRequest).toBeUndefined();
    answer = 500;
    await createCloneRequest("celestia", { name: "Owl", username: "owl_bot", photo: null });
    await refused(cancelCloneRequest("celestia", "req_1"));
    expect(stored().cloneRequest?.request_id).toBe("req_1");
  } finally { await server.close(); }
});

test("generated candidates come back as small JPEG previews, an unreadable one left out", async () => {
  const image = await png("#e08a3c", 512);
  let prompt: unknown = null;
  let candidates: { storage_key: string; url: string }[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url === "/v1/clone-avatars") { prompt = body; return { body: { candidates } }; }
    return { status: 404 };
  });
  /* The image host answers bytes, which the JSON relay stub cannot. */
  const images = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/broken.png" ? new Response("nope") : new Response(image) });
  try {
    pair(server.origin);
    const host = `http://127.0.0.1:${images.port}`;
    candidates = [
      { storage_key: "avatars/1.png", url: `${host}/1.png` },
      { storage_key: "avatars/2.png", url: `${host}/broken.png` },
      { storage_key: "avatars/3.png", url: `${host}/3.png` },
    ];
    const result = await generateCloneAvatars("celestia", "A round portrait of an owl");
    expect(prompt).toEqual({ prompt: "A round portrait of an owl" });
    expect(result.map((item) => item.storage_key)).toEqual(["avatars/1.png", "avatars/3.png"]);
    const preview = Buffer.from(result[0]!.preview.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    const meta = await sharp(preview).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: "jpeg", width: 160, height: 160 });

    candidates = [{ storage_key: "avatars/2.png", url: `${host}/broken.png` }];
    expect((await refused(generateCloneAvatars("celestia", "owl"))).code).toBe("avatars_unreadable");
    candidates = [];
    await expect(generateCloneAvatars("celestia", "owl")).rejects.toThrow();
    expect((await refused(generateCloneAvatars("celestia", "  "))).code).toBe("refused_here");
  } finally { await server.close(); await images.stop(true); }
});

test("a settings read picks up clone_create from the descriptor without a new pairing, and a failed descriptor read is no request outcome", async () => {
  let features: string[] | null = ["requester_context", "clone_create"];
  let descriptorReads = 0;
  const server = await startTestRelay((req) => {
    if (req.url === "/.well-known/delegatus-relay.json") {
      descriptorReads++;
      if (!features) return { status: 503 };
      return { body: { protocol: "delegatus-relay", versions: [1], name: "Fake relay", description: "", api_base: `${server.origin}/v1`, kinds: ["answer"],
        liveness: { poll_freshness_s: 60, claim_window_s: 5, ack_window_s: 10, heartbeat_interval_s: 10, stall_window_s: 45 }, limits, features } };
    }
    if (req.url === "/v1/targets") return { body: { targets: [{ target_id: "old", name: "Old", answered_by: "install", fallback: "service" }] } };
    return { status: 404 };
  });
  try {
    pair(server.origin, ["requester_context"]);
    await refreshTargetsForRead(5_000);
    expect(stored().features).toEqual(["requester_context", "clone_create"]);
    expect(descriptorReads).toBe(1);
    // At most every five minutes from the settings page.
    await refreshTargetsForRead(5_000);
    expect(descriptorReads).toBe(1);

    const other = { ...pair(server.origin, ["requester_context"]), id: "other" };
    updateRelayStore((store) => ({ ...store, relays: [other] }));
    features = null;
    await refreshTargetsForRead(5_000);
    expect(descriptorReads).toBe(2);
    expect(readRelayStore().relays[0]!.features).toEqual(["requester_context"]);
    expect(relayActivity("other").lastOutcome).toBeNull();
  } finally { await server.close(); }
});
