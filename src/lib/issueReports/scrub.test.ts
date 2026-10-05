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

/* The review of #2518 found each of the following passing. A report is read
   the way Markdown will render it, the detectors keep none of the allowances a
   manager report has, and somebody else's words are refused in every form. */

const entity = (text: string) => [...text].map((char) => `&#${char.codePointAt(0)};`).join("");
const percent = (text: string) => [...text].map((char) => `%${char.codePointAt(0)!.toString(16).padStart(2, "0")}`).join("");

test("an encoded value is read as the text a reader will see", () => {
  const slash = entity("/");
  expect(classes(`The transcript is under ${["", "home", "someone", "notes.md"].join(slash)}.`)).toEqual(expect.arrayContaining(["path", "home_path"]));
  expect(classes(`The transcript is under ${["", "home", "someone", "notes.md"].join(percent("/"))}.`)).toContain("home_path");
  expect(classes(`It failed on ${["build", "box"].join("-")}${entity(".")}${"lan"}.`)).toContain("domain");
  expect(classes(`The account is registered to ${at.replace("@", entity("@"))}.`)).toContain("email");
  expect(classes(`The account is registered to ${at.replace("@", "&commat;")}.`)).toContain("email");
  expect(classes(`The card ${taskId.replaceAll("-", entity("-"))} stayed open.`)).toContain("id");
  expect(classes(`The listener at ${[203, 0, 113, 7].join("\\.")} refused.`)).toContain("ip");
  /* Nested: an entity whose ampersand is itself an entity, inside a percent escape. */
  const nested = percent(entity("/").replace("&", "&amp;"));
  expect(classes(`The transcript is under ${["", "home", "someone", "notes.md"].join(nested)}.`)).toContain("home_path");
  /* A zero-width character inside a value hides it from a pattern only. */
  expect(classes(`The seat ${"conver"}​${"sation_"}seatabc123 was busy.`)).toContain("id");

  const deny: PublicDenyList = { accounts: [], people: ["Ostap Vyshnia"], local: [], projects: [] };
  expect(classes(`Ostap${entity(" ")}Vyshnia observed the refusal.`, deny)).toContain("person");
  expect(classes("Ostap&nbsp;Vyshnia observed the refusal.", deny)).toContain("person");
});

test("an encoded value is refused without the value appearing in the finding", () => {
  const body = `The file is ${["", "home", "someone", "notes.md"].join(entity("/"))}.`;
  const findings = scrubIssueReport({ title: CLEAN.title, body });
  expect(findings.map((finding) => finding.class)).toContain("home_path");
  expect(findings.every((finding) => finding.where === "body" && finding.lines.join() === "1")).toBe(true);
  expect(JSON.stringify(findings)).not.toContain("someone");
});

test("hosts, addresses, paths and ids are found in their real forms", () => {
  expect(classes(`It failed on ${"buildbox"}.${"fr"}.`)).toContain("domain");
  expect(classes(`It failed on ${"buildbox"}.${"example"}.${"shop"} twice.`)).toContain("domain");
  expect(classes(`It failed at ${"fd00"}::${"1234"}.`)).toContain("ip");
  expect(classes(`It failed at ${"fe80"}::${"1"}:${"2"} once.`)).toContain("ip");
  expect(classes(`It listened on ::${"1"} only.`)).toContain("ip");
  expect(classes(`The state is stored at ${["", "дані", "особисте", "звіт.json"].join("/")}.`)).toContain("path");
  /* A pipeline id is the first eight characters of a UUID: all digits and all letters are both ids. */
  expect(classes(`The pipeline ${"1234" + "5678"} failed.`)).toContain("id");
  expect(classes(`The pipeline ${"dead" + "beef"} failed.`)).toContain("id");
  expect(classes(`The commit ${"0a1b2c3d".repeat(5)} is where it began.`)).toContain("id");
});

test("references to Delegatus's own code and tools stay readable", () => {
  for (const line of [
    "The settlement path in src/lib/mcp/bindings.ts.",
    "See docs/design/agent-prompt-contract.md and scripts/gate-slot.sh.",
    "The component is src/components/kanban/KanbanBoard.tsx, and package.json names the runtime.",
    "pipeline_action answered ok and conversation_messages answered an empty page.",
    "conversation_action, conversation_migration and conversation_deliverability all agreed.",
    "The answer came 3 times in 20 seconds, e.g. after each retry.",
    "The state called \"delivered\" never changed.",
    "The recipient's turn never started and the agents' queue stayed empty.",
  ]) expect(classes(line)).toEqual([]);
});

test("every known name is refused, however short or ordinary, and Delegatus alone passes", () => {
  const deny: PublicDenyList = {
    accounts: ["main"],
    people: ["Ada"],
    local: ["box"],
    projects: [{ repository: "example/Artemis", names: ["Artemis"] }, { repository: null, names: ["Delegatus", "tools"] }],
  };
  expect(classes("Ada observed the refusal.", deny)).toContain("person");
  expect(classes("The project Artemis failed to launch.", deny)).toContain("project");
  expect(classes("The launch picked the account called main.", deny)).toContain("account");
  expect(classes("It only happens on box.", deny)).toContain("host");
  expect(classes("A seat of tools sent the message.", deny)).toContain("project");
  expect(classes("Delegatus refused the launch, and adaptation of the mandate did not help.", deny)).toEqual([]);
});

test("somebody else's words are refused as a quotation, a quoted block or a conversation line", () => {
  for (const line of [
    "The operator said: \"restart every agent now\".",
    "The operator said: “restart every agent now”.",
    "Оператор написав: «перезапусти всіх агентів зараз».",
    "Оператор написав: „перезапусти всіх агентів“.",
    "The operator said: 'restart every agent now'.",
    "The operator said: &quot;restart every agent now&quot;.",
    "> restart every agent now",
    "Operator: restart every agent now",
    "**User:** restart every agent now",
    "- [human] restart every agent now",
    "Оператор: перезапусти всіх агентів",
  ]) expect(classes(line)).toContain("quote");
  expect(classes("The operator asked for every agent to be restarted at once.")).toEqual([]);
});

/* The second review of #2518 found the following passing: Markdown markup
   inside a value, a top-level domain outside a short list, a folder with a
   space in its name, and a quotation over more than two lines. */

test("a value broken up by Markdown markup is read as the word a reader sees", () => {
  const deny: PublicDenyList = {
    accounts: ["claude-main-b"], people: ["Ada"], local: [], projects: [{ repository: "example/Artemis", names: ["Artemis"] }],
  };
  expect(classes("A**da** observed the failure.", deny)).toContain("person");
  expect(classes("A<b>da</b> observed the failure.", deny)).toContain("person");
  expect(classes("A<!-- -->da observed the failure.", deny)).toContain("person");
  expect(classes("[A](#)da observed the failure.", deny)).toContain("person");
  expect(classes("The launch picked claude-**main**-b.", deny)).toContain("account");
  expect(classes("The project Arte~~mis~~ failed to launch.", deny)).toContain("project");
  expect(classes(`The pipeline ${"dead"}**${"beef"}** stayed queued.`)).toContain("id");
  expect(classes(`The pipeline ${"dead"}\`${"beef"}\` stayed queued.`)).toContain("id");
  expect(classes(`The failure happened on ${"buildbox"}.**${"fr"}**.`)).toContain("domain");
  /* Formatted references to Delegatus's own code and tools stay readable. */
  for (const line of [
    "Call **issue_report** with action `preview`, then `mcp__viewer__issue_report` answers.",
    "The `send_message` tool answered __delivered__ in *src/lib/mcp/bindings.ts*.",
    "See [the contract](docs/design/agent-prompt-contract.md) for the rule.",
  ]) expect(classes(line, deny)).toEqual([]);
});

test("a domain is found whatever its top-level domain, in any script", () => {
  for (const host of [`${"buildbox"}.${"tools"}`, `${"buildbox"}.${"xn--p1ai"}`, `${"вузол"}.${"укр"}`, `${"buildbox"}．${"tools"}`, `${"build_box"}.${"cloud"}`]) {
    const findings = scrubIssueReport({ title: CLEAN.title, body: `The failure happened on ${host}.` });
    expect(findings.map((finding) => finding.class)).toContain("domain");
    expect(findings.find((finding) => finding.class === "domain")).toMatchObject({ where: "body", lines: [1], label: "a domain" });
    expect(JSON.stringify(findings)).not.toContain(host);
  }
  /* Code is no domain: a call follows it, or it ends in a file extension or a word no zone holds. */
  for (const line of [
    "The clock read Date.now() and rows.map(render) returned nothing.",
    "process.env.LLV_STATE_DIR was unset, and Node.js printed nothing.",
    "package.json, README.md and bun.lock were unchanged.",
  ]) expect(classes(line)).toEqual([]);
});

test("a local path with a space in a folder name is a path in every form", () => {
  expect(classes(`The evidence file is ${["", "My data", "notes.txt"].join("/")}.`)).toContain("path");
  expect(classes(`The evidence file is ${["", "Мої дані", "нотатки.txt"].join("/")}.`)).toContain("path");
  expect(classes(`The evidence file is ${percent("/My data/")}notes.txt.`)).toContain("path");
  expect(classes(`The evidence file is ${["", "My\\ data", "notes.txt"].join("/")}.`)).toContain("path");
  expect(classes(`The evidence file is ${["", "My", "data"].join("/").replace("My/", `My${entity(" ")}`)}/notes.txt.`)).toContain("path");
  expect(classes("The settlement path in src/lib/mcp/bindings.ts.")).toEqual([]);
});

test("a quotation over several lines is refused against the line it opens on", () => {
  const opened = (body: string) => scrubIssueReport({ title: CLEAN.title, body }).filter((finding) => finding.class === "quote");
  expect(opened("The operator said: \"restart\nevery agent\nnow\".")).toEqual([expect.objectContaining({ where: "body", lines: [1] })]);
  expect(opened("## Observed evidence\nThe operator said: “restart\nevery\nagent\nnow”.")).toEqual([expect.objectContaining({ lines: [2] })]);
  expect(opened("Intro.\nОператор написав: «перезапусти\nвсіх\nагентів».")).toEqual([expect.objectContaining({ lines: [2] })]);
  expect(opened("Intro.\n\nThe operator said: 'restart\nevery\nagent'.")).toEqual([expect.objectContaining({ lines: [3] })]);
  /* One-word terms on different lines pair with nothing, and a retelling passes. */
  expect(classes("The state \"delivered\" was shown.\nLater \"queued\" appeared.\nThen “parked”.")).toEqual([]);
  expect(classes("The recipient's turn never\nstarted, and the agents' queue\nstayed empty.")).toEqual([]);
  expect(classes("The operator asked\nfor every agent\nto be restarted.")).toEqual([]);
});
