import fs from "node:fs";
import path from "node:path";

import type { RootKey } from "@/lib/types";
import { isClaudeWorkflowBookkeeping } from "./claudeNative";
import { isCopilotTranscriptPath } from "./copilotNative";
import { isOpenclawTranscript } from "./openclawNative";
import { EXTS, scanRootEntries } from "./roots";

type Directory = { identity: string; directories: string[]; files: string[] };
const host = globalThis as typeof globalThis & {
  __llvCatalogMembershipDirectories?: Map<string, Directory>;
  __llvCatalogMembershipFiles?: Set<string>;
  __llvCatalogMembershipFailureAt?: number;
};

function eligible(rootName: RootKey, root: string, pathname: string): boolean {
  const name = path.basename(pathname);
  if (!EXTS.some(ext => name.endsWith(ext))) return false;
  if (rootName === "claude-projects") return !isClaudeWorkflowBookkeeping(path.relative(root, pathname));
  if (rootName === "openclaw-sessions") return isOpenclawTranscript(name);
  if (rootName === "copilot-sessions") return isCopilotTranscriptPath(root, pathname);
  if (rootName === "claude-tasks") {
    const parts = path.relative(root, pathname).split(path.sep);
    return parts.length === 4 && parts[2] === "tasks" && name.endsWith(".output");
  }
  return true;
}

/** Checks directory identities, reusing unchanged listings. Only new or empty
 * files need a stat; transcript appends read no file metadata or bytes. The
 * full scanner still owns canonicalization, twins, ranking and hydration.
 * A failed probe never replaces the last complete membership key. */
export async function fileCatalogMembership(): Promise<string | null> {
  const directories: Map<string, Directory> = host.__llvCatalogMembershipDirectories ??= new Map();
  const populated: Set<string> = host.__llvCatalogMembershipFiles ??= new Set();
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  const members: string[] = [];
  let complete = true;
  let active = 0;
  const queue: Array<() => void> = [];
  const limit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= 48) await new Promise<void>(resolve => queue.push(resolve));
    active += 1;
    try { return await work(); }
    finally { active -= 1; queue.shift()?.(); }
  };
  const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  const failed = (error: unknown) => {
    complete = false;
    if (Date.now() - (host.__llvCatalogMembershipFailureAt ?? Number.NEGATIVE_INFINITY) >= 60_000) {
      host.__llvCatalogMembershipFailureAt = Date.now();
      console.error("[scanner membership] probe failed; retaining completed catalog:", error);
    }
  };
  const walk = async (rootName: RootKey, root: string, dir: string): Promise<void> => {
    visitedDirectories.add(dir);
    try {
      // Take the identity BEFORE listing: a birth during the walk invalidates
      // it on the next probe rather than being acknowledged without its row.
      const st = await limit(() => fs.promises.stat(dir));
      const identity = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
      let cached = directories.get(dir);
      if (cached?.identity !== identity) {
        const entries = await limit(() => fs.promises.readdir(dir, { withFileTypes: true }));
        cached = { identity, directories: [], files: [] };
        for (const entry of entries) {
          const pathname = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name.startsWith(".git") || (rootName === "claude-projects" && entry.name === "tool-results")) continue;
            cached.directories.push(pathname);
          } else if (entry.isFile() && eligible(rootName, root, pathname)) {
            cached.files.push(pathname);
          }
        }
        // A removed and later recreated empty file must be checked anew.
        for (const old of directories.get(dir)?.files ?? []) if (!cached.files.includes(old)) populated.delete(old);
        directories.set(dir, cached);
      }
      await Promise.all([
        ...cached.directories.map(child => walk(rootName, root, child)),
        ...cached.files.map(async pathname => {
          visitedFiles.add(pathname);
          if (!populated.has(pathname)) {
            try {
              const file = await limit(() => fs.promises.stat(pathname));
              if (file.size > 0 || rootName === "claude-tasks") populated.add(pathname);
            } catch (error) { if (!missing(error)) failed(error); }
          }
          if (populated.has(pathname)) members.push(`${rootName}:${pathname}`);
        }),
      ]);
    } catch (error) {
      if (missing(error)) directories.delete(dir);
      else failed(error);
    }
  };
  await Promise.all(scanRootEntries().map(([rootName, root]) => walk(rootName, root, root)));
  if (!complete) return null;
  for (const dir of directories.keys()) if (!visitedDirectories.has(dir)) directories.delete(dir);
  for (const file of populated) if (!visitedFiles.has(file)) populated.delete(file);
  return JSON.stringify(members.sort());
}
