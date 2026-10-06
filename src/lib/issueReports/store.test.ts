import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claimIssueReportPublication, issueReportDigest, markIssueReportShown, readIssueReportPreview,
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

test("old previews, readings and publication receipts survive an unrelated preview", () => {
  const old = new Date("2026-01-01T00:00:00.000Z");
  const stale = recordIssueReportPreview(REPORT, null, { directory, now: old }).digest;
  markIssueReportShown(stale, "conversation_seat", { directory });
  const filed = recordIssueReportPreview({ ...REPORT, title: "Another report" }, null, { directory, now: old }).digest;
  claimIssueReportPublication(filed, CLAIM, directory);
  settleIssueReportPublication(filed, { ...CLAIM, issueUrl: ISSUE_URL }, directory);

  recordIssueReportPreview({ ...REPORT, title: "A third report" }, null, { directory });
  expect(readIssueReportPreview(stale, directory)).toMatchObject({ state: "preview", shown: [{ seat: "conversation_seat" }] });
  expect(readIssueReportPreview(filed, directory)).toMatchObject({ state: "published", publication: { issueUrl: ISSUE_URL } });
  expect(claimIssueReportPublication(filed, CLAIM, directory)).toBe(false);
});

test("preview creation preserves another process's unfinished immutable record", () => {
  const digest = issueReportDigest(REPORT);
  const other = { ...REPORT, title: "Another report" };
  const write = fs.writeFileSync.bind(fs);
  let interleaved = false;
  const writing = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    write(file, data, options);
    if (!interleaved && String(file).startsWith(path.join(directory, `${digest}.json.`)) && String(file).endsWith(".tmp")) {
      interleaved = true;
      recordIssueReportPreview(other, null, { directory });
    }
  });
  try {
    expect(recordIssueReportPreview(REPORT, null, { directory })).toMatchObject({ digest, state: "preview" });
  } finally {
    writing.mockRestore();
  }
  expect(interleaved).toBe(true);
  expect(readIssueReportPreview(issueReportDigest(other), directory)).toMatchObject({ title: other.title });
});

test("an unrelated preview preserves a publication fence across release and reclaim", () => {
  const { digest } = recordIssueReportPreview(REPORT, null, { directory, now: new Date("2026-01-01T00:00:00.000Z") });
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(true);
  const file = path.join(directory, `${digest}.publication.json`);
  const exists = fs.existsSync.bind(fs);
  let interleaved = false;
  const checking = spyOn(fs, "existsSync").mockImplementation((candidate) => {
    if (!interleaved && String(candidate) === file) {
      interleaved = true;
      releaseIssueReportPublication(digest, directory);
      const present = exists(candidate);
      expect(claimIssueReportPublication(digest, { ...CLAIM, by: "conversation_other" }, directory)).toBe(true);
      return present;
    }
    return exists(candidate);
  });
  try {
    recordIssueReportPreview({ ...REPORT, title: "Another report" }, null, { directory });
  } finally {
    checking.mockRestore();
  }
  /* Removing retention removes the check-and-delete window altogether;
     implementations that still inspect it must preserve the new claim. */
  expect(readIssueReportPreview(digest, directory)).toMatchObject({ state: "publishing" });
  expect(claimIssueReportPublication(digest, CLAIM, directory)).toBe(false);
});
