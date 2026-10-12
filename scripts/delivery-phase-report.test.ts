import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { DeliveryProgressStore } from "../src/lib/runtime/deliveryProgress";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-phase-report-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const script = path.join(import.meta.dir, "delivery-phase-report.ts");
const noTimer = () => 0 as unknown as ReturnType<typeof setTimeout>;

test("the report reads completed phase spans in a send window without changing the database", () => {
  const state = path.join(root, "state");
  const filename = path.join(state, "delivery-progress.sqlite");
  let now = Date.parse("2026-10-11T00:00:00Z");
  const store = new DeliveryProgressStore(filename, () => now, noTimer);
  for (const [id, duration] of [["first", 100], ["second", 300], ["outside", 9_000]] as const) {
    store.note(id, "conversation", { waitReason: "queued", admittedAt: new Date(now).toISOString() });
    now += duration;
    store.note(id, "conversation", { waitReason: "dispatching", attempted: true });
    now += 50;
    store.settle(id, "delivered", null);
    now = Date.parse(id === "first" ? "2026-10-11T00:00:01Z" : "2026-10-10T00:00:00Z");
  }
  store.close();
  const before = fs.readFileSync(filename);
  const result = Bun.spawnSync([process.execPath, script, "--since", "2026-10-11T00:00:00Z", "--until", "2026-10-11T00:00:02Z"], {
    env: { ...process.env, LLV_STATE_DIR: state, LLV_STATE_OWNER: "" },
  });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("phase\treason\tspans\tp50_ms\tp95_ms");
  expect(output).toContain("queued\t-\t2\t200.0\t290.0");
  expect(output).toContain("dispatching\t-\t2\t50.0\t50.0");
  expect(fs.readFileSync(filename)).toEqual(before);
});

test("a report without a chosen state directory or inherited owner refuses instead of claiming ownership", () => {
  const env = { ...process.env, LLV_STATE_DIR: "", LLV_STATE_OWNER: "" };
  const result = Bun.spawnSync([process.execPath, script, "--since", "2026-10-11T00:00:00Z", "--until", "2026-10-12T00:00:00Z"], { env });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("LLV_STATE_DIR");
});

test.each(["delegatus", "agent-log-viewer"])("an activated inherited owner reports from %s without migrating or linking state", (app) => {
  const home = path.join(root, `owner-${app}`);
  const config = path.join(home, "config");
  const state = path.join(config, app, "state");
  const filename = path.join(state, "delivery-progress.sqlite");
  const store = new DeliveryProgressStore(filename, () => Date.parse("2026-10-11T00:00:00Z"), noTimer);
  store.note("owner-send", "conversation", { waitReason: "queued" });
  store.close();
  const before = fs.readFileSync(filename);
  const stateFiles = fs.readdirSync(state).sort();
  const configFiles = fs.readdirSync(config).sort();
  const activation = path.join(import.meta.dir, "../src/lib/state/stateMutationBarrier.ts");
  const result = Bun.spawnSync([process.execPath, "-e", `
    const [activation, script] = process.argv.slice(-2);
    const { openStateMutationActivation } = await import(activation);
    const { deliveryPhaseReport } = await import(script);
    openStateMutationActivation();
    console.log(deliveryPhaseReport(["--since", "2026-10-11T00:00:00Z", "--until", "2026-10-11T00:01:00Z"]));
  `, activation, script], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, LLV_STATE_DIR: "", LLV_STATE_OWNER: "viewer", NODE_ENV: "production" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("records=1");
  expect(fs.readFileSync(filename)).toEqual(before);
  // SQLite can open WAL coordination sidecars even for a read-only handle.
  expect(fs.readdirSync(state).filter(name => !/\.sqlite-(wal|shm)$/.test(name)).sort()).toEqual(stateFiles);
  expect(fs.readdirSync(config).sort()).toEqual(configFiles);
});

test("the report includes observation times added to an older record and omits unfinished spans", () => {
  const state = path.join(root, "observations");
  const store = new DeliveryProgressStore(path.join(state, "delivery-progress.sqlite"), () => Date.parse("2026-10-10T00:00:00Z"), noTimer);
  store.note("observed-send", "conversation", { waitReason: "dispatching" });
  store.timing("observed-send", { ingressAt: "2026-10-11T00:00:00Z", engineEchoAt: "2026-10-11T00:00:00.100Z" });
  store.close();
  const result = Bun.spawnSync([process.execPath, script, "--since", "2026-10-11T00:00:00Z", "--until", "2026-10-11T00:00:01Z"], {
    env: { ...process.env, LLV_STATE_DIR: state, LLV_STATE_OWNER: "" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("records=1");
  expect(result.stdout.toString()).toContain("open_spans=1");
  expect(result.stdout.toString()).toContain("total:ingress-to-echo\t-\t1\t100.0\t100.0");
  expect(result.stdout.toString()).not.toContain("total:echo-to-confirmation");
  expect(result.stdout.toString()).not.toContain("dispatching\t");
});
