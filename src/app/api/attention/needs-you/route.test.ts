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

test("POST validates durable seat ownership, revocation, supersession and migration before projection", async () => {
  // Module substitutions stay in a child; the real caller adapter and shared
  // authority resolver run over registry/store boundary fixtures.
  const child = Bun.spawn([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { NextRequest } from "next/server";
    import { createHash } from "node:crypto";
    import * as seatStore from "@/lib/orchestrator/seats";
    import * as registryModule from "@/lib/agent/registry";
    import * as needsYou from "@/lib/attention/needsYouRead";
    import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
    const id = "conversation_seat";
    const oldId = "conversation_before_migration";
    const capability = "s".repeat(43);
    const digest = createHash("sha256").update(capability).digest("hex");
    let seats = [], revocations = [], conversation, reads = 0;
    const registry = {
      conversation: ref => ref === id || ref === oldId ? conversation : null,
      conversationIdForSpawnCapabilityDigest: value => value === digest ? id : null,
      readOnlySnapshot: () => ({ conversations: { [id]: conversation }, conversationAliases: {}, entries: {} }),
    };
    mock.module("@/lib/agent/registry", () => ({ ...registryModule, agentRegistry: () => registry }));
    mock.module("@/lib/orchestrator/seats", () => ({ ...seatStore,
      activeOrchestratorSeats: () => seats, orchestratorRevocations: () => revocations }));
    mock.module("@/lib/attention/needsYouRead", () => ({ ...needsYou,
      readNeedsYou: async project => { reads++; return { project, rows: [] }; } }));
    const { POST } = await import("./src/app/api/attention/needs-you/route.ts");
    const results = [];
    for (const name of ["valid", "migrated", "cross-project", "revoked", "superseded", "conflicting", "no-generation", "other-project"]) {
      reads = 0;
      conversation = { id, agentRole: "orchestrator", continuityPaths: [], generations: [{ launchProfile: {} }], supersededBy: null,
        projectOwnership: { project: name === "cross-project" ? "project-b" : "project-a" } };
      seats = [{ conversationId: name === "migrated" ? oldId : id, project: "project-a", path: null, state: "active", seatEpoch: 2 }];
      revocations = name === "revoked" ? [{ conversationId: oldId, seatEpoch: 2 }] : [];
      if (name === "superseded") conversation.supersededBy = { conversationId: "conversation_successor" };
      if (name === "conflicting") seats.push({ ...seats[0], conversationId: oldId, project: "project-b" });
      if (name === "no-generation") conversation.generations = [];
      const response = await POST(new NextRequest("http://localhost/api/attention/needs-you", {
        method: "POST", headers: { Host: "localhost", "Content-Type": "application/json", [VIEWER_SPAWN_CAPABILITY_HEADER]: capability },
        body: JSON.stringify({ project: name === "other-project" ? "project-b" : "project-a" }),
      }));
      results.push({ name, status: response.status, reads });
    }
    console.log(JSON.stringify(results));
  `], { cwd: process.cwd(), env: { ...process.env, LLV_ROOT_CONVERSATION_ID: "conversation_root" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual([
    { name: "valid", status: 200, reads: 1 },
    { name: "migrated", status: 200, reads: 1 },
    ...["cross-project", "revoked", "superseded", "conflicting", "no-generation", "other-project"].map(name => ({ name, status: 403, reads: 0 })),
  ]);
});
