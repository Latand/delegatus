import { expect, test } from "bun:test";

import { ForgeAppWriteRefused, forgeWriter } from "@/lib/forge/appWrite";

import manifest from "../../../package.json";

import { delegatusIssueRepository, issueReportFinder, issueReportPublisher } from "./publish";

/* #2518 with #2485: an approved report is one `gh issue create`, sent through
   the engine's GitHub write seam. No `gh` runs here and no issue is filed. */

const REPOSITORY = "example/delegatus";
const REPORT = { title: "A tool answered twice", body: "## Symptom\nIt answered twice." };
const issueUrl = (repository: string, number: number) => `https://${["github", "com"].join(".")}/${repository}/issues/${number}`;

test("the report is filed in the repository Delegatus's own manifest names", () => {
  const repository = delegatusIssueRepository(manifest.repository.url, undefined);
  expect(repository).toMatch(/^[\w.-]+\/delegatus$/);
  /* An install that deploys from its own remote reports there. */
  expect(delegatusIssueRepository(manifest.repository.url, `https://${["github", "com"].join(".")}/${REPOSITORY}.git`)).toBe(REPOSITORY);
  expect(delegatusIssueRepository("https://gitlab.example.invalid/acme/widgets.git", undefined)).toBeNull();
});

test("publication sends the stored title and body as one issue and answers its URL", async () => {
  const calls: { args: string[]; repository: string }[] = [];
  const publish = issueReportPublisher({
    writer: async (args, repository) => {
      calls.push({ args, repository });
      return `${issueUrl(repository, 4242)}\n`;
    },
  });
  expect(await publish(REPORT, REPOSITORY)).toBe(issueUrl(REPOSITORY, 4242));
  expect(calls).toEqual([{ repository: REPOSITORY, args: ["issue", "create", "--repo", REPOSITORY, "--title", REPORT.title, "--body", REPORT.body] }]);
});

test("in a declared App repository the issue goes out as the App, and a refused credential files nothing as a person", async () => {
  const person: string[][] = [];
  const app: string[][] = [];
  const declared = (repository: string) => repository === REPOSITORY;
  const viaApp = issueReportPublisher({
    writer: forgeWriter(async (args) => { person.push(args); return issueUrl("other/repo", 1); }, async (args, repository) => { app.push(args); return issueUrl(repository, 7); }, declared),
  });
  expect(await viaApp(REPORT, REPOSITORY)).toBe(issueUrl(REPOSITORY, 7));
  expect(app).toHaveLength(1);
  expect(person).toEqual([]);

  const refused = issueReportPublisher({
    writer: forgeWriter(async (args) => { person.push(args); return issueUrl(REPOSITORY, 1); }, async () => { throw new ForgeAppWriteRefused("Delegatus refused this GitHub write"); }, declared),
  });
  await expect(refused(REPORT, REPOSITORY)).rejects.toBeInstanceOf(ForgeAppWriteRefused);
  expect(person).toEqual([]);

  /* A repository this installation did not declare keeps the plain command. */
  const plain = issueReportPublisher({
    writer: forgeWriter(async (args) => { person.push(args); return issueUrl("other/repo", 3); }, async () => { throw new Error("the App is not asked"); }, declared),
  });
  expect(await plain(REPORT, "other/repo")).toBe(issueUrl("other/repo", 3));
  expect(person).toHaveLength(1);
});

test("an answer with no issue URL is a failure, never a published report", async () => {
  const publish = issueReportPublisher({ writer: async () => "Creating issue in the repository\n" });
  await expect(publish(REPORT, REPOSITORY)).rejects.toThrow("answered no issue URL");
});

/* A publication whose answer was lost is settled only by the issue itself. */
test("the finder answers an issue only when its title and body are the report's", async () => {
  const calls: string[][] = [];
  const rows = (list: unknown) => issueReportFinder({ run: async (args) => { calls.push(args); return JSON.stringify(list); } });
  const mine = { url: issueUrl(REPOSITORY, 9), title: REPORT.title, body: REPORT.body.replace(/\n/g, "\r\n") };

  expect(await rows([{ url: issueUrl(REPOSITORY, 8), title: REPORT.title, body: "Another body." }, mine])(REPORT, REPOSITORY)).toBe(mine.url);
  expect(calls[0]).toEqual(["issue", "list", "--repo", REPOSITORY, "--state", "all", "--limit", "30", "--search", `"${REPORT.title}" in:title`, "--json", "url,title,body"]);
  /* A similar issue is another report, and an empty answer proves nothing. */
  expect(await rows([{ url: issueUrl(REPOSITORY, 8), title: `${REPORT.title} again`, body: REPORT.body }])(REPORT, REPOSITORY)).toBeNull();
  expect(await rows([])(REPORT, REPOSITORY)).toBeNull();
  expect(await rows({ message: "not a list" })(REPORT, REPOSITORY)).toBeNull();
});
