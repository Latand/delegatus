import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* The project settings route (#2187 §4.1): the board reads the merge setting
   with whether the project has a GitHub repository, and the operator's PUT
   writes it under the canonical key. A sandboxed state directory, pinned
   before the stores load. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-settings-route-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;
fs.writeFileSync(path.join(SANDBOX, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "repo-with-github": "github.com/acme/widgets" } }));

const { GET, PUT } = await import("./route");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:8899";
const get = (project: string) => GET(new NextRequest(`${ORIGIN}/api/projects/settings?project=${encodeURIComponent(project)}`));
const put = (body: unknown) => PUT(new NextRequest(`${ORIGIN}/api/projects/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:8899" },
  body: JSON.stringify(body),
}));

test("the setting reads off by default, turns on through PUT, and says when the project has no GitHub repository", async () => {
  const before = await (await get("repo-with-github")).json();
  expect(before).toMatchObject({ ok: true, project: "repo-with-github", mergeOnReview: { enabled: false }, github: "acme/widgets" });
  const on = await put({ project: "repo-with-github", mergeOnReview: true });
  expect(on.status).toBe(200);
  expect((await on.json()).mergeOnReview).toMatchObject({ enabled: true, changedBy: "operator" });
  expect((await (await get("repo-with-github")).json()).mergeOnReview.enabled).toBe(true);
  expect((await (await get("dir-no-remote")).json())).toMatchObject({ mergeOnReview: { enabled: false }, github: null });
  expect((await put({ project: "repo-with-github", mergeOnReview: "yes" })).status).toBe(400);
  expect((await get("")).status).toBe(400);
});

/* #2146: Bridge reports read on by default, and a PUT carrying only that
   switch leaves the merge setting as it was. */
test("the bridge reports setting reads on by default and turns off through its own PUT", async () => {
  const before = await (await get("repo-bridge")).json();
  expect(before.bridgeReports).toMatchObject({ enabled: true, changedAt: null });
  const off = await put({ project: "repo-bridge", bridgeReports: false });
  expect(off.status).toBe(200);
  const body = await off.json();
  expect(body.bridgeReports).toMatchObject({ enabled: false, changedBy: "operator" });
  expect(body.mergeOnReview.enabled).toBe(false);
  expect((await (await get("repo-bridge")).json()).bridgeReports.enabled).toBe(false);
  await put({ project: "repo-bridge", mergeOnReview: true });
  expect((await (await get("repo-bridge")).json())).toMatchObject({ bridgeReports: { enabled: false }, mergeOnReview: { enabled: true } });
  expect((await put({ project: "repo-bridge", bridgeReports: "off" })).status).toBe(400);
  expect((await put({ project: "repo-bridge" })).status).toBe(400);
});
