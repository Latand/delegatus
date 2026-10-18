import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

const post = (body: unknown, headers: Record<string, string> = {}) => POST(new NextRequest("http://127.0.0.1:3000/api/view/typing-latency", {
  method: "POST",
  headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const report = { schemaVersion: 1, samples: [{ at: 1_792_000_000_000, ms: 96, delayMs: 30, animations: 2 }] };

test("a report is accepted and logged on the Viewer's stderr line format", async () => {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { lines.push(line); };
  try {
    const response = await post(report);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, logged: true });
  } finally { console.warn = warn; }
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("[typing-latency]");
  expect(lines[0]).toContain('"slowestMs":96');
});

test("a report with anything beyond numbers is refused and nothing is logged", async () => {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { lines.push(line); };
  try {
    const response = await post({ ...report, draft: "typed words" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("typed words");
  } finally { console.warn = warn; }
  expect(lines).toEqual([]);
});

test("an oversized body is refused before it is parsed", async () => {
  const response = await post(JSON.stringify({ schemaVersion: 1, samples: [], pad: "x".repeat(4096) }));
  expect(response.status).toBe(413);
});

test("a cross-origin caller is refused", async () => {
  const response = await post(report, { origin: "http://evil.example" });
  expect(response.status).toBeGreaterThanOrEqual(400);
});
