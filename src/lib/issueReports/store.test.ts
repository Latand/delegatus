import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimIssueReportPublication, ISSUE_REPORT_PREVIEW_TTL_MS, issueReportDigest, markIssueReportShown, readIssueReportPreview,
  recordIssueReportPreview, releaseIssueReportPublication, settleIssueReportPublication,
} from "./store";

/* #2518: several MCP server processes share this directory, so each fact is a
   file created once and the claim on a publication has exactly one holder. */

const REPORT = { title: "A tool answered twice", body: "## Symptom\nIt answered twice." };
const CLAIM = { by: "conversation_seat", approval: "yes", approvedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z" };
const ISSUE_URL = `https://${["github", "com"].join(".")}/example/delegatus/issues/7`;

let directory = "";
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-store-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

test("the first reading by a seat is the one kept, and reading changes no state", () => {
  const { digest } = recordIssueReportPreview(REPORT, "conversation_reporter", { directory });
  expect(digest).toBe(issueReportDigest(REPORT));
  markIssueReportShown(digest, "conversation_seat", { directory, now: new Date("2026-01-01T00:00:00.000Z") });
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(true);
  /* A reading that lands while the claim is held cannot return the preview to an earlier state. */
  const read = markIssueReportShown(digest, "conversation_seat", { directory, now: new Date("2026-02-01T00:00:00.000Z") });
  markIssueReportShown(digest, "conversation_other", { directory, now: new Date("2026-02-01T00:00:00.000Z") });
  expect(read).toMatchObject({ state: "publishing", publication: { by: "conversation_seat" } });
  expect(readIssueReportPreview(digest, directory)?.shown.find((row) => row.seat === "conversation_seat")?.at).toBe("2026-01-01T00:00:00.000Z");
  expect(readIssueReportPreview(digest, directory)?.shown).toHaveLength(2);
  /* Previewing the same text again does not reset it either. */
  expect(recordIssueReportPreview(REPORT, "conversation_reporter", { directory }).state).toBe("publishing");
});

test("one claim per digest: a second is refused until the holder releases it, and never after it settled", () => {
  const { digest } = recordIssueReportPreview(REPORT, null, { directory });
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(true);
  expect(claimIssueReportPublication(digest, { ...CLAIM, by: "conversation_other" }, directory)).toBe(false);
  expect(readIssueReportPreview(digest, directory)).toMatchObject({ state: "publishing", publication: { by: "conversation_seat" } });

  releaseIssueReportPublication(digest, directory);
  expect(readIssueReportPreview(digest, directory)?.state).toBe("preview");
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(true);
  settleIssueReportPublication(digest, { ...CLAIM, publishedAt: "2026-01-01T00:00:02.000Z", issueUrl: ISSUE_URL }, directory);
  expect(readIssueReportPreview(digest, directory)).toMatchObject({ state: "published", publication: { issueUrl: ISSUE_URL } });
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(false);
});

test("processes racing for one digest: exactly one takes the claim", () => {
  const { digest } = recordIssueReportPreview(REPORT, null, { directory });
  const script = `
    import { claimIssueReportPublication } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))};
    const [digest, directory, start] = process.argv.slice(2);
    while (Date.now() < Number(start)) {}
    const won = claimIssueReportPublication(digest, { by: String(process.pid), approval: "", approvedAt: "", startedAt: "" }, directory);
    process.stdout.write(won ? "won" : "lost");
  `;
  const file = path.join(directory, "racer.ts");
  fs.writeFileSync(file, script);
  const racer = `for i in 1 2 3 4 5 6 7 8; do ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} "$1" "$2" "$3" > "$2/racer.$i.out" & done; wait`;
  const run = spawnSync("sh", ["-c", racer, "sh", digest, directory, String(Date.now() + 1_500)], { env: { ...process.env, LLV_STATE_DIR: directory }, timeout: 60_000 });
  expect(run.status).toBe(0);
  const outcomes = fs.readdirSync(directory).filter((name) => /^racer\.\d\.out$/.test(name)).map((name) => fs.readFileSync(path.join(directory, name), "utf8"));
  expect(outcomes).toHaveLength(8);
  expect(outcomes.filter((outcome) => outcome === "won")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "lost")).toHaveLength(7);
});

test("an old preview nobody published is dropped with its readings; a publication is kept", () => {
  const old = new Date(Date.now() - ISSUE_REPORT_PREVIEW_TTL_MS - 60_000);
  const stale = recordIssueReportPreview(REPORT, null, { directory, now: old }).digest;
  markIssueReportShown(stale, "conversation_seat", { directory });
  const filed = recordIssueReportPreview({ ...REPORT, title: "Another report" }, null, { directory, now: old }).digest;
  claimIssueReportPublication(filed, CLAIM, directory);

  recordIssueReportPreview({ ...REPORT, title: "A third report" }, null, { directory });
  expect(readIssueReportPreview(stale, directory)).toBeNull();
  expect(fs.readdirSync(directory).filter((name) => name.startsWith(stale))).toEqual([]);
  expect(readIssueReportPreview(filed, directory)?.state).toBe("publishing");
});
