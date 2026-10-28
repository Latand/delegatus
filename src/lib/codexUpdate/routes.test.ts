import { expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/codex-update/check/route";
import * as controller from "./controller";
import { internalServiceHeaders, INTERNAL_SERVICE_HEADER } from "@/lib/agent/callerClaims";

const url = "http://127.0.0.1:3000/api/codex-update/check";
const post = (headers: Record<string, string>) => POST(new NextRequest(url, { method: "POST", headers: { host: "127.0.0.1:3000", ...headers } }));

test("only the authenticated host controller may request a check", async () => {
  const request = spyOn(controller, "requestCodexUpdate").mockReturnValue(true);
  try {
    for (const headers of [{}, { [INTERNAL_SERVICE_HEADER]: "controller.invalid" },
      internalServiceHeaders("mcp"), internalServiceHeaders("probe"), internalServiceHeaders("monitor"),
      { ...internalServiceHeaders("controller"), origin: "http://untrusted.invalid" }]) {
      expect(post(headers).status).toBe(403);
    }
    expect(request).not.toHaveBeenCalled();
    const response = post(internalServiceHeaders("controller"));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { request.mockRestore(); }
});

test("a demoted controller refuses without claiming the check was accepted", async () => {
  const response = post(internalServiceHeaders("controller"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ accepted: false });
});
