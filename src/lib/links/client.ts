import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { ensureSelf } from "./self";
import { findPeer, grantRows, markPeerCall, peerRows, putPeer, remoteProjects, removePeer, sharedDigest, updateRemoteProjects } from "./protocol";
import { isSharedProject, readPeers, sharedProjects, type Link, type SharedProject } from "./state";
import { LOOPBACK_PROBE_HOSTS } from "@/runtime-host/deploymentProxy";
import { ownBoardStoreId } from "./boardLinks";
import { linkedContext } from "./linked";
import { taskExchange, TaskSyncError } from "./taskExchange";

export class LinkError extends Error { constructor(readonly code: string) { super(code); } }
/** Shared-list pages, task pages both ways and scans, bounded per sync. */
const MAX_SYNC_CALLS = 1_000;
const lastMoved = new Map<string, number>();
/** Rows the last completed sync with this link moved, for A's schedule. */
export function lastSyncMoved(id: string): number { return lastMoved.get(id) ?? 0; }
const lastSent = new Map<string, string>();
const syncQueues = new Map<string, Promise<void>>();
const sameLink = (current: Link | undefined, expected: Link): current is Link => !!current &&
  current.id === expected.id && current.grantId === expected.grantId && current.token === expected.token &&
  current.store === expected.store && current.url === expected.url;
type Target = { url: URL; address: string };
const bare = (host: string) => host.replace(/^\[|\]$/g, "");
const loopback = (host: string) => host === "::1" || net.isIP(host) === 4 && host.split(".")[0] === "127";

export async function peerTarget(input: string, scope: "board:sync" = "board:sync"): Promise<Target> {
  let url: URL;
  try { url = new URL(input); } catch { throw new LinkError("invalid-address"); }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new LinkError("invalid-address");
  let addresses: string[];
  const host = bare(url.hostname);
  try { addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((entry) => entry.address); }
  catch { throw new LinkError("unreachable"); }
  if (!addresses.length) throw new LinkError("unreachable");
  // A board grant can write tasks, so its token travels on HTTPS or loopback only.
  if (url.protocol === "http:" && scope === "board:sync" && !addresses.every(loopback)) throw new LinkError("http-public");
  return { url, address: addresses[0]! };
}

async function call(target: Target, route: string, method: "GET" | "POST" | "DELETE", body?: object, headers: Record<string, string> = {}, hostOverride?: string): Promise<{ status: number; body: Record<string, unknown>; bytesRead: number; bytesWritten: number }> {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({ hostname: target.address, port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      servername: net.isIP(bare(target.url.hostname)) ? undefined : bare(target.url.hostname), path: route, method, timeout: 5000,
      headers: { host: hostOverride ?? target.url.host, ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.length) } : {}), ...headers },
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) { response.destroy(new LinkError("malformed")); return; } chunks.push(chunk); });
      response.on("end", () => {
        if (!response.complete) { reject(new LinkError("unreachable")); return; }
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytesRead: response.socket?.bytesRead ?? 0, bytesWritten: response.socket?.bytesWritten ?? 0 }); }
        catch { reject(new LinkError("not-delegatus")); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new LinkError("unreachable")));
    request.on("error", reject);
    request.end(encoded);
  });
}

export async function connectPeer(input: { url: string; code: string; name?: string }): Promise<Link> {
  const target = await peerTarget(input.url);
  const code = input.code.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0").replace(/-/g, "");
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(code)) throw new LinkError("invalid-code");
  const self = ensureSelf();
  if (!self) throw new LinkError("this-install-unset");
  const ownStore = ownBoardStoreId();
  const id = code.slice(0, 6);
  const port = target.url.port || (target.url.protocol === "https:" ? "443" : "80");
  for (const host of LOOPBACK_PROBE_HOSTS(port)) {
    try {
      const answer = await call(target, "/api/peer/v1/pair/probe", "POST", { id }, {}, host);
      if (answer.status === 200 && answer.body.vouched === true) throw new LinkError("peer-open");
    } catch (error) { if (error instanceof LinkError && error.code === "peer-open") throw error; }
  }
  const answer = await call(target, "/api/peer/v1/pair", "POST", { code: input.code, install: self.installId, label: self.label });
  if (answer.status !== 200) throw new LinkError(typeof answer.body.error === "string" ? answer.body.error : "not-delegatus");
  const remote = answer.body.install as { id?: unknown; label?: unknown } | undefined;
  const grant = answer.body.grant as { id?: unknown; token?: unknown; scopes?: unknown } | undefined;
  if (typeof remote?.id !== "string" || !/^[0-9a-f-]{36}$/.test(remote.id) || typeof remote.label !== "string" || typeof grant?.id !== "string" || !/^[0-9a-f-]{36}$/.test(grant.id) || typeof grant.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !Array.isArray(grant.scopes)) throw new LinkError("not-delegatus");
  const credential = { "x-delegatus-peer": `${grant.id}.${grant.token}` };
  const rejectGrant = async (code: string): Promise<never> => {
    try {
      const removed = await call(target, "/api/peer/v1/grant", "DELETE", undefined, credential);
      if (removed.status !== 200) throw new Error("grant revocation unconfirmed");
    } catch { throw new LinkError("grant-cleanup-needed"); }
    throw new LinkError(code);
  };
  let info: Awaited<ReturnType<typeof call>>;
  try { info = await call(target, "/api/peer/v1/info", "GET", undefined, credential); }
  catch (error) { return rejectGrant(error instanceof LinkError ? error.code : "unreachable"); }
  if (info.status !== 200 || info.body.v !== 1 || (info.body.feeds as { boards?: unknown } | undefined)?.boards !== 1 || !grant.scopes.includes("board:sync")) {
    return rejectGrant("version");
  }
  if (typeof answer.body.storeId !== "string" || !/^[0-9a-f-]{36}$/.test(answer.body.storeId)) {
    return rejectGrant("not-delegatus");
  }
  if (remote.id === self.installId || answer.body.storeId === ownStore || readPeers().peers.some((peer) => peer.install === remote.id || peer.store === answer.body.storeId)) {
    return rejectGrant("already-linked");
  }
  const link: Link = { id: remote.id, url: target.url.origin, token: grant.token, grantId: grant.id, install: remote.id,
    label: input.name?.trim().slice(0, 100) || remote.label.slice(0, 100), store: answer.body.storeId, state: "active", lastCall: null, error: null };
  putPeer(link);
  await syncPeer(link.id);
  return findPeer(link.id)!;
}

export async function syncPeer(id: string): Promise<{ peer: Link; remote: SharedProject[] }> {
  const previous = syncQueues.get(id);
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  syncQueues.set(id, current);
  try {
    if (previous) await previous;
    return await runSyncPeer(id);
  } finally {
    release();
    if (syncQueues.get(id) === current) syncQueues.delete(id);
  }
}

async function runSyncPeer(id: string): Promise<{ peer: Link; remote: SharedProject[] }> {
  let peer = findPeer(id);
  if (!peer) throw new LinkError("not-found");
  const stillLinked = (): Link => {
    const current = findPeer(id);
    if (!sameLink(current, peer!)) throw new LinkError("not-found");
    if (current.state === "revoked" && peer!.state !== "revoked") throw new LinkError("revoked");
    return current;
  };
  const self = linkedContext().self;
  let exchange = self ? taskExchange({ id, install: peer.install, store: peer.store }, self) : null;
  exchange?.begin();
  try {
    const target = await peerTarget(peer.url);
    stillLinked();
    let local = sharedProjects();
    let localHash = sharedDigest(local);
    const sentKey = `${peer.url}:${id}`;
    let send = lastSent.get(sentKey) !== localHash;
    let sent = send ? 0 : local.length;
    let received: SharedProject[] = [];
    let remote = remoteProjects(id);
    let remoteHash = sharedDigest(remote);
    let remoteTotal: number | null = null;
    let receivingHash: string | null = null;
    let remoteRestarts = 0;
    let store = peer.store;
    for (let calls = 0; calls < MAX_SYNC_CALLS; calls++) {
      stillLinked();
      if (calls > 0) {
        const currentLocal = sharedProjects();
        const currentHash = sharedDigest(currentLocal);
        if (currentHash !== localHash) {
          local = currentLocal;
          localHash = currentHash;
          send = true;
          sent = 0;
          lastSent.delete(sentKey);
        }
      }
      const batch = send ? local.slice(sent, sent + 100) : undefined;
      const remoteKeys = new Set(remote.map((project) => project.key));
      const linked = new Set(local.map((project) => project.key).filter((key) => remoteKeys.has(key)));
      const taskParts = exchange?.request(linked) ?? {};
      const answer = await call(target, "/api/peer/v1/boards/sync", "POST", { v: 1, store: ownBoardStoreId(), now: Date.now(), s: localHash, have: remoteHash,
        ...(batch ? { shared: batch, index: sent, total: local.length } : {}),
        ...(remoteTotal !== null ? { want: received.length } : {}), ...taskParts }, { "x-delegatus-peer": `${peer.grantId}.${peer.token}` });
      const live = stillLinked();
      if (answer.status === 401) {
        putPeer({ ...live, state: "revoked", error: "revoked" });
        throw new LinkError("revoked");
      }
      if (answer.status === 429 && answer.body.error === "quota") throw new LinkError("quota");
      if (answer.status === 409 && answer.body.error === "clock") throw new LinkError("clock");
      if (answer.status === 400 && answer.body.error === "malformed") throw new LinkError("malformed");
      if (answer.status !== 200 || answer.body.v !== 1 || typeof answer.body.s !== "string" || !/^[0-9a-f]{8}$/.test(answer.body.s)) throw new LinkError("not-delegatus");
      if (typeof answer.body.store !== "string" || !/^[0-9a-f-]{36}$/.test(answer.body.store)) throw new LinkError("malformed");
      if (answer.body.store !== peer.store) {
        // M.8: a recreated store on B is rebuilt by a resync in both directions.
        peer = { ...live, store: answer.body.store };
        putPeer(peer);
        exchange = self ? taskExchange({ id, install: peer.install, store: peer.store }, self) : null;
        exchange?.begin();
        store = answer.body.store;
        continue;
      }
      store = answer.body.store;
      try {
        exchange?.accept(answer.body, linked);
      } catch (error) {
        if (error instanceof TaskSyncError) throw new LinkError(error.code);
        throw error;
      }
      exchange?.save();
      if (batch) {
        sent += batch.length;
        if (sent === local.length) { send = false; lastSent.set(sentKey, localHash); }
      }
      const changedRemote = remoteTotal !== null && answer.body.s !== receivingHash;
      if (changedRemote) {
        if (++remoteRestarts > 2) throw new LinkError("malformed");
        remoteTotal = null;
        receivingHash = null;
        received = [];
      }
      if (!changedRemote && answer.body.shared !== undefined) {
        const page = answer.body.shared;
        if (!Array.isArray(page) || page.length > 100 || !page.every(isSharedProject) ||
            answer.body.index !== received.length || typeof answer.body.total !== "number" || answer.body.total > 10_000 || received.length + page.length > answer.body.total) throw new LinkError("malformed");
        if (remoteTotal === null) receivingHash = answer.body.s;
        remoteTotal = answer.body.total;
        received.push(...page);
        if (received.length === remoteTotal) {
          if (sharedDigest(received) !== answer.body.s) throw new LinkError("malformed");
          remote = received;
          remoteHash = sharedDigest(remote);
          updateRemoteProjects(id, remote, store);
          remoteTotal = null;
          receivingHash = null;
          received = [];
        }
      } else if (remoteTotal === null && answer.body.s === remoteHash) {
        updateRemoteProjects(id, remote, store);
      }
      if (answer.body.need === true && !send && sent === local.length) {
        send = true; sent = 0; lastSent.delete(sentKey);
      }
      // A shared list that changed in this answer can link a project whose
      // rows have not moved yet; one more call carries them.
      const localKeys = new Set(local.map((project) => project.key));
      const linkedAfter = new Set(remote.map((project) => project.key).filter((key) => localKeys.has(key)));
      const linkedSame = linkedAfter.size === linked.size && [...linkedAfter].every((key) => linked.has(key));
      if (!send && remoteTotal === null && answer.body.s === remoteHash && answer.body.need !== true && !exchange?.pending() && (linkedSame || !exchange)) break;
      if (calls === MAX_SYNC_CALLS - 1) throw new LinkError("malformed");
    }
    exchange?.save();
    lastMoved.set(id, exchange?.movedRows ?? 0);
    const live = stillLinked();
    const current = { ...live, state: "active" as const, lastCall: Date.now(), error: null };
    if (live.state !== "active" || live.error !== null) putPeer(current);
    // Last-call freshness is only needed in memory; do not rewrite peers.json on idle calls.
    markPeerCall(id, current.lastCall);
    return { peer: current, remote };
  } catch (error) {
    if (error instanceof LinkError && error.code === "revoked") throw error;
    const live = findPeer(id);
    if (sameLink(live, peer) && live.state !== "revoked" && live.state !== "failing") {
      putPeer({ ...live, state: "failing", error: error instanceof LinkError ? error.code : "unreachable" });
    }
    throw error;
  }
}

export async function removeConnectedPeer(id: string): Promise<{ warned: boolean }> {
  const peer = findPeer(id);
  if (!peer) throw new LinkError("not-found");
  let warned = false;
  try {
    const target = await peerTarget(peer.url);
    const answer = await call(target, "/api/peer/v1/grant", "DELETE", undefined, { "x-delegatus-peer": `${peer.grantId}.${peer.token}` });
    warned = answer.status !== 200;
  } catch { warned = true; }
  const live = findPeer(id);
  if (sameLink(live, peer)) {
    removePeer(id);
    lastSent.delete(`${peer.url}:${id}`);
  }
  return { warned };
}

export function projectLinkStates() {
  const local = new Set(sharedProjects().map((project) => project.key));
  const linked = [
    ...peerRows().map((peer) => ({ id: peer.id, label: peer.label, state: peer.state })),
    ...grantRows().map((grant) => ({ id: grant.id, label: grant.label, state: "active" })),
  ];
  return linked.map((peer) => {
    if (peer.state === "revoked") return { ...peer, projects: [] };
    const remoteRows = remoteProjects(peer.id);
    const remote = new Set(remoteRows.map((project) => project.key));
    const names = new Map([...sharedProjects(), ...remoteRows].map((project) => [project.key, project.name]));
    return { id: peer.id, label: peer.label, state: peer.state, projects: [...new Set([...local, ...remote])].sort().map((key) => ({ key,
      name: names.get(key) ?? key, state: local.has(key) && remote.has(key) ? "linked" : local.has(key) ? "only-here" : "only-there" })) };
  });
}
