import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { AgentStateService } from "@/lib/agentState/service";
import { clearAgentObservations } from "@/lib/agentState/projectionCache";
import { fixtureRecords, fixtureRegistry, FIXTURE_NOW, FIXTURE_SESSION } from "@/lib/agentState/testFixture";
import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { determined } from "./determinable";
import * as control from "./structuredHostControl";
import * as delivery from "./structuredDeliveryController";
import { runStructuredHostRetirementSweep } from "./structuredHostRetirement";

const identities: ProcessIdentity[] = [];
const roots: string[] = [];
const originalTerminate = control.terminateStructuredHostTree;
afterEach(async () => {
  for (const identity of identities.splice(0).reverse()) await stopFixtureIdentity(identity);
  clearAgentObservations();
  setAgentRegistryForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const engine of ["codex", "claude"] as const) {
  for (const boundary of ["admission", "capture", "release", "scope"] as const) {
    for (const change of ["none", "held", "dead-owner", "publication", "entry missing", "process identity", "claimEpoch", "claimOwner", "writerClaimEpoch", "scope", "turn", "flags", "attention", "seat", "queue", "transcript"] as const) {
      test(`${engine}: central-state retirement after ${boundary}, ${change}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-lifecycle-"));
        roots.push(root);
        const script = path.join(root, "host.mjs");
        fs.writeFileSync(script, 'import { spawn } from "node:child_process"; spawn("sleep", ["60"], { detached: true, stdio: "ignore" }).unref(); setInterval(() => {}, 1000);');
        const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
        child.unref();
        const identity = captureProcessIdentity(child.pid!);
        identities.push(identity);
        let tree: number[] = [];
        for (let attempt = 0; attempt < 200 && tree.length < 2; attempt++) {
          await Bun.sleep(10);
          tree = descendantPids(identity.pid, procBackend.ppidMap());
        }
        expect(tree.length).toBeGreaterThanOrEqual(2);
        identities.push(...tree.filter(pid => pid !== identity.pid).map(pid => captureProcessIdentity(pid)));
        const owner = change === "held" ? captureProcessIdentity(process.pid) : change === "dead-owner"
          ? { pid: 2_147_483_647, startIdentity: "fixture-dead-owner", bootEpoch: identity.bootEpoch } : null;
        const file = fixtureRegistry(root, engine, identity, owner);
        const entry = file.entries[`${engine}:${FIXTURE_SESSION}`]!;
        entry.structuredHostOperationId = null;
        entry.structuredHost!.activeTurnRef = null;
        entry.status = "idle";
        entry.structuredHost!.scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: identity.bootEpoch };
        const records = fixtureRecords(engine);
        fs.writeFileSync(entry.artifactPath!, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
        const now = FIXTURE_NOW + 24 * 3_600_000;
        fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
        const filename = path.join(root, "registry.json");
        fs.writeFileSync(filename, JSON.stringify(file));
        const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
        setAgentRegistryForTests(registry);
        let released = 0;
        let changed = false;
        const holds = spyOn(delivery, "hasStructuredDeliveryHost").mockImplementation(() => change === "held");
        const service = new AgentStateService({ registry, now: () => now, owns: () => true,
          process: value => procBackend.pidAlive(value.pid) ? "alive" : "dead", memory: () => change === "held" && !released ? { activeTurnRef: null, pendingAttention: [], eventCursor: 0 } : null,
          release: "fixture", publish: async () => true });
        await service.request();
        const mutate = () => {
          changed = true;
          registry.agentStateWrite(state => {
            const current = state.entries[`${engine}:${FIXTURE_SESSION}`]!;
            if (change === "entry missing") delete state.entries[`${engine}:${FIXTURE_SESSION}`];
            if (change === "process identity") current.structuredHost!.process!.startIdentity = "replacement";
            if (change === "claimEpoch") current.claimEpoch++;
            if (change === "claimOwner") current.claimOwner = "replacement-owner";
            if (change === "writerClaimEpoch") current.structuredHost!.writerClaimEpoch++;
            if (change === "scope") current.structuredHost!.scope!.unit = "delegatus-agent-replacement.scope";
            if (change === "turn") current.structuredHost!.activeTurnRef = "reopened-turn";
            if (change === "flags") current.structuredHost!.activeFlags = ["live-work"];
            if (change === "attention") current.structuredHost!.pendingAttention = ["question"];
          });
          if (change === "transcript") fs.appendFileSync(entry.artifactPath!, JSON.stringify(records.open[0]) + "\n");
        };
        const admit = registry.deliveryWriteOrBusy.bind(registry);
        const admission = spyOn(registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, write) => {
          if (boundary === "admission" && correlation.label === "registry.idle-stop-capture") {
            await Promise.resolve();
            mutate();
          }
          return admit(correlation, write);
        });
        const outcomes: control.StructuredHostTerminationOutcome[] = [];
        const terminate = spyOn(control, "terminateStructuredHostTree").mockImplementation(async (ref, dependencies) => {
          const outcome = await originalTerminate(ref, { ...dependencies,
            // Isolate the two revision changes. The capture case uses the real durable capture.
            persistCapturedTree: async identities => {
              const accepted = await dependencies!.persistCapturedTree!(identities);
              if (boundary === "capture") mutate();
              return accepted;
            },
            terminateOwnedHost: async () => {
              released++;
              if (boundary === "release") mutate();
              return true;
            },
            stopScope: async (_scope, options) => {
              await options.authorizeAsync?.();
              if (boundary === "scope") mutate();
              options.authorize();
            },
            graceMs: 50, deadlineMs: 2000,
          });
          outcomes.push(outcome);
          return outcome;
        });
        try {
          const report = await runStructuredHostRetirementSweep({
            snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
            publicationState: () => changed && change === "publication" ? "unbound" : "ready", now: () => now,
            handoffRows: () => determined([]), durableEventTail: () => determined(changed && change === "queue" ? 1 : 0),
            realtimeBound: () => determined(false),
            orchestratorSeatConversations: () => determined(new Set<string>(changed && change === "seat" ? Object.keys(file.conversations) : [])),
            revokedSeatConversations: () => determined(new Set<string>()),
            readCursor: () => null, writeCursor: () => {}, record: () => {},
            treePss: () => ({ bytes: null, measuredProcesses: 0 }), graceMs: 50,
          });
          if (change !== "none" && change !== "held" && change !== "dead-owner") {
            expect(report.retired).toEqual([]);
            if (boundary === "scope" && change === "process identity") {
              expect(report.refused).toMatchObject([{ clause: "process-identity", changed: true }]);
              expect(outcomes[0]).toMatchObject({ ok: false, status: 409, error: "scope retirement target changed: process identity" });
              return;
            }
            expect(report.failed).toHaveLength(1);
            const condition = ["turn", "flags", "attention", "seat", "queue", "transcript"].includes(change) ? "verdict" : change;
            expect(report.failed[0]!.error).toContain(`scope retirement target changed: ${condition}`);
            expect(outcomes[0]).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(condition) });
            if (boundary !== "scope") {
              expect(tree.every(pid => procBackend.pidAlive(pid))).toBe(true);
              expect(report.failed[0]!.remaining).toContain(identity.pid);
            }
            return;
          }
          expect({ failed: report.failed, outcomes, alive: tree.filter(pid => procBackend.pidAlive(pid)), released }).toMatchObject({ failed: [], released: 1 });
          expect(report.retired).toHaveLength(1);
          for (const pid of tree) expect(procBackend.pidAlive(pid)).toBe(false);
        } finally { terminate.mockRestore(); admission.mockRestore(); holds.mockRestore(); service.stop(); registry.close(); }
      });
    }
  }
}
