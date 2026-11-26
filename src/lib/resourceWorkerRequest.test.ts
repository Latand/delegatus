import { describe, expect, test } from "bun:test";

import { resourceWorkerRequestProblem, type ResourceWorkerRequest } from "./resourceWorkerRequest";
import { resourceWorkerFileSnapshot } from "./resources";

describe("OpenClaw resource-worker requests", () => {
  const files = resourceWorkerFileSnapshot([{
    path: "/workspace/.openclaw/agents/main/sessions/session.jsonl",
    parent: null,
    title: "OpenClaw session",
    project: "workspace",
    activity: "idle",
    mtime: 1_700_000_000_000,
    engine: "openclaw",
    pid: null,
    proc: null,
  }], () => "conversation_openclaw");
  const request: ResourceWorkerRequest = {
    type: "collect",
    fresh: true,
    files,
    identityEpoch: null,
    hosts: [],
  };

  test("accepts the production projection of an OpenClaw file observation", () => {
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ engine: "openclaw", conversationId: "conversation_openclaw" });
    expect(resourceWorkerRequestProblem(request)).toBeNull();
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, "invalid"])("refuses malformed OpenClaw mtime %s", (mtime) => {
    expect(resourceWorkerRequestProblem({
      ...request,
      files: [{ ...files[0]!, mtime }],
    })).toBe("files[0] mtime");
  });

  test("refuses an unknown engine in an otherwise valid projection", () => {
    expect(resourceWorkerRequestProblem({
      ...request,
      files: [{ ...files[0]!, engine: "unknown" }],
    })).toBe("files[0] engine unknown");
  });
});
