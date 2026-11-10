import { expect, setSystemTime, test } from "bun:test";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { acceptNativeRelayHandoff, inheritNativeRelayHandoff, nativeRelayConversation, NATIVE_RELAY_HEADER, withNativeRelayHandoff } from "./nativeRelayHandoff";

const body = { project: "destination", conversationId: "conversation_destination", text: "A queued report", clientMessageId: "handoff-fixture" };
const request = (headers: Record<string, string>) => new Request("http://127.0.0.1/api/orchestrator/message", { method: "POST", headers });

test("a consumed handoff retains its live resolver only on the original request and its internal copy", async () => {
  let live = true;
  const caller = () => { if (!live) throw new Error("replaced"); return "conversation_sender"; };
  let seen!: Request;
  let copied!: Request;
  await withNativeRelayHandoff(body, caller, async headers => {
    seen = request({ ...internalServiceHeaders("mcp"), ...headers });
    expect(acceptNativeRelayHandoff(seen, body)).toBe(true);
    expect(nativeRelayConversation(seen)).toBe("conversation_sender");
    expect(acceptNativeRelayHandoff(request({ ...internalServiceHeaders("mcp"), ...headers }), body)).toBe(false);
    copied = request(headers);
    inheritNativeRelayHandoff(seen, copied);
    expect(nativeRelayConversation(copied)).toBe("conversation_sender");
    live = false;
    expect(() => nativeRelayConversation(seen)).toThrow("replaced");
    expect(() => nativeRelayConversation(copied)).toThrow("replaced");
  });
  expect(() => nativeRelayConversation(seen)).toThrow("ended");
  expect(() => nativeRelayConversation(copied)).toThrow("ended");
});

test("expiry refuses both unconsumed grants and already bound requests", async () => {
  const start = new Date("2026-10-01T00:00:00.000Z");
  setSystemTime(start);
  try {
    await withNativeRelayHandoff(body, () => "conversation_sender", async headers => {
      const req = request({ ...internalServiceHeaders("mcp"), ...headers });
      expect(acceptNativeRelayHandoff(req, body)).toBe(true);
      setSystemTime(new Date(start.getTime() + 5 * 60_000));
      expect(() => nativeRelayConversation(req)).toThrow("ended");
    });
    setSystemTime(start);
    await withNativeRelayHandoff(body, () => "conversation_sender", async headers => {
      setSystemTime(new Date(start.getTime() + 5 * 60_000));
      expect(acceptNativeRelayHandoff(request({ ...internalServiceHeaders("mcp"), ...headers }), body)).toBe(false);
    });
  } finally { setSystemTime(); }
});

for (const threat of ["no-service", "other-service", "foreign-capability", "changed-body", "changed-caller"] as const) {
  test(`handoff refuses ${threat} using the original envelope`, async () => {
    let live = true;
    await withNativeRelayHandoff(body, () => { if (!live) throw new Error("replaced"); return "conversation_sender"; }, async headers => {
      const service = threat === "no-service" ? {} : internalServiceHeaders(threat === "other-service" ? "monitor" : "mcp");
      if (threat === "changed-caller") live = false;
      const req = request({ ...service, ...headers, ...(threat === "foreign-capability" ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "foreign" } : {}) });
      expect(acceptNativeRelayHandoff(req, threat === "changed-body" ? { ...body, text: "Different words" } : body)).toBe(false);
      expect(() => nativeRelayConversation(req)).toThrow();
    });
  });
}

for (const throws of [false, true]) {
  test(`unconsumed handoff is removed when dispatch ends (exception: ${throws})`, async () => {
    let headers!: Record<string, string>;
    const dispatched = withNativeRelayHandoff(body, () => "conversation_sender", async supplied => {
      headers = supplied;
      if (throws) throw new Error("connection lost");
    });
    if (throws) await expect(dispatched).rejects.toThrow("connection lost");
    else await dispatched;
    const req = request({ ...internalServiceHeaders("mcp"), ...headers });
    expect(acceptNativeRelayHandoff(req, body)).toBe(false);
  });
}

test("caller strings and a service marker alone cannot create a native identity", () => {
  for (const headers of [{}, internalServiceHeaders("mcp"), { ...internalServiceHeaders("mcp"), [NATIVE_RELAY_HEADER]: "conversation_sender" }]) {
    const req = request(headers);
    if (req.headers.has(NATIVE_RELAY_HEADER)) {
      expect(acceptNativeRelayHandoff(req, body)).toBe(false);
      expect(() => nativeRelayConversation(req)).toThrow();
    } else {
      expect(acceptNativeRelayHandoff(req, body)).toBe(true);
      expect(nativeRelayConversation(req)).toBeNull();
    }
  }
});

test("another serving process cannot inherit an in-memory handoff across restart", async () => {
  await withNativeRelayHandoff(body, () => "conversation_sender", async headers => {
    for (let generation = 0; generation < 2; generation++) {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { acceptNativeRelayHandoff } from "./src/lib/orchestrator/nativeRelayHandoff";
        const input = JSON.parse(await Bun.stdin.text());
        const request = new Request("http://127.0.0.1/api/orchestrator/message", { method: "POST", headers: input.headers });
        process.stdout.write(JSON.stringify(acceptNativeRelayHandoff(request, input.body)));
      `], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ body, headers: { ...internalServiceHeaders("mcp"), ...headers } }));
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(error).toBe("");
      expect(output).toBe("false");
    }
    expect(acceptNativeRelayHandoff(request({ ...internalServiceHeaders("mcp"), ...headers }), body)).toBe(true);
  });
});
