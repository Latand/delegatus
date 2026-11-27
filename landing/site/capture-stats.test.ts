import { describe, expect, test } from "bun:test";
import worker, { type Env } from "../worker";
import { createCaptureStatsBinding } from "./capture-stats";

describe("landing capture stats binding", () => {
  test("records Worker events in the capture format and rejects install pings", async () => {
    const points: { event: string; agent?: string; lang: string; country: string }[] = [];
    const env = {
      STATS_ORIGIN: "https://stats.example",
      STATS_RP_ID: "stats.example",
      STATS: createCaptureStatsBinding(points),
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    } as Env;
    const request = new Request("https://stats.example/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "copy_prompt", agent: "claude", lang: "en" }),
    });
    Object.defineProperty(request, "cf", { value: { country: "UA" } });

    expect((await worker.fetch(request, env)).status).toBe(204);
    expect(points).toEqual([{ event: "copy_prompt", agent: "claude", lang: "en", country: "UA" }]);
    await expect(env.STATS.get(env.STATS.idFromName("stats")).recordPing({} as never, "UA")).rejects.toThrow(
      "Install pings do not belong in landing captures",
    );
  });
});
