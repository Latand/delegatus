import WebSocket from "ws";
import { prepareCloudEnvironment } from "./codexCloudEnvironments";
import type { HostedCloudDependencies } from "@/lib/pipelines/cloudHostedClient";

const [url, crashAt, now] = process.argv.slice(2);
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("restart fixture requires owned loopback backend");
const dependencies: HostedCloudDependencies = {
  authenticate: async () => ({ token: "fixture-auth", account: "account-a" }),
  socket: () => new WebSocket(url.replace("http:", "ws:") + "/socket", { headers: { "ChatGPT-Account-Id": "account-a" } }),
  fetch: async (target, init) => {
    const original = new URL(target);
    if (!["https://codex-cloud-backend.chatgpt.com", "https://chatgpt.com"].includes(original.origin)) throw new Error("restart fixture egress refused");
    const response = await fetch(new URL(original.pathname + original.search, url), init);
    // The provider committed the effect, but this process never checkpointed its reply.
    if (init.method === "POST" && original.pathname === crashAt) process.exit(0);
    return response;
  },
  uuid: () => "command-fixture",
};
const result = await prepareCloudEnvironment({ project: "repo-fixture", account: { engine: "codex", accountId: "account-a", kind: "managed",
  home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: {} }, repository: "sample/project", ref: "main", signal: AbortSignal.timeout(10_000), assertCurrent: () => {}, now: () => Number(now) }, dependencies);
process.stdout.write(JSON.stringify(result));
