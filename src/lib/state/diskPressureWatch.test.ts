import { expect, test } from "bun:test";
import { startDiskPressureWatch, stopDiskPressureWatch } from "./diskPressureWatch";

test("the pressure observer starts without a resources request and retires its held tick", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    startDiskPressureWatch({ observe: async () => { calls++; started(); await held; } });
    await Promise.race([ready, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("pressure observer did not start")), 5000); })]);
    stopDiskPressureWatch(); release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
  } finally { if (deadline) clearTimeout(deadline); stopDiskPressureWatch(); release(); }
});
