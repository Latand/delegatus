import { expect, test } from "bun:test";
import { viewerMcpBindings } from "./bindings";
import { TOOL_INPUT_SCHEMAS } from "./server";
import { defaultSeatTickSettings, type SeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { readReleaseProject } from "@/lib/release/store";
import { normalizeRegistry } from "@/lib/agent/registry";
test("release schema and binding persist requests, holds and the operator's stop-asking switch", async () => {
  const project = "release-mcp";
  const settings = new Map<string, SeatTickSettings>();
  // Only tick operations are available in this domain fixture.
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => normalizeRegistry({}),
    callerAttribution: () => ({ kind: "manager", conversationId: "seat", role: "orchestrator" }),
    authorizedSeats: () => [{ conversationId: "seat", project, path: null }], callerProject: () => project,
    readTickSettings: (name: string) => settings.get(name) ?? defaultSeatTickSettings(name),
    writeTickSettings: (name: string, row: SeatTickSettings) => settings.set(name, row),
  } as never);
  const args = { clientRequestId: "release-controls", release: { enabled: true, askBeforePublish: false,
    requestNow: true, hold: "installation incident", why: "Випустити й більше не питати" } };
  expect(TOOL_INPUT_SCHEMAS.seat_tick_settings.safeParse(args).success).toBe(true);
  const result = await bindings.seat_tick_settings(args);
  expect(result.changedFields).toEqual(["release"]);
  expect(settings.get(project)?.release?.askBeforePublish).toBe(false);
  expect(readReleaseProject(project).request?.why).toBe(args.release.why);
  expect(readReleaseProject(project).hold?.reason).toBe("installation incident");
  await bindings.seat_tick_settings({ clientRequestId: "release-clear-hold", release: { hold: null, askBeforePublish: true, why: "operator wants confirmation" } });
  expect(readReleaseProject(project).hold).toBeNull();
  expect(settings.get(project)?.release?.askBeforePublish).toBe(true);
});
