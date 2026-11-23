import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { retentionErrorDetails } from "./retentionLog";

test("no errors adds no details", () => {
  expect(retentionErrorDetails([])).toBe("");
});

test("one error keeps its reason and uses a home-relative path", () => {
  const error = `Error: EACCES: scandir '${path.join(os.homedir(), "cache", "releases")}'`;
  const errors = [error];
  expect(retentionErrorDetails(errors)).toBe(": Error: EACCES: scandir '~/cache/releases'");
  expect(errors).toEqual([error]);
});

test("several errors each retain their reason in order", () => {
  expect(retentionErrorDetails(["Error: EACCES: scandir", "Error: removal refused", "Error: invalid journal"]))
    .toBe(": Error: EACCES: scandir; Error: removal refused; Error: invalid journal");
});

test("details bound error count and length and name omitted errors", () => {
  const errors = Array.from({ length: 8 }, (_, i) => `error ${i}: ${"x".repeat(1_000)}`);
  const details = retentionErrorDetails(errors);
  expect(details).toBe(": " + errors.slice(0, 5).map(error => error.slice(0, 239) + "…").join("; ") + "; … 3 more");
  expect(details.length).toBeLessThan(1_300);
  expect(errors[0]).toHaveLength(1_009);
});

test("control characters cannot split the summary or inject terminal commands", () => {
  const details = retentionErrorDetails(["Error:\nremoval\rrefused\t\u001b[31m\u2028next\u2029line\u202e"]);
  expect(details).toBe(": Error: removal refused [31m next line");
  expect(details).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test("external paths and home-prefix lookalikes are hidden", () => {
  const outside = path.join(os.tmpdir(), "outside-retention", "releases");
  const lookalike = os.homedir() + "-other/releases";
  expect(retentionErrorDetails([`readlink '${outside}'`, `scandir '${lookalike}'`]))
    .toBe(": readlink '<path>'; scandir '<path>'");
});

test("foreign platform absolute paths are hidden", () => {
  const windows = ["C:", "cache", "releases"].join("\\");
  const unc = "\\\\" + ["server", "share", "releases"].join("\\");
  expect(retentionErrorDetails([`scandir '${windows}'`, `remove '${unc}'`]))
    .toBe(": scandir '<path>'; remove '<path>'");
});

test("rooted Windows paths are hidden while home-relative paths stay readable", () => {
  const rooted = String.raw`\external-cache\releases`;
  expect(path.win32.isAbsolute(rooted)).toBe(true);
  expect(retentionErrorDetails([
    `Error: EACCES: scandir '${rooted}'`,
    String.raw`remove '~\cache\releases'`,
  ])).toBe(": Error: EACCES: scandir '<path>'; remove '~/cache/releases'");
});
