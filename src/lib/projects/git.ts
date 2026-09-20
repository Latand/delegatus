import fs from "node:fs";
import path from "node:path";

export function githubRepositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = new RegExp(String.raw`^(?:ssh:\/\/)?git` + "@" + String.raw`github\.com[:/]([^/]+\/[^/]+)$`).exec(trimmed);
  if (ssh) return ssh[1] ?? null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    const repository = url.pathname.replace(/^\//, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : null;
  } catch {
    return null;
  }
}

/* ── Project-root → GitHub repository (issue #290 readiness issue links) ── */

const REPOSITORY_CACHE_TTL_MS = 10 * 60_000;
const repositoryCacheHost = globalThis as typeof globalThis & {
  __llvRepositoryCache?: Map<string, { repository: string | null; at: number }>;
};
const repositoryCache = repositoryCacheHost.__llvRepositoryCache ??= new Map<string, { repository: string | null; at: number }>();

function gitDirectory(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(dotGit, "utf8").slice(0, 4096);
    const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
    return match?.[1] ? path.resolve(root, match[1]) : null;
  } catch {
    return null;
  }
}

function commonGitDirectory(directory: string): string {
  try {
    const common = fs.readFileSync(path.join(directory, "commondir"), "utf8").trim();
    return common ? path.resolve(directory, common) : directory;
  } catch {
    return directory;
  }
}

function originRemoteFromConfig(root: string): string | null {
  const directory = gitDirectory(root);
  if (!directory) return null;
  let config: string;
  try {
    config = fs.readFileSync(path.join(commonGitDirectory(directory), "config"), "utf8");
  } catch {
    return null;
  }
  let origin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/i.exec(line);
    if (section) {
      origin = section[1] === "origin";
      continue;
    }
    if (/^\s*\[/.test(line)) {
      origin = false;
      continue;
    }
    if (!origin) continue;
    const value = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    const url = value?.replace(/\s+[;#].*$/, "").trim();
    if (url) return url;
  }
  return null;
}

/** GitHub `owner/repo` of a project root's origin remote. The files route calls
    this for every catalog row, so it reads local Git metadata directly instead
    of serially spawning one `git` process per project on the HTTP event loop. */
export function repositoryForProjectRoot(root: string, nowMs = Date.now()): string | null {
  const cached = repositoryCache.get(root);
  if (cached && nowMs - cached.at < REPOSITORY_CACHE_TTL_MS) return cached.repository;
  let repository: string | null = null;
  try {
    const remote = originRemoteFromConfig(root);
    if (remote) repository = githubRepositoryFromRemote(remote);
  } catch {
    repository = null;
  }
  repositoryCache.set(root, { repository, at: nowMs });
  return repository;
}

/** Test seam: drop the per-root repository cache. */
export function resetRepositoryCache(): void {
  repositoryCache.clear();
}
