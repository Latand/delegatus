import { expect, test } from "bun:test";
import { createReadAttribution } from "./readAttribution";

test("nested readers have exclusive time and bytes; observer traffic is removed", () => {
  let at = 0, bytes = 0;
  const read = () => { const result = { bytes, observerBytes: 10 }; bytes += 10; return result; };
  const recorder = createReadAttribution(() => at, read);
  recorder.run("files.get", () => {
    at += 2; bytes += 50;
    recorder.sync("state.pipelines", () => { at += 600; bytes += 4096; }, 1);
    at += 3; bytes += 80;
  });
  const report = recorder.snapshot(605);
  expect(report.namedSyncMs).toBe(605);
  expect(report.top.find(row => row.reader === "state.pipelines")).toMatchObject({ syncMs: 600, readBytes: 4096, operation: "files.get", connection: 1 });
  expect(report.top.find(row => row.reader === "operation")!.syncMs).toBe(5);
  expect(report.attributedFraction).toBe(1);
});

test("interleaved awaits carry names without assigning peer time or bytes", async () => {
  let at = 0, bytes = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes, observerBytes: 0 }));
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const pending = recorder.run("files.get", async () => {
    await latch;
    recorder.sync("state", () => { at += 300; bytes += 8192; }, 1);
  });
  recorder.run("pipelines.get", () => recorder.sync("registry", () => { at += 700; bytes += 4096; }, 2));
  release(); await pending;
  const report = recorder.snapshot(1000);
  expect(report.namedSyncMs).toBe(1000);
  expect(report.operations).toContainEqual({ name: "files.get", readBytes: 8192, decodedJsonBytes: 0 });
  expect(report.operations).toContainEqual({ name: "pipelines.get", readBytes: 4096, decodedJsonBytes: 0 });
});

test("unavailable and regressing counters stay explicit; failures preserve decoded bytes", () => {
  let at = 0;
  const recorder = createReadAttribution(() => at, () => null);
  expect(() => recorder.sync("registry.json", () => { at += 600; throw Error("private"); }, 3, 23, false)).toThrow();
  recorder.sync("registry", () => { at += 1; }, 3);
  const report = recorder.snapshot(601);
  expect(report.top.find(row => row.reader === "registry.json")).toMatchObject({ failed: 1, decodedJsonBytes: 23 });
  expect(report.top.find(row => row.reader === "registry")).toMatchObject({ unavailableCalls: 1, readBytes: 0 });
  expect(JSON.stringify(report)).not.toContain("private");
  let bytes = 100;
  const resets = createReadAttribution(() => at, () => ({ bytes: bytes--, observerBytes: 0 }));
  resets.sync("state", () => {});
  expect(resets.snapshot(1).top[0]).toMatchObject({ unavailableCalls: 1, readBytes: 0 });
});

test("sampling and retention bounds report lost evidence and reset for the next window", () => {
  let at = 0, reads = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes: ++reads, observerBytes: 0 }));
  for (let i = 0; i < 1000; i++) recorder.sync(`state-${i}`, () => {}, i);
  const report = recorder.snapshot(1);
  expect(reads).toBe(64);
  expect(report.dropped).toBe(872);
  expect(report.omitted).toBe(112);
  expect(report.unsampledCalls).toBe(96);
  recorder.clear(); at = 10;
  recorder.sync("state", () => {});
  expect(reads).toBe(66);
  expect(recorder.snapshot(1).dropped).toBe(0);
});

test("unsampled nested traffic is never reassigned to its sampled parent", () => {
  let bytes = 0;
  const recorder = createReadAttribution(() => 0, () => ({ bytes, observerBytes: 0 }));
  for (let i = 0; i < 31; i++) recorder.sync("state", () => {});
  recorder.run("files.get", () => recorder.sync("registry", () => { bytes += 4096; }));
  expect(recorder.snapshot(1).readBytes).toBe(0);
});

test("synchronous site siblings name child SQL and preserve exclusive bytes through JSON frames", () => {
  let at = 0, bytes = 0;
  const recorder = createReadAttribution(() => at, () => ({ bytes, observerBytes: 0 }));
  recorder.sync("registry.snapshot", () => {
    at += 100;
    recorder.sync("registry.json", () => {
      at += 100;
      recorder.sync("registry.get", () => { at += 600; bytes += 4096; }, 1);
    }, 1, 16, false);
  });
  const report = recorder.snapshot(800);
  expect(report.namedSyncMs).toBe(800);
  expect(report.readBytes).toBe(4096);
  expect(report.operations).toEqual([{ name: "registry.snapshot", readBytes: 4096, decodedJsonBytes: 16 }]);
});
