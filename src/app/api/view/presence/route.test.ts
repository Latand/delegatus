import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

test("presence replies with the revision served by this web process", async () => {
  const payload = { schemaVersion: 1, viewSessionId: "view-1", deviceId: "device-1", device: { kind: "desktop", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 1,
    project: null, mode: "scheme", viewport: { width: 800, height: 600, dpr: 1 }, camera: null, focusedPath: null, selectedPaths: [], visiblePaths: [], board: { renderedRevision: 1, durableRevision: 1, sync: "current" } };
  const request = new NextRequest("http://127.0.0.1:3000/api/view/presence", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(payload) });
  const response = await POST(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, serving: expect.any(String) });
});
