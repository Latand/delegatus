import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

afterEach(() => setCallerConversationResolverForTests(null));
const post = (body: unknown, headers: Record<string, string> = {}) => POST(new NextRequest("http://localhost/api/role-memory/profile", { method: "POST", headers: { Cookie: `llv_operator=${soloBrowserSession()}`, Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));

test("reads do not create a profile and reject missing or unsupported locales", async () => {
  expect((await GET(new NextRequest("http://localhost/api/role-memory/profile?project=sample-route"))).status).toBe(400);
  expect((await GET(new NextRequest("http://localhost/api/role-memory/profile?project=sample-route&locale=ru"))).status).toBe(400);
  const response = await GET(new NextRequest("http://localhost/api/role-memory/profile?project=sample-route&locale=uk"));
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = await response.json(); expect(result.overall).toBeNull(); expect(result.run).toBeNull();
});
test("same-origin operator can stream an empty profile without any account", async () => {
  const response = await post({ project: "sample-route", locale: "uk" });
  expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
  const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  expect(frames.at(-1).run.state).toBe("done"); expect(frames.at(-1).ruleCount).toBe(0);
});
test("cross-origin requests and registered agent callers cannot generate", async () => {
  expect((await post({ project: "sample-route", locale: "en" }, { Origin: "https://outside.example" })).status).toBe(403);
  setCallerConversationResolverForTests(() => "sample-conversation");
  const capability = "s".repeat(43);
  expect((await post({ project: "sample-route", locale: "en" }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability })).status).toBe(403);
  expect((await post({ project: "sample-route", locale: "other" })).status).toBe(400);
});
