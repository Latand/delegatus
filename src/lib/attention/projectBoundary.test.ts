import { expect, test } from "bun:test";

import { canonicalClientProject } from "@/lib/projects/clientAliases";

import { captionTargetForRequest, requestCrossesProject } from "./projectBoundary";
import type { AttentionRequestV1 } from "./types";

const frame = (project: string) => ({ project, rect: { x: 0, y: 0, w: 1, h: 1 }, boardRevision: null });
const ask = (overrides: Partial<AttentionRequestV1> = {}): Pick<AttentionRequestV1, "origin" | "state" | "frameAtCreation" | "target"> => ({
  origin: "root-agent",
  state: "accepted",
  frameAtCreation: frame("repo-a"),
  target: { kind: "conversation", path: "/tmp/a.jsonl" },
  ...overrides,
});
const identity = (project: string) => project;

test("a request for the project the operator is in moves them", () => {
  expect(requestCrossesProject(ask(), "repo-a", identity)).toBe(false);
});

test("a request for another project does not move them", () => {
  expect(requestCrossesProject(ask(), "repo-b", identity)).toBe(true);
});

test("an alias of the same project is the same project, on either side", () => {
  const aliases = { "repo-old": "repo-a" };
  const canonical = (project: string) => canonicalClientProject(project, aliases);
  expect(requestCrossesProject(ask(), "repo-old", canonical)).toBe(false);
  expect(requestCrossesProject(ask({ frameAtCreation: frame("repo-old") }), "repo-a", canonical)).toBe(false);
  expect(requestCrossesProject(ask(), "repo-unrelated", canonical)).toBe(true);
});

test("the operator's own command is never held back", () => {
  expect(requestCrossesProject(ask({ origin: "operator" }), "repo-b", identity)).toBe(false);
});

test("a view with no project open keeps a directed move, and is never permission for a request nobody directed", () => {
  expect(requestCrossesProject(ask({ state: "accepted" }), null, identity)).toBe(false);
  expect(requestCrossesProject(ask({ state: "pending" }), null, identity)).toBe(true);
  expect(requestCrossesProject(ask({ state: "offered" }), null, identity)).toBe(true);
});

test("the notification's click names the card, or the project when no card shows the target", () => {
  expect(captionTargetForRequest(ask())).toEqual({ kind: "conversation", path: "/tmp/a.jsonl" });
  expect(captionTargetForRequest(ask({ target: { kind: "pipeline", pipelineId: "p1" } }))).toEqual({ kind: "lane", pipelineId: "p1", project: "repo-a" });
  expect(captionTargetForRequest(ask({ target: { kind: "stage", pipelineId: "p1", stageId: "s1" } }))).toEqual({ kind: "lane", pipelineId: "p1", project: "repo-a" });
  expect(captionTargetForRequest(ask({ target: { kind: "task", taskId: "t1" } }))).toEqual({ kind: "project", project: "repo-a" });
  expect(captionTargetForRequest(ask({ target: { kind: "region", project: "repo-a", rect: { x: 0, y: 0, w: 1, h: 1 } } }))).toEqual({ kind: "project", project: "repo-a" });
});
