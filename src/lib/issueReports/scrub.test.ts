import { expect, test } from "bun:test";

import type { PublicDenyList } from "@/lib/bridge/publicSafe";

import { scrubIssueReport, type IssueReportFindingClass } from "./scrub";

/*
 * #2518: what a Delegatus bug report may not carry is found before a preview
 * exists. The detectors are the two sets the repository already runs — the
 * public manager report's and the publication gate's — so each case below is
 * one of their classes reaching a report.
 *
 * Every private value here is assembled from parts, so this file holds no
 * address, path or id the publication gate would find in it.
 */

const CLEAN = {
  title: "create_pipeline answers store_busy with no pipeline queued",
  body: [
    "## Symptom",
    "create_pipeline answered store_busy and no pipeline appeared on the board.",
    "## Observed evidence",
    "The answer carried code store_busy. get_pipeline answered not found a minute later.",
    "## Impact",
    "A builder stage for a second project never started.",
    "## Expected behaviour",
    "The pipeline is queued and starts on the next controller pass.",
    "## Suggested investigation",
    "The queue path in src/lib/pipelines/engine.ts.",
  ].join("\n"),
};

const classes = (body: string, deny?: PublicDenyList): IssueReportFindingClass[] =>
  scrubIssueReport({ title: CLEAN.title, body }, deny).map((finding) => finding.class);

const at = ["someone", ["mail", "example", "org"].join(".")].join("@");
const home = ["", "home", "someone", "work", "notes.md"].join("/");
const taskId = ["3f2b8c1e", "9a4d", "4c7e", "b1a2", "0d9e8f7a6b5c"].join("-");

test("a report in the issue style with nothing private in it passes", () => {
  expect(scrubIssueReport(CLEAN)).toEqual([]);
});

test("a host, a path, an email and an id are each refused before a preview", () => {
  expect(classes(`The agent ran on ${["build", "box", "internal"].join("-")}.${"lan"} and failed.`)).toContain("domain");
  expect(classes(`It could not reach ${"local" + "host"} at all.`)).toContain("host");
  expect(classes(`The transcript sits under ${home}.`)).toEqual(expect.arrayContaining(["path", "home_path"]));
  expect(classes(`The account is registered to ${at}.`)).toContain("email");
  expect(classes(`The card ${taskId} stayed in progress.`)).toEqual(expect.arrayContaining(["id", "resource_identifier"]));
  expect(classes(`The lane ${"0f01" + "39a6"} parked.`)).toContain("id");
  expect(classes(`The seat ${"conversation" + "_"}seatabc123 was busy.`)).toContain("id");
});

test("addresses, ports, usage data, credentials and copied conversation lines are refused", () => {
  expect(classes(`The listener at ${[203, 0, 113, 7].join(".")} refused.`)).toContain("ip");
  expect(classes(`It runs inside ${[10, 0, 0, 12].join(".")}.`)).toEqual(expect.arrayContaining(["ip", "private_network"]));
  expect(classes("The stable listener is on port 8898.")).toContain("port");
  expect(classes("The account was at 93% of its weekly limit.")).toContain("usage");
  expect(classes(`The call sent ${"gh" + "p_"}${"a1B2c3D4e5F6g7H8".repeat(2)} in a header.`)).toEqual(expect.arrayContaining(["credential"]));
  expect(classes(["## Observed evidence", ["user", " please file this for me"].join(":")].join("\n"))).toContain("transcript_content");
  expect(classes("> restart it now, I do not care about the lanes")).toContain("quote");
  expect(classes(`![board](${"shot"}.png)`)).toContain("image");
});

test("the names this machine knows are refused: an account, a person, the local user, another project", () => {
  const deny: PublicDenyList = {
    accounts: ["claude-main-b"],
    people: ["Ostap Vyshnia"],
    local: ["buildbox"],
    projects: [{ repository: "acme/widget-shop", names: ["widget-shop"] }],
  };
  expect(classes("The launch picked claude-main-b and was refused.", deny)).toContain("account");
  expect(classes("Ostap Vyshnia saw the refusal first.", deny)).toContain("person");
  expect(classes("It only happens on buildbox.", deny)).toContain("host");
  expect(classes("A seat on widget-shop sent the message.", deny)).toContain("project");
  /* Delegatus itself is the one project a report names. */
  expect(classes("Delegatus refused the launch.", deny)).toEqual([]);
});

test("a finding names the class, where it is and the lines, and never the value", () => {
  const body = `${CLEAN.body}\nSeen while reading ${home}.\nAnd again under ${home}.`;
  const findings = scrubIssueReport({ title: `Refused on ${"local" + "host"}`, body });
  const path = findings.find((finding) => finding.class === "path")!;
  const lineCount = CLEAN.body.split("\n").length;
  expect(path).toMatchObject({ where: "body", label: "a local path", lines: [lineCount + 1, lineCount + 2] });
  expect(findings.find((finding) => finding.where === "title")).toMatchObject({ class: "host", lines: [1] });
  expect(JSON.stringify(findings)).not.toContain("someone");
});
