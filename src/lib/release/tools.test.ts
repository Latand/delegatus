import { expect, test } from "bun:test";
import { captureTools } from "./production";
test("capture readiness probes the host Bun bridge used by the capture agent", async () => {
  let calls = 0;
  const tools = await captureTools("/synthetic/repo", async (file, args, cwd) => {
    calls++; expect(file).toBe("bun"); expect(args[0]).toBe("-e"); expect(cwd).toBe("/synthetic/repo");
    return JSON.stringify({ missing: ["tesseract"], chrome: "chrome-fixture" });
  });
  expect(calls).toBe(1); expect(tools.missing).toEqual(["tesseract"]);
});
