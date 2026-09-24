import { expect, test } from "bun:test";
import { viewerMcpBindings } from "./bindings";
import { TOOL_INPUT_SCHEMAS } from "./server";
import type { ResourcesRead } from "@/lib/resources";

test("retirement status proxies only server-attributed identity and bounded arguments", async () => {
  const posts: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const fixture = { kind: "host-retirement", project: "project-a", items: [], cursor: "next", hasMore: true };
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname, body) => { posts.push({ pathname, body }); return fixture; },
  }, {
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_seat", role: "orchestrator" }),
    authorizedSeats: () => [{ conversationId: "conversation_seat", project: "project-a", path: null }],
    registrySnapshot: () => { throw new Error("a seat needs no receipt lookup"); },
  } as never);
  const args = { clientRequestId: "retirement-page", kind: "host-retirement", project: "project-a",
    callerLaunchId: "seat-assignment", authentication: { conversationId: "forged" }, capability: "forged", limit: 900, cursor: "prior" };
  expect(await bindings.deployment_status(args)).toEqual(fixture);
  expect(posts).toEqual([{ pathname: "/api/runtime/deployments?kind=host-retirement", body: {
    project: "project-a", limit: 100, cursor: "prior", authentication: { conversationId: "conversation_seat", seatProject: "project-a" },
  } }]);
  await expect(bindings.deployment_status({ ...args, project: undefined })).rejects.toThrow("project");
  await expect(bindings.deployment_status({ ...args, operationId: "op-known" })).rejects.toThrow("combined");
  expect(posts).toHaveLength(1);
});

test("known-operation and deployment reads retain their original contract", async () => {
  const calls: string[] = [];
  const bindings = viewerMcpBindings(undefined, { get: async (pathname) => {
    calls.push(pathname);
    return pathname.endsWith("op-known") ? { operationId: "op-known", receipt: { status: "pending" } } : { count: 0, deployments: [] };
  }, post: async () => { throw new Error("unexpected control write"); } }, {
    callerProject: () => { throw new Error("old lookup must not acquire new authorization requirements"); },
  } as never);
  expect(await bindings.deployment_status({ clientRequestId: "old-operation", operationId: "op-known" })).toEqual({
    operationId: "op-known", operation: { operationId: "op-known", receipt: { status: "pending" }, replayed: false } });
  expect(await bindings.deployment_status({ clientRequestId: "old-list", limit: 1 })).toEqual({ count: 0, deployments: [] });
  expect(calls).toEqual(["/api/runtime/operations/op-known", "/api/runtime/deployments?limit=1"]);
});

test("the existing tool schema documents and admits the bounded retirement mode", () => {
  expect(TOOL_INPUT_SCHEMAS.deployment_status!.parse({ clientRequestId: "schema", kind: "host-retirement", project: "project-a", limit: "999", cursor: "opaque" }))
    .toMatchObject({ kind: "host-retirement", project: "project-a", limit: "999", cursor: "opaque" });
  expect(TOOL_INPUT_SCHEMAS.deployment_status!.safeParse({ clientRequestId: "schema", kind: "unknown" }).success).toBe(false);
});

test("resource freshness reports the existing collector failure without another collection", async () => {
  let reads = 0;
  const capturedAt = "2026-07-01T00:00:00.000Z";
  const diagnosticRead: ResourcesRead = { payload: { system: { ramTotal: 10, ramAvailable: 5, swapTotal: 2, swapUsed: 1, capturedAt }, sessions: [] },
    diagnostic: { status: "failed", cache: { status: "durable" }, degradedReason: "collector-crash", fresh: true,
      durationMs: 5, phases: { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 },
      generation: 1, startedAt: capturedAt, completedAt: capturedAt, collectorId: "fixture" } };
  const bindings = viewerMcpBindings(undefined, undefined, {
    readResources: () => { throw new Error("second collection"); },
    readResourcesWithDiagnostic: async (fresh: boolean) => { expect(fresh).toBe(true); reads++; return diagnosticRead; },
  } as never);
  const result = await bindings.resources({ clientRequestId: "freshness", fresh: true });
  expect(result).toMatchObject({ freshness: { capturedAt, capturedAtScope: "system", refreshRequested: true,
    refreshSucceeded: false, cache: "durable", reason: "collector-crash" } });
  expect((result.freshness as { ageMs: number }).ageMs).toBeGreaterThan(0);
  expect(reads).toBe(1);
});
