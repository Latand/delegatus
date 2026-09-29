import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import type { FileEntry, PendingQuestion } from "@/lib/types";

import { POST } from "./route";

test("a pending answer records one direct operator gesture and excludes internal service traffic", async () => {
  const entry = {
    path: "/sessions/operator-answer-fixture.jsonl",
    root: "claude-projects",
    name: "operator-answer-fixture.jsonl",
    project: "project-fixture",
    title: "fixture",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "running",
    pid: 43,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  const recorded: unknown[] = [];
  const dependencies = {
    knownState: async (_transcriptPath: string, toolUseId: string) => ({
      entry,
      pending: { toolUseId } as PendingQuestion,
      result: null,
    }),
    resolveTarget: async () => "agents:2.0",
    recordOperatorRequest: (_request: unknown, input: unknown) => { recorded.push(input); return null; },
    deliverAnswer: async () => "Continue",
    confirmAnswered: async () => "Continue",
    paneScreen: async () => "",
  };
  const post = (toolUseId: string, headers: Record<string, string> = {}) => POST.withDependencies(
    new NextRequest("http://127.0.0.1/api/answer", {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        transcriptPath: entry.path,
        toolUseId,
        kind: "single",
        option: 0,
      }),
    }),
    dependencies,
  );

  const direct = await post("tool-answer-direct-one");
  const synthetic = await post("tool-answer-synthetic-one", internalServiceHeaders("mcp"));

  expect([direct.status, synthetic.status]).toEqual([200, 200]);
  expect(recorded).toEqual([expect.objectContaining({
    path: entry.path,
    idempotencyKey: "question:tool-answer-direct-one",
  })]);
});
