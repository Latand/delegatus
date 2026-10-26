import { expect, test } from "bun:test";
import http from "node:http";
import { NextRequest } from "next/server";

import { GET, HEAD } from "../../app/api/onboarding/diagnostics/route";
import { CAPABILITY_IDS, type CapabilityReport } from "../doctor/contracts";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/onboarding/diagnostics?port=1&home=untrusted&fresh=1", {
    headers: { host: "localhost", ...headers },
  });
}

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
  for (const method of [GET, HEAD]) {
    const response = await method(request(headers));
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
