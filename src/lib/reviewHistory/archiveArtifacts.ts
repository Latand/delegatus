import fs from "node:fs";
import path from "node:path";

import { APP_DIR_NAMES } from "../../../bin/appDir.mjs";
import { ArchiveReadError } from "./reader";
import type { Flow } from "./types";

export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024;
export type ArchiveArtifact = { status: "available"; text: string; bytes: number } | { status: "missing" | "unavailable" | "too_large" };

/** Only regular files inside this flow's artifact directory may be exported.
 * Keep incomplete bytes out of both redaction and relay digest evidence. */
export function readArchiveArtifact(directory: string, flowId: string, filename: string | null, maxBytes = MAX_ARTIFACT_BYTES): ArchiveArtifact {
  if (!filename) return { status: "missing" };
  let fd: number | undefined;
  try {
    const root = path.resolve(directory, "flows", flowId);
    if (path.dirname(root) !== path.resolve(directory, "flows")) return { status: "unavailable" };
    let candidate = path.resolve(filename);
    if (!candidate.startsWith(root + path.sep)) {
      // The legacy directory copy intentionally leaves row paths unchanged.
      // Read its copied artifact from today's archive, never an arbitrary path
      // embedded in a row or an already-pruned predecessor directory.
      const name = path.basename(candidate);
      const legacyRoots = [path.join(".claude", "viewer-state"), ...APP_DIR_NAMES.map((name) => path.join(name, "state"))];
      const recognized = /^round-[0-9]+-(?:review\.md|last-message\.md|stdout\.log|stderr\.txt)$/.test(name)
        && legacyRoots.some(legacy => candidate.endsWith(path.sep + path.join(legacy, "flows", flowId, name)));
      if (!recognized) return { status: "unavailable" };
      candidate = path.join(root, name);
    }
    const actualRoot = fs.realpathSync(root);
    if (actualRoot !== root || !fs.realpathSync(candidate).startsWith(actualRoot + path.sep)) return { status: "unavailable" };
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { status: "unavailable" };
    if (stat.size > maxBytes) return { status: "too_large" };
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > stat.size || length > maxBytes) return { status: "too_large" };
    return { status: "available", text: bytes.subarray(0, length).toString("utf8"), bytes: length };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function archiveArtifacts(directory: string, flow: Flow, includeLogs: boolean) {
  if (flow.rounds.length > 256) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  let remaining = MAX_ARTIFACT_TOTAL_BYTES;
  return flow.rounds.map(round => {
    const names: Record<string, string | null> = { findings: round.findingsPath };
    if (includeLogs) Object.assign(names, {
      output: path.join(directory, "flows", flow.id, `round-${round.n}-last-message.md`),
      stdout: path.join(directory, "flows", flow.id, `round-${round.n}-stdout.log`),
      stderr: path.join(directory, "flows", flow.id, `round-${round.n}-stderr.txt`),
    });
    const artifacts = Object.fromEntries(Object.entries(names).map(([kind, filename]) => {
      const artifact = readArchiveArtifact(directory, flow.id, filename, Math.min(MAX_ARTIFACT_BYTES, remaining));
      if (artifact.status === "available") remaining -= artifact.bytes;
      return [kind, artifact];
    }));
    return { round: round.n, artifacts };
  });
}
