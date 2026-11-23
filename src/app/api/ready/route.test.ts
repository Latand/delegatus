import { expect, test } from "bun:test";
import { markViewerHttpReady } from "@/lib/viewerReadiness";
import { GET } from "./route";

test("only a matching full revision can pass after essential startup", () => {
  const revision = "a".repeat(40);
  const request = (query: string) => new Request(`http://127.0.0.1/api/ready?${query}`);
  const matching = request(`revision=${revision}`);
  const previous = process.env.LLV_DIAGNOSTIC_REVISION;
  const viewer = process as typeof process & { __llvReadyRevision?: string };
  const previousReady = viewer.__llvReadyRevision;
  delete viewer.__llvReadyRevision;
  process.env.LLV_DIAGNOSTIC_REVISION = revision;
  try {
    expect(GET(matching).status).toBe(503);
    markViewerHttpReady();
    const ready = GET(matching);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-delegatus-viewer-revision")).toBe(revision);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(ready.body).toBeNull();
    const different = GET(request(`revision=${"b".repeat(40)}`));
    expect(different.status).toBe(409);
    expect(different.headers.get("x-delegatus-viewer-revision")).toBeNull();
    expect(GET(request("")).status).toBe(400);
    expect(GET(request("revision=aaaaaaa")).status).toBe(400);
    expect(GET(request(`revision=${revision}&revision=${revision}`)).status).toBe(400);
  } finally {
    if (previous === undefined) delete process.env.LLV_DIAGNOSTIC_REVISION;
    else process.env.LLV_DIAGNOSTIC_REVISION = previous;
    if (previousReady === undefined) delete viewer.__llvReadyRevision;
    else viewer.__llvReadyRevision = previousReady;
  }
});
