import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { needsYouHandler } from "./handler";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import type { NeedsYouAnswer } from "@/lib/attention/needsYouRead";
const seats = [{ conversationId: "seat-a", project: "project-a" }, { conversationId: "seat-b", project: "project-b" }];
const request = (project = "project-a", origin?: string) => new NextRequest("http://localhost/api/attention/needs-you", { method: "POST", headers: { Host: "localhost", "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ project }) });
test("the read admits the project's seat and maintenance run, and refuses other callers before reading", async () => {
  for (const [authority, maintainer, allowed] of [
    [{ kind: "root", conversationId: "root" }, null, true],
    [{ kind: "worker", conversationId: "seat-a", role: "orchestrator" }, null, true],
    [{ kind: "worker", conversationId: "maintainer", role: "maintainer" }, { conversationId: "maintainer", project: "project-a" }, true],
    [{ kind: "worker", conversationId: "seat-b", role: "orchestrator" }, null, false],
    [{ kind: "worker", conversationId: "worker", role: "builder" }, null, false],
    [{ kind: "unidentified" }, null, false],
    [{ kind: "worker", conversationId: "maintainer", role: "maintainer" }, { conversationId: "maintainer", project: "project-b" }, false],
  ] as const) {
    let reads = 0;
    const handler = needsYouHandler({ caller: () => ({ authority: authority as AttentionCallerAuthority, seats, maintainer }), read: async project => { reads++; return { project, rows: [] } as unknown as NeedsYouAnswer; } });
    const response = await handler(request());
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(reads).toBe(allowed ? 1 : 0);
  }
});
test("a cross-origin read reaches no authority or projection", async () => {
  const handler = needsYouHandler({ caller: () => { throw new Error("must not identify"); }, read: async () => { throw new Error("must not read"); } });
  expect((await handler(request("project-a", "http://foreign.example"))).status).toBe(403);
});
