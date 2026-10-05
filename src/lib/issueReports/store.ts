import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/*
 * The previews of Delegatus bug reports (#2518), one file per preview, named
 * by the digest of its text.
 *
 * The digest is the whole contract between what the operator read and what is
 * published: a preview is stored under it, the seat reads the stored text back
 * to show it, and publication takes the digest and sends the stored text. No
 * caller hands publication a title or a body, so the published text cannot
 * differ from the previewed one. An edit is a new preview with a new digest.
 *
 * One file per preview because two processes write here: the reporter's MCP
 * server records a preview and the seat's marks it shown and published.
 */

export const ISSUE_REPORT_DIGEST = /^[0-9a-f]{64}$/;
/** A preview nobody published is dropped after this long. */
export const ISSUE_REPORT_PREVIEW_TTL_MS = 14 * 24 * 60 * 60_000;

export interface IssueReportPreview {
  schemaVersion: 1;
  digest: string;
  title: string;
  body: string;
  createdAt: string;
  /** The conversation that wrote it. */
  createdBy: string | null;
  /** Seats that read the stored text back, which is what they show the operator. */
  shownTo: string[];
  state: "preview" | "publishing" | "published";
  /** Set with `publishing`: who published, on whose words. */
  publication?: {
    by: string;
    approval: string;
    startedAt: string;
    publishedAt?: string;
    issueUrl?: string;
  };
}

/** The digest of a report's exact text. A change to either part changes it. */
export function issueReportDigest(report: { title: string; body: string }): string {
  return crypto.createHash("sha256").update(JSON.stringify([report.title, report.body])).digest("hex");
}

export const issueReportsDir = () => statePath("issue-reports");

function fileOf(digest: string, directory: string): string {
  return path.join(directory, `${digest}.json`);
}

function write(preview: IssueReportPreview, directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = fileOf(preview.digest, directory);
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(preview, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
}

/** The stored preview, or null when there is none or its text no longer
    matches the digest it is filed under. */
export function readIssueReportPreview(digest: string, directory = issueReportsDir()): IssueReportPreview | null {
  if (!ISSUE_REPORT_DIGEST.test(digest)) return null;
  let parsed: IssueReportPreview;
  try {
    parsed = JSON.parse(fs.readFileSync(fileOf(digest, directory), "utf8")) as IssueReportPreview;
  } catch {
    return null;
  }
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.title !== "string" || typeof parsed.body !== "string") return null;
  if (parsed.digest !== digest || issueReportDigest(parsed) !== digest) return null;
  return { ...parsed, shownTo: Array.isArray(parsed.shownTo) ? parsed.shownTo.filter((id) => typeof id === "string") : [] };
}

function prune(directory: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const digest = name.slice(0, -".json".length);
    const preview = readIssueReportPreview(digest, directory);
    if (preview && (preview.state !== "preview" || now - Date.parse(preview.createdAt) < ISSUE_REPORT_PREVIEW_TTL_MS)) continue;
    try { fs.rmSync(path.join(directory, name), { force: true }); } catch { /* Left for the next pass. */ }
  }
}

/** Records a scrubbed report. The same text previewed again is the same preview. */
export function recordIssueReportPreview(
  report: { title: string; body: string },
  createdBy: string | null,
  options: { directory?: string; now?: Date } = {},
): IssueReportPreview {
  const directory = options.directory ?? issueReportsDir();
  const now = options.now ?? new Date();
  prune(directory, now.getTime());
  const digest = issueReportDigest(report);
  const existing = readIssueReportPreview(digest, directory);
  if (existing) return existing;
  const preview: IssueReportPreview = {
    schemaVersion: 1, digest, title: report.title, body: report.body,
    createdAt: now.toISOString(), createdBy, shownTo: [], state: "preview",
  };
  write(preview, directory);
  return preview;
}

/** Notes that a seat read the stored text back. */
export function markIssueReportShown(digest: string, seat: string, directory = issueReportsDir()): IssueReportPreview | null {
  const preview = readIssueReportPreview(digest, directory);
  if (!preview) return null;
  if (preview.shownTo.includes(seat)) return preview;
  const next = { ...preview, shownTo: [...preview.shownTo, seat] };
  write(next, directory);
  return next;
}

export function saveIssueReportPreview(preview: IssueReportPreview, directory = issueReportsDir()): void {
  write(preview, directory);
}
