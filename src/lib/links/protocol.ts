import { randomBytes, randomUUID } from "node:crypto";

import { tokensMatch } from "@/lib/authToken";
import { currentSelf, readSelf, checkSavedAddress, markOpenToInternet } from "@/lib/links/self";
import { forgetGrantCount, grantView, isSharedProject, readGrants, readPeers, safeEqual, sha, sharedProjects, usedGrant, writeGrants, writePeers, type Grant, type Link, type PairCode, type SharedProject } from "./state";
export { remoteProjects, updateRemoteProjects } from "./boardLinks";
import { dropRemoteProjects, ownBoardStoreId, remoteProjects, remoteStore, updateRemoteProjects } from "./boardLinks";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encode = (bytes: Uint8Array, count: number) => [...bytes].slice(0, count).map((value) => alphabet[value & 31]).join("");
export const normalizeCode = (value: string) => value.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0").replace(/-/g, "");
const validCode = (value: string) => /^[0-9A-HJKMNP-TV-Z]{16}$/.test(value);
const codeId = (value: string) => value.slice(0, 6);
const codeSecret = (value: string) => value.slice(6);
const stamp = (code: PairCode) => ({ id: code.id, expiresAt: code.expires, attempts: code.attempts, wrongAttempts: 20 - code.attempts, used: code.used, burned: code.burned === true });

export async function mintCode(): Promise<{ code?: string; expiresAt?: number; error?: string }> {
  const state = currentSelf();
  if (!process.env.LLV_TOKEN) return { error: "needs-access-key" };
  if (!state.self?.publicUrl) return { error: "invalid-address" };
  if (state.state === "needs-remote-entry" || state.state === "http-public" || state.state === "open-to-internet") return { error: state.state };
  const check = await checkSavedAddress();
  if (check.code !== "ok") return { error: check.code };
  const file = readGrants();
  file.codes = file.codes.filter((entry) => entry.expires > Date.now() - 86_400_000);
  let id: string;
  do { id = encode(randomBytes(6), 6); } while (file.codes.some((entry) => entry.id === id));
  const tail = encode(randomBytes(10), 10);
  const code = `${id}-${tail.slice(0, 5)}-${tail.slice(5)}`;
  const expiresAt = Date.now() + 600_000;
  file.codes.push({ id, hash: sha(tail), expires: expiresAt, attempts: 20, failures: [], scopes: ["board:sync"], used: false });
  writeGrants(file);
  return { code, expiresAt };
}

export function listCodes() {
  return readGrants().codes.filter((code) => code.expires > Date.now()).map(stamp);
}

export function cancelCode(id: string): void {
  const file = readGrants();
  const before = file.codes.length;
  file.codes = file.codes.filter((code) => code.id !== id);
  if (before !== file.codes.length) writeGrants(file);
}

export function probePair(id: unknown, authorization: string | null): { status: number; body: object } {
  if (typeof id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{6}$/.test(id)) return { status: 401, body: { error: "unauthorized" } };
  const file = readGrants();
  const code = file.codes.find((item) => item.id === id && !item.used && item.expires > Date.now());
  if (!code) return { status: 401, body: { error: "unauthorized" } };
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const vouched = Boolean(bearer && process.env.LLV_TOKEN && tokensMatch(bearer, process.env.LLV_TOKEN));
  if (vouched) {
    code.used = true;
    writeGrants(file);
    // Saving the unsafe check also disables any further code minting.
    markOpenToInternet();
  }
  return { status: 200, body: { vouched } };
}

export function pairIncoming(value: unknown): { status: number; body: object } {
  if (!value || typeof value !== "object") return { status: 401, body: { error: "unauthorized" } };
  const input = value as Record<string, unknown>;
  const raw = typeof input.code === "string" ? normalizeCode(input.code) : "";
  if (!validCode(raw)) return { status: 401, body: { error: "unauthorized" } };
  const file = readGrants();
  const code = file.codes.find((item) => item.id === codeId(raw));
  // Keep the hash work identical for an unknown id.
  const matches = safeEqual(code?.hash ?? sha("dummy-code"), sha(codeSecret(raw)));
  if (!code) return { status: 401, body: { error: "unauthorized" } };
  if (matches && (code.used || code.expires <= Date.now())) return { status: 410, body: { error: "code-spent" } };
  if (code.used || code.expires <= Date.now()) return { status: 401, body: { error: "unauthorized" } };
  const recent = code.failures.filter((at) => at > Date.now() - 60_000);
  if (recent.length >= 5) return { status: 429, body: { error: "rate-limited" } };
  if (!matches || typeof input.install !== "string" || !/^[0-9a-f-]{36}$/.test(input.install) || typeof input.label !== "string") {
    code.attempts--;
    code.failures = [...recent, Date.now()];
    if (code.attempts <= 0) { code.used = true; code.burned = true; }
    writeGrants(file);
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!process.env.LLV_TOKEN || currentSelf().state !== "ok") return { status: 401, body: { error: "unauthorized" } };
  const self = readSelf();
  if (!self) return { status: 401, body: { error: "unauthorized" } };
  const storeId = ownBoardStoreId();
  const token = randomBytes(32).toString("base64url");
  const grant: Grant = { id: randomUUID(), hash: sha(token), install: input.install, label: input.label.slice(0, 100), scopes: code.scopes,
    created: Date.now(), lastUsed: null, requests: 0, movedAt: null, flushedAt: null };
  code.used = true;
  file.grants.push(grant);
  writeGrants(file);
  return { status: 200, body: { grant: { id: grant.id, token, scopes: grant.scopes }, install: { id: self.installId, label: self.label }, storeId, feeds: ["boards"] } };
}

export function authorizePeer(header: string | null, scope?: "board:sync"): Grant | null {
  const state = currentSelf().state;
  if (!process.env.LLV_TOKEN || state === "needs-remote-entry" || state === "open-to-internet" || state === "http-public") return null;
  const match = header?.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  const file = readGrants();
  const grant = match ? file.grants.find((entry) => entry.id === match[1]) : undefined;
  const equal = safeEqual(grant?.hash ?? sha("dummy-token"), sha(match?.[2] ?? ""));
  return equal && grant && (!scope || grant.scopes.includes(scope)) ? grant : null;
}

export function revokeGrant(id: string): boolean {
  const file = readGrants();
  const before = file.grants.length;
  file.grants = file.grants.filter((grant) => grant.id !== id);
  if (file.grants.length === before) return false;
  dropRemoteProjects(id);
  writeGrants(file);
  forgetGrantCount(id);
  partialShared.delete(id);
  return true;
}

export function grantRows() { return readGrants().grants.map(grantView); }
const peerCalls = new Map<string, number>();
export function markPeerCall(id: string, at: number): void { peerCalls.set(id, at); }
export function peerRows() { return readPeers().peers.map(({ token: _token, ...peer }) => ({ ...peer, lastCall: peerCalls.get(peer.id) ?? peer.lastCall })); }
export function findPeer(id: string): Link | undefined { return readPeers().peers.find((peer) => peer.id === id); }
export function putPeer(peer: Link): void {
  const file = readPeers();
  const index = file.peers.findIndex((row) => row.id === peer.id);
  if (index < 0) file.peers.push(peer); else file.peers[index] = peer;
  writePeers(file);
}
export function removePeer(id: string): Link | undefined {
  const file = readPeers();
  const peer = file.peers.find((row) => row.id === id);
  if (peer) { file.peers = file.peers.filter((row) => row.id !== id); dropRemoteProjects(id); writePeers(file); peerCalls.delete(id); }
  return peer;
}

export const sharedDigest = (projects: SharedProject[]) => sha(JSON.stringify(projects)).slice(0, 8);
const partialShared = new Map<string, { hash: string; total: number; rows: SharedProject[]; at: number }>();

export function incomingSync(grant: Grant, input: unknown): { status: number; body: object } {
  if (partialShared.size) for (const [id, pending] of partialShared) if (Date.now() - pending.at > 600_000) partialShared.delete(id);
  if (!input || typeof input !== "object" || (input as Record<string, unknown>).v !== 1) return { status: 400, body: { error: "malformed" } };
  const wire = input as Record<string, unknown>;
  if (typeof wire.store !== "string" || !/^[0-9a-f-]{36}$/.test(wire.store) || typeof wire.now !== "number" || !Number.isSafeInteger(wire.now)) return { status: 400, body: { error: "malformed" } };
  const heldStore = remoteStore(grant.id);
  if (heldStore && heldStore !== wire.store) return { status: 409, body: { error: "store-changed" } };
  if (typeof wire.s !== "string" || !/^[0-9a-f]{8}$/.test(wire.s) || typeof wire.have !== "string" || !/^[0-9a-f]{8}$/.test(wire.have)) return { status: 400, body: { error: "malformed" } };
  const list = wire.shared;
  if (list !== undefined) {
    if (!Array.isArray(list) || list.length > 100 || !list.every(isSharedProject)) return { status: 400, body: { error: "malformed" } };
    const index = wire.index ?? 0, total = wire.total ?? list.length;
    if (!Number.isInteger(index) || !Number.isInteger(total) || (index as number) < 0 || (total as number) > 10_000 || (index as number) + list.length > (total as number)) return { status: 400, body: { error: "malformed" } };
    if (index === 0) partialShared.set(grant.id, { hash: wire.s, total: total as number, rows: [], at: Date.now() });
    const pending = partialShared.get(grant.id);
    if (!pending || pending.hash !== wire.s || pending.total !== total || pending.rows.length !== index || Date.now() - pending.at > 600_000) return { status: 400, body: { error: "malformed" } };
    pending.rows.push(...list as SharedProject[]);
    if (pending.rows.length === pending.total) {
      if (new Set(pending.rows.map((row) => row.key)).size !== pending.rows.length) return { status: 400, body: { error: "malformed" } };
      if (sharedDigest(pending.rows) !== wire.s) return { status: 400, body: { error: "malformed" } };
      updateRemoteProjects(grant.id, pending.rows, wire.store);
      partialShared.delete(grant.id);
    }
  }
  // M1 exchanges metadata only. M.10 counts durable work only when a later
  // slice moves a task, tombstone, fence or nonempty activity page.
  usedGrant(grant, false);
  const local = sharedProjects();
  const localHash = sharedDigest(local);
  const want = typeof wire.want === "number" && Number.isInteger(wire.want) && wire.want >= 0 && wire.want <= local.length ? wire.want : 0;
  const sendLocal = wire.have !== localHash;
  const remoteHash = sharedDigest(remoteProjects(grant.id));
  return { status: 200, body: { v: 1, now: Date.now(), store: ownBoardStoreId(), s: localHash,
    ...(wire.s !== remoteHash ? { need: true } : {}),
    ...(sendLocal ? { shared: local.slice(want, want + 100), index: want, total: local.length } : {}) } };
}
