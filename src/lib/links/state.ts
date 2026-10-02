import { sharedLinkState } from "./runtimeState";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { recordedProjectRemote, recordedProjectRemotes } from "@/lib/projects/aliases";

export type Scope = "board:sync";
export type SharedProject = { key: string; name: string };
export function isSharedProject(value: unknown): value is SharedProject {
  if (!object(value)) return false;
  return typeof value.key === "string" && /^repo-[0-9a-f]{32}$/.test(value.key) &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 64 &&
    !/[/\\\x00-\x1f\x7f]/.test(value.name);
}
export type Shared = { v: 1; all: boolean; projects: string[] };
export type PairCode = { id: string; hash: string; expires: number; attempts: number; failures: number[]; scopes: Scope[]; used: boolean; burned?: boolean };
export type Grant = { lastCall?: number | null; syncError?: string | null; id: string; hash: string; install: string; label: string; scopes: Scope[]; created: number; lastUsed: number | null; requests: number; days?: Record<string, number>; movedAt: number | null; flushedAt: number | null };
export type Link = { id: string; url: string; token: string; grantId: string; install: string; label: string; store: string; state: "active" | "failing" | "revoked"; lastCall: number | null; error: string | null };
type Grants = { v: 1; codes: PairCode[]; grants: Grant[] };
type Peers = { v: 1; peers: Link[] };

const memoryCounts = sharedLinkState("state.memoryCounts", () => new Map<string, { requests: number; lastUsed: number; days: Record<string, number>; movedAt: number | null; flushedAt: number | null }>());
export const linkFile = (name: "grants" | "peers" | "shared") => statePath(`links/${name}.json`);
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function read<T>(file: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!valid(parsed)) throw new Error(`malformed ${path.basename(file)}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const grantsValid = (value: unknown): value is Grants => object(value) && value.v === 1 && Array.isArray(value.codes) && Array.isArray(value.grants);
const peersValid = (value: unknown): value is Peers => object(value) && value.v === 1 && Array.isArray(value.peers);
const sharedValid = (value: unknown): value is Shared => object(value) && value.v === 1 && typeof value.all === "boolean" && Array.isArray(value.projects) && value.projects.every((project) => typeof project === "string");

export function readGrants(): Grants { return read(linkFile("grants"), { v: 1, codes: [], grants: [] }, grantsValid); }
export function writeGrants(value: Grants): void { atomicWrite(linkFile("grants"), value); }
export function readPeers(): Peers { return read(linkFile("peers"), { v: 1, peers: [] }, peersValid); }
export function writePeers(value: Peers): void { atomicWrite(linkFile("peers"), value); }
export function readShared(): Shared { return read(linkFile("shared"), { v: 1, all: false, projects: [] }, sharedValid); }

/** A repo key alone cannot prove a network remote: local and file remotes use the same shape. */
export function shareable(key: string): boolean {
  if (!/^repo-[0-9a-f]{32}$/.test(key)) return false;
  const remote = recordedProjectRemote(key);
  if (!remote || remote.startsWith("file:") || remote.startsWith("local:")) return false;
  return `repo-${sha(remote).slice(0, 32)}` === key;
}

export function setShared(next: Shared): Shared {
  if (!sharedValid(next) || next.projects.length > 10_000 || next.projects.some((key) => !shareable(key))) throw new Error("cannot-share");
  const normalized: Shared = { v: 1, all: next.all, projects: [...new Set(next.projects)].sort() };
  const current = readShared();
  if (JSON.stringify(normalized) !== JSON.stringify(current)) atomicWrite(linkFile("shared"), normalized);
  return normalized;
}

export function patchShared(change: unknown): Shared {
  if (!object(change)) throw new Error("cannot-share");
  const current = readShared();
  if (Object.keys(change).length === 1 && typeof change.all === "boolean") return setShared({ ...current, all: change.all });
  if (Object.keys(change).length === 2 && typeof change.project === "string" && typeof change.enabled === "boolean" && shareable(change.project)) {
    return setShared({ ...current, projects: change.enabled ? [...current.projects, change.project] : current.projects.filter((key) => key !== change.project) });
  }
  throw new Error("cannot-share");
}

export function sharedProjects(): SharedProject[] {
  const settings = readShared();
  const keys = settings.all ? Object.keys(recordedProjectRemotes()) : settings.projects;
  return [...new Set(keys)].filter(shareable).sort().map((key) => {
    const remote = recordedProjectRemote(key)!;
    return { key, name: remote.split("/").at(-1)!.replace(/[\\\x00-\x1f\x7f]/g, "").slice(0, 64) || key };
  });
}

export function knownProjects(): SharedProject[] {
  return Object.entries(recordedProjectRemotes()).filter(([key]) => shareable(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, remote]) => ({ key, name: remote.split("/").at(-1)!.replace(/[\\\x00-\x1f\x7f]/g, "").slice(0, 64) || key }));
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function grantView(grant: Grant) {
  const current = memoryCounts.get(`${linkFile("grants")}:${grant.id}`);
  const days = current?.days ?? grant.days ?? {};
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  return { id: grant.id, label: grant.label, scopes: grant.scopes, created: grant.created,
    lastUsed: current?.lastUsed ?? grant.lastUsed, requests: current?.requests ?? grant.requests,
    today: days[today] ?? 0, sevenDays: Object.entries(days).reduce((count, [day, value]) => count + (day >= oldest && day <= today ? value : 0), 0) };
}

export function usedGrant(grant: Grant, moved: boolean): void {
  const key = `${linkFile("grants")}:${grant.id}`;
  const prior = memoryCounts.get(key);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  const days = Object.fromEntries(Object.entries(prior?.days ?? grant.days ?? {}).filter(([day]) => day >= oldest && day <= today));
  days[today] = (days[today] ?? 0) + 1;
  const current = { requests: (prior?.requests ?? grant.requests) + 1, lastUsed: now,
    days, movedAt: moved ? now : prior?.movedAt ?? grant.movedAt, flushedAt: prior?.flushedAt ?? grant.flushedAt };
  memoryCounts.set(key, current);
  // M.10: only a call that moved data writes, at most once an hour, so an idle
  // link never rewrites grants.json.
  if (moved && now - (current.flushedAt ?? grant.created) >= 3_600_000) {
    const file = readGrants();
    const stored = file.grants.find((row) => row.id === grant.id);
    if (stored) {
      Object.assign(stored, { requests: current.requests, lastUsed: current.lastUsed, days: current.days, movedAt: current.movedAt, flushedAt: now });
      writeGrants(file);
      current.flushedAt = now;
    }
  }
}

export function forgetGrantCount(id: string): void { memoryCounts.delete(`${linkFile("grants")}:${id}`); }
