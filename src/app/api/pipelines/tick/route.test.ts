import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

test("pipeline tick joins one coalesced reconciliation inside the live Viewer process", async () => {
  let calls = 0;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/pipelines/tick", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
    },
  }), async () => {
    calls += 1;
  });

  expect(response.status).toBe(200);
  expect(calls).toBe(1);
});


test("a refused tick responds without an uncaught route rejection", async () => {
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:19000/api/pipelines/tick", {
    method: "POST", headers: { origin: "http://127.0.0.1:19000", host: "127.0.0.1:19000" },
  }), async () => { throw new Error("private failure detail"); });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private failure detail");
});
