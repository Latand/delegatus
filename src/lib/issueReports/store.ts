import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { IssueReportFinding } from "./scrub";

import { statePath } from "@/lib/configDir";

/*
 * The previews of Delegatus bug reports (#2518), filed by the digest of their
 * text.
 *
 * The digest is the whole contract between what the operator read and what is
 * published: a preview is stored under it, the seat reads the stored text back
 * to show it, and publication takes the digest and sends the stored text. No
 * caller hands publication a title or a body, so the published text cannot
 * differ from the previewed one. An edit is a new preview with a new digest.
 *
 * Several MCP server processes write here at once (the reporter's, and every
 * seat's), so nothing is read, changed and written back. Each fact is its own
 * file, and each is created once:
 *
 *  - `<digest>.json`: the text, written when it is previewed and never again;
 *  - `<digest>.shown.<seat>.json`: when one seat first read it back;
 *  - `<digest>.publication.json`: the claim on publishing it. It is created
 *    exclusively, so of any number of publications racing for one digest
 *    exactly one holds the claim and reaches the forge. The holder replaces it
 *    with the issue's address, or removes it when the forge provably refused
 *    before anything was written. A claim nobody settled stays, and says the
 *    outcome is unknown.
 */

export const ISSUE_REPORT_DIGEST = /^[0-9a-f]{64}$/;

export interface IssueReportPublication {
  /** The seat that published. */
  by: string;
  /** The operator's approving message, as the seat's transcript recorded it. */
  approval: string;
  approvedAt: string;
  startedAt: string;
  publishedAt?: string;
  issueUrl?: string;
}

export interface IssueReportPrivacyJudgment {
  assessment: string;
  removed: string;
  harmlessHints: string;
  uncertainties: string;
}

export interface IssueReportReview {
  privacyJudgment: IssueReportPrivacyJudgment;
  hints: IssueReportFinding[];
  hintWarnings: string[];
}

export interface IssueReportPreview extends Partial<IssueReportReview> {
  schemaVersion: 1;
  digest: string;
  title: string;
  body: string;
  createdAt: string;
  /** The conversation that wrote it. */
  createdBy: string | null;
  /** When each seat first read the stored text back, which is what it shows the operator. */
  shown: { seat: string; at: string }[];
  /** `publishing` is a claim nobody settled: the forge may hold the issue. */
  state: "preview" | "publishing" | "published";
  publication?: IssueReportPublication;
}

/** The digest of a report's exact text. A change to either part changes it. */
export function issueReportDigest(report: { title: string; body: string }): string {
  return crypto.createHash("sha256").update(JSON.stringify([report.title, report.body])).digest("hex");
}

export const issueReportsDir = () => statePath("issue-reports");

const textFile = (digest: string, directory: string) => path.join(directory, `${digest}.json`);
const publicationFile = (digest: string, directory: string) => path.join(directory, `${digest}.publication.json`);
const shownFile = (digest: string, seat: string, directory: string) =>
  path.join(directory, `${digest}.shown.${crypto.createHash("sha256").update(seat).digest("hex").slice(0, 16)}.json`);

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Creates a file with its whole content, or answers false when it exists.
    The content is linked in complete, so no reader meets half a record. */
function createOnce(file: string, value: unknown): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function publicationOf(digest: string, directory: string): IssueReportPublication | null {
  const file = publicationFile(digest, directory);
  const parsed = readJson(file);
  if (!parsed) {
    /* A claim that cannot be read is still a claim. */
    return fs.existsSync(file) ? { by: "", approval: "", approvedAt: "", startedAt: "" } : null;
  }
  const word = (key: string) => (typeof parsed[key] === "string" ? parsed[key] as string : "");
  return {
    by: word("by"), approval: word("approval"), approvedAt: word("approvedAt"), startedAt: word("startedAt"),
    ...(word("publishedAt") ? { publishedAt: word("publishedAt") } : {}),
    ...(word("issueUrl") ? { issueUrl: word("issueUrl") } : {}),
  };
}

/** The stored preview, or null when there is none or its text no longer
    matches the digest it is filed under. */
export function readIssueReportPreview(digest: string, directory = issueReportsDir()): IssueReportPreview | null {
  if (!ISSUE_REPORT_DIGEST.test(digest)) return null;
  const parsed = readJson(textFile(digest, directory));
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.title !== "string" || typeof parsed.body !== "string") return null;
  if (parsed.digest !== digest || issueReportDigest({ title: parsed.title, body: parsed.body }) !== digest) return null;
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { /* No one read it back. */ }
  const shown = names
    .filter((name) => name.startsWith(`${digest}.shown.`) && name.endsWith(".json"))
    .map((name) => readJson(path.join(directory, name)))
    .filter((row): row is { seat: string; at: string } => typeof row?.seat === "string" && typeof row.at === "string")
    .map((row) => ({ seat: row.seat, at: row.at }));
  const publication = publicationOf(digest, directory);
  return {
    schemaVersion: 1, digest, title: parsed.title, body: parsed.body,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    createdBy: typeof parsed.createdBy === "string" ? parsed.createdBy : null,
    ...(parsed.privacyJudgment ? { privacyJudgment: parsed.privacyJudgment as IssueReportPrivacyJudgment } : {}),
    ...(Array.isArray(parsed.hints) ? { hints: parsed.hints as IssueReportFinding[] } : {}),
    ...(Array.isArray(parsed.hintWarnings) ? { hintWarnings: parsed.hintWarnings as string[] } : {}),
    shown,
    state: !publication ? "preview" : publication.issueUrl ? "published" : "publishing",
    ...(publication ? { publication } : {}),
  };
}

/** Records a report with its advisory review. The same text previewed again is the same preview.
    Records are retained: an inline cleanup cannot distinguish another process's
    unfinished immutable write or protect a publication being claimed. */
export function recordIssueReportPreview(
  report: { title: string; body: string } & Partial<IssueReportReview>,
  createdBy: string | null,
  options: { directory?: string; now?: Date } = {},
): IssueReportPreview {
  const directory = options.directory ?? issueReportsDir();
  const now = options.now ?? new Date();
  const digest = issueReportDigest(report);
  const existing = readIssueReportPreview(digest, directory);
  if (existing) return existing;
  /* Text filed under this digest that is not this text is replaced whole. */
  fs.rmSync(textFile(digest, directory), { force: true });
  createOnce(textFile(digest, directory), { schemaVersion: 1, digest, title: report.title, body: report.body, privacyJudgment: report.privacyJudgment, hints: report.hints, hintWarnings: report.hintWarnings, createdAt: now.toISOString(), createdBy });
  return readIssueReportPreview(digest, directory)!;
}

/** Notes that a seat read the stored text back. The first reading is the one
    kept: an approval counts from the moment the seat could first show it. */
export function markIssueReportShown(digest: string, seat: string, options: { directory?: string; now?: Date } = {}): IssueReportPreview | null {
  const directory = options.directory ?? issueReportsDir();
  if (!readIssueReportPreview(digest, directory)) return null;
  createOnce(shownFile(digest, seat, directory), { seat, at: (options.now ?? new Date()).toISOString() });
  return readIssueReportPreview(digest, directory);
}

/** Takes the one claim on publishing this preview. False when it is taken. */
export function claimIssueReportPublication(digest: string, claim: IssueReportPublication, directory = issueReportsDir()): boolean {
  return createOnce(publicationFile(digest, directory), claim);
}

/** The claim holder's record that the issue exists. */
export function settleIssueReportPublication(digest: string, publication: IssueReportPublication, directory = issueReportsDir()): void {
  const file = publicationFile(digest, directory);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(publication, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The claim holder's record that the forge refused before any issue could
    exist, so the preview may be published again. */
export function releaseIssueReportPublication(digest: string, directory = issueReportsDir()): void {
  fs.rmSync(publicationFile(digest, directory), { force: true });
}
