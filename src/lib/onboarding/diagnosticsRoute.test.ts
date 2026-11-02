import { expect, spyOn, test } from "bun:test";
import http from "node:http";
import { NextRequest } from "next/server";

import { GET, HEAD } from "../../app/api/onboarding/diagnostics/route";
import { CAPABILITY_IDS, type CapabilityReport } from "../doctor/contracts";
import { viewerLoopMonitor, LOOP_MEMORY_RETENTION } from "../viewerLoopMonitor";
import { performanceProcess } from "../performanceSpans";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/onboarding/diagnostics?port=1&home=untrusted&fresh=1", {
    headers: { host: "localhost", ...headers },
  });
}

test("existing diagnostics reads loop memory without running installation probes", async () => {
  const port = process.env.PORT;
  try {
    process.env.PORT = "invalid"; // doctor would refuse this input
    const tickAt = performance.now() + LOOP_MEMORY_RETENTION.intervalMs;
    const now = spyOn(performance, "now").mockReturnValue(tickAt);
    const restoreLog = viewerLoopMonitor.setLogSink(() => {});
    try {
      viewerLoopMonitor.tick();
      const response = await GET(new NextRequest("http://localhost/api/onboarding/diagnostics?loop=1", { headers: { host: "localhost" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const report = await response.json();
      expect(report.retention).toEqual(LOOP_MEMORY_RETENTION);
      expect(report.samples.at(-1)).toMatchObject({ pid: performanceProcess.pid, start: performanceProcess.start });
    } finally { now.mockRestore(); restoreLog(); }
  } finally { if (port === undefined) delete process.env.PORT; else process.env.PORT = port; }
});

test("onboarding shares the versioned registry; HEAD identifies the listener without probes", async () => {
  let heads = 0;
  const server = http.createServer((req, res) => {
    expect(req.method).toBe("HEAD");
    heads++;
    res.writeHead(204, { "x-delegatus-diagnostics": "1" }); res.end();
  });
  const previous = process.env.PORT;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    process.env.PORT = String((server.address() as { port: number }).port);
    const head = HEAD(request());
    expect(head.status).toBe(204);
    expect(head.headers.get("x-delegatus-diagnostics")).toBe("1");
    expect(heads).toBe(0);
    for (let i = 0; i < 2; i++) {
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const report = await response.json() as CapabilityReport;
      expect(report.schemaVersion).toBe(1);
      expect(report.capabilities.map(row => row.id)).toEqual([...CAPABILITY_IDS]);
      expect(report.capabilities.find(row => row.id === "viewer.server")?.state).toBe("available");
      expect(JSON.stringify(report)).not.toContain("untrusted");
    }
    expect(heads).toBe(2); // Explicit reads are fresh; there is no polling or background refresh.
  } finally {
    if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const [label, headers] of [
  ["foreign Host", { host: "foreign.invalid" }],
  ["foreign Origin", { origin: "https://foreign.invalid" }],
  ["opaque Origin", { origin: "null" }],
  ["cross-site fetch", { "sec-fetch-site": "cross-site" }],
] as const) test(`${label} cannot read either diagnostics method`, async () => {
  for (const method of [GET, HEAD]) for (const loop of [false, true]) {
    const req = request(headers);
    if (loop) req.nextUrl.searchParams.set("loop", "1");
    const response = await method(req);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-delegatus-diagnostics")).toBeNull();
    expect(await response.json()).toEqual({ error: "forbidden: cross-origin request" });
  }
});

test("invalid installation port returns a fixed error without echoing configuration", async () => {
  const previous = process.env.PORT;
  try {
    process.env.PORT = "synthetic private configuration";
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Diagnostics could not complete." });
  } finally { if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous; }
});
