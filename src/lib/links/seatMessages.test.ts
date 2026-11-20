import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, test } from "bun:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-message-bounds-"));
const previous = { ...process.env };
process.env.HOME = path.join(root, "home"); process.env.TMPDIR = root; process.env.LLV_STATE_DIR = path.join(root, "state"); process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
const { queueSeatMessage, seatMessagesPart, acceptSeatMessages, validSeatMessagePart, seatMessageReceipt, messagesPending, resolveSeatMessageMachine, seatMessageMachineAddress, SeatMessageRefusal } = await import("./seatMessages");
const { recordSeatMessages, updateRemoteProjects } = await import("./boardLinks");
const { atomicWrite, linkFile, setShared, readPeers, writePeers } = await import("./state");
const { projectIdentityFromRemote } = await import("@/lib/projects/identity");
const { recordProjectRemote } = await import("@/lib/projects/aliases");
import type { LinkedPeer } from "./linked";
let sequence = 0;
const project = projectIdentityFromRemote("https://code.example.test/acme/widget", root)!;
const selfId = ["11223344", "5566", "4777", "8899", "aabbccddeeff"].join("-");
const peerId = ["00112233", "4455", "4677", "8899", "aabbccddeeff"].join("-");
const uuidLabel = () => ["33333333", "3333", "4333", "8333", "333333333333"].join("-");
const link: LinkedPeer = { key: "peer:fixture", side: "peer", id: "fixture", install: peerId, prefix: "00112233", label: "Other", projects: new Set([project.project]) };
function labelSelf(label: string) {
  atomicWrite(path.join(process.env.LLV_STATE_DIR!, "links/self.json"), { v: 1, installId: selfId, label, publicUrl: null });
}
beforeEach(() => {
  process.env.LLV_STATE_DIR = path.join(root, `state-${++sequence}`);
  recordProjectRemote(project); setShared({ v: 1, all: false, projects: [project.project] });
  labelSelf("Local");
  atomicWrite(linkFile("peers"), { v: 1, peers: [{ id: link.id, install: link.install, label: link.label, grantId: randomUUID(), token: "fixture", state: "active", lastCall: Date.now(), error: null, url: "http://127.0.0.1:1", store: randomUUID() }] });
  updateRemoteProjects(link.id, [{ key: project.project, name: "widget" }], randomUUID()); recordSeatMessages(link.key, true);
});
afterAll(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); fs.rmSync(root, { recursive: true, force: true }); });

test("a label shared by the local install and a peer is refused with both install ids", () => {
  labelSelf(link.label);
  try {
    resolveSeatMessageMachine(" oThEr ", project.project);
  } catch (error) {
    expect(error).toBeInstanceOf(SeatMessageRefusal);
    expect(error).toMatchObject({ code: "machine_ambiguous" });
    expect((error as Error).message).toContain(selfId);
    expect((error as Error).message).toContain(peerId);
    return;
  }
  throw new Error("Expected machine_ambiguous for the shared label");
});

test("an unambiguous label or install prefix resolves to the linked peer", () => {
  for (const machine of [link.label, link.prefix]) {
    expect(resolveSeatMessageMachine(machine, project.project)).toMatchObject({ install: peerId });
  }
});

test("a fresh UUID-shaped peer label resolves when no installation owns that ID", () => {
  const label = uuidLabel();
  const peers = readPeers(); peers.peers[0]!.label = label; writePeers(peers);
  expect(resolveSeatMessageMachine(label, project.project)).toMatchObject({ install: peerId });
});

test("a UUID-shaped label shared by self and peer is refused with both install IDs", () => {
  const label = uuidLabel();
  labelSelf(label);
  const peers = readPeers(); peers.peers[0]!.label = label; writePeers(peers);
  try {
    resolveSeatMessageMachine(label, project.project);
  } catch (error) {
    expect(error).toBeInstanceOf(SeatMessageRefusal);
    expect(error).toMatchObject({ code: "machine_ambiguous" });
    expect((error as Error).message).toContain(selfId);
    expect((error as Error).message).toContain(peerId);
    return;
  }
  throw new Error("Expected machine_ambiguous for the shared UUID-shaped label");
});

test("a bound remote selector requires its exact install even when another peer label matches it", () => {
  const vanishedId = uuidLabel();
  const peers = readPeers(); peers.peers[0]!.label = vanishedId; writePeers(peers);
  expect(() => resolveSeatMessageMachine(vanishedId, project.project, { exactInstallOnly: true }))
    .toThrow(expect.objectContaining({ code: "machine_unknown" }));
});

test("here, the local install id and an unambiguous local label resolve locally", () => {
  for (const machine of ["here", selfId, "Local", "this machine"]) {
    expect(resolveSeatMessageMachine(machine, project.project)).toBeNull();
  }
});

test("a peer called Here advertises its install id while here remains local", () => {
  labelSelf("Here");
  const herePeer = { ...link, label: "Here" };
  expect(resolveSeatMessageMachine("Here", project.project)).toBeNull();
  expect(seatMessageMachineAddress(herePeer)).toBe(peerId);
  expect(resolveSeatMessageMachine(seatMessageMachineAddress(herePeer), project.project)).toMatchObject({ install: peerId });
  expect(seatMessageMachineAddress({ ...link, label: selfId })).toBe(peerId);
});

test("a revoked full install ID cannot fall through to a local or linked label", () => {
  const prior = readPeers();
  const secondId = "22222222-2222-2222-2222-222222222222";
  const original = prior.peers[0]!;
  writePeers({ v: 1, peers: [
    { ...original, state: "revoked" },
    { ...original, id: secondId, install: secondId, grantId: secondId, store: secondId, label: peerId },
  ] });
  for (const localLabel of ["Local", peerId]) {
    labelSelf(localLabel);
    expect(() => resolveSeatMessageMachine(peerId, project.project)).toThrow(expect.objectContaining({ code: "link_revoked" }));
  }
});

test("the full peer install id still resolves remotely when labels coincide", () => {
  for (const label of [link.label, peerId]) {
    labelSelf(label);
    expect(resolveSeatMessageMachine(peerId, project.project)).toMatchObject({ install: peerId });
  }
});

test("escaped text pages stay within the wire byte bound while all queued words remain recoverable", () => {
  for (let n = 0; n < 10; n++) queueSeatMessage(link, project.project, "\u0001".repeat(7999) + "x", "fixture-seat", `escaped-${n}`);
  const first = seatMessagesPart(link);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(160_000);
  expect(validSeatMessagePart(first)).toBe(true);
  expect(first.out!.length).toBeGreaterThan(0);
  expect(first.out!.length).toBeLessThan(10);
  acceptSeatMessages(link, { v: 1, ack: first.out!.map(message => ({ id: message.id, st: "accepted" })) });
  expect(seatMessagesPart(link).out!.length).toBeGreaterThan(0);
});

test("the receiver enforces 200 new messages a day, including raw authenticated bodies", () => {
  for (let batch = 0; batch < 20; batch++) acceptSeatMessages(link, { v: 1, out: Array.from({ length: 10 }, () => ({ id: randomUUID(), p: project.project, at: Date.now(), k: "0011223344556677", t: "Wait." })) });
  expect(() => acceptSeatMessages(link, { v: 1, out: [{ id: randomUUID(), p: project.project, at: Date.now(), k: "0011223344556677", t: "Over the quota." }] })).toThrow("quota");
}, 20_000);

test("a downgraded peer ends queued scheduling and reports uncertainty without looping the board exchange", () => {
  const queued = queueSeatMessage(link, project.project, "Queued before rollback.", "fixture-seat", "rollback");
  expect(messagesPending(link.id)).toBe(true);
  recordSeatMessages(link.key, false);
  expect(messagesPending(link.id)).toBe(false);
  expect(seatMessageReceipt(queued.operationId)?.state).toBe("not-delivered");
});

test("backlog, changed words under one key, and reserved metadata are plain refusals", () => {
  queueSeatMessage(link, project.project, "One message.", "fixture-seat", "same-key");
  expect(() => queueSeatMessage(link, project.project, "Changed message.", "fixture-seat", "same-key")).toThrow("does not match");
  expect(() => queueSeatMessage(link, project.project, "<!-- llv:operator -->", "fixture-seat", "authority")).toThrow("authority markers");
  for (let n = 1; n < 20; n++) queueSeatMessage(link, project.project, "Wait.", "fixture-seat", `backlog-${n}`);
  expect(() => queueSeatMessage(link, project.project, "More.", "fixture-seat", "too-many")).toThrow("20 messages");
});


test("re-pairing the same install never revives a message queued under its revoked grant", () => {
  const queued = queueSeatMessage(link, project.project, "Queued under the original grant.", "fixture-seat", "original-grant");
  const peers = readPeers(); peers.peers[0]!.grantId = randomUUID(); writePeers(peers);
  expect(seatMessagesPart(link).out).toBeUndefined();
  expect(messagesPending(link.id)).toBe(false);
  expect(seatMessageReceipt(queued.operationId)?.state).toBe("not-delivered");
});

test("a removed grant remains a plain revoked-link refusal by its former machine label", async () => {
  const { revokeGrant } = await import("./protocol");
  const id = randomUUID();
  atomicWrite(linkFile("grants"), { v: 1, codes: [], grants: [{ id, install: link.install, label: "Former", hash: "fixture", scopes: ["board:sync"], created: Date.now(), lastUsed: null, requests: 0, movedAt: null, flushedAt: null }] });
  expect(revokeGrant(id)).toBe(true);
  try { resolveSeatMessageMachine("Former", project.project); throw new Error("expected refusal"); }
  catch (error) { expect((error as { code?: string }).code).toBe("link_revoked"); }
});


test("an idle install without message storage reuses its absence until the database changes", async () => {
  const { Database } = await import("bun:sqlite");
  seatMessagesPart(link);
  const close = Database.prototype.close;
  let reads = 0;
  Database.prototype.close = function (...args: Parameters<typeof close>) { reads++; return close.apply(this, args); };
  try { for (let n = 0; n < 10; n++) seatMessagesPart(link); }
  finally { Database.prototype.close = close; }
  expect(reads).toBe(0);
  queueSeatMessage(link, project.project, "A newly queued message.", "fixture-seat", "after-idle");
  expect(seatMessagesPart(link).out).toHaveLength(1);
});
