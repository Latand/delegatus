import WebSocket from "ws";
import type { HostedCloudDependencies } from "./cloudHostedClient";

type Row = Record<string, unknown>;
/** HTTP and WebSocket provider substitute. Only the injected transport can
 * reach it; every HTTP request is remapped to this owned loopback listener. */
export function stubCloudBackend(options: { create?: boolean; missingConnector?: boolean; pending?: boolean; failedApprovals?: number; operationPhaseFailed?: boolean; repository?: string; ref?: string } = {}) {
  const calls: { method: string; path: string; account: string; body: Row }[] = [];
  const configs = new Map<string, Row>();
  const approvals = new Map<string, { id: string; failed: boolean }>();
  let approved = !options.create;
  const config = (account: string, id = `asenvcfg_${account}`) => {
    let value = configs.get(id);
    if (!value) { value = { id, name: "misleading display name", repositories: [{ repository_id: "repo-fixture", ref: options.ref ?? "main", mount_path: "/workspace/project" }],
      version_id: approved ? "version-two" : "version-one", version_revision: approved ? 2 : 1,
      latest_ready_version_id: approved ? "version-two" : null, share_settings: "private" }; configs.set(id, value); }
    return value;
  };
  const threadId = ["00000000", "0000", "0000", "0000", "000000000000"].join("-");
  const thread = { id: threadId, ephemeral: false, environments: [{ environmentConfigId: "", environmentId: "ccarenv_fixture", cwd: "/workspace/project" }] };
  let head = "a".repeat(40);
  const server = Bun.serve<{ account: string }>({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url), account = request.headers.get("ChatGPT-Account-Id") ?? "fixture";
      if (url.pathname === "/socket" && server.upgrade(request, { data: { account } })) return;
      const body = request.method === "POST" ? await request.json() as Row : {};
      calls.push({ method: request.method, path: url.pathname + url.search, account, body });
      if (url.pathname === "/backend-api/wham/github/list-repositories") return Response.json({ repositories: [{ id: "repo-fixture", repository_full_name: options.repository ?? "sample/project" }] });
      if (url.pathname === "/backend-api/wham/github/repositories/repo-other") return Response.json({ repository_full_name: "other/project", default_branch: "main" });
      if (url.pathname === "/backend-api/wham/github/repositories/repo-fixture") return Response.json({ repository_full_name: options.repository ?? "sample/project", default_branch: options.ref ?? "main" });
      if (url.pathname === "/v1/environment-configs" && request.method === "GET") {
        if (!options.create) config(account);
        return Response.json({ data: [...configs.values()].filter(value => value.id === `asenvcfg_${account}` || value.id === `asenvcfg_${account}_replacement`), next_cursor: null });
      }
      if (url.pathname === "/v1/environment-configs" && request.method === "POST") {
        const prior = [`asenvcfg_${account}`, `asenvcfg_${account}_replacement`].map(id => configs.get(id)).find(value => value?.name === body.name);
        const value = prior ?? config(account, configs.has(`asenvcfg_${account}`) ? `asenvcfg_${account}_replacement` : `asenvcfg_${account}`);
        value.name = body.name;
        value.repositories = body.repositories;
        Object.assign(value, { version_id: "version-one", latest_ready_version_id: null, version_revision: 1 });
        return Response.json(value);
      }
      const targetId = url.pathname.split("/")[3] ?? "";
      if (/\/drafts$/.test(url.pathname)) {
        Object.assign(config(account, targetId), { draft: { id: "draft-fixture", revision: 1 }, environment_id: "ccarenv_setup" });
        return Response.json({ draft_id: "draft-fixture", environment_id: "ccarenv_setup", thread_id: null });
      }
      if (/\/approve\/begin$/.test(url.pathname)) {
        const key = `${account}:${body.idempotency_key}`;
        if (!approvals.has(key)) approvals.set(key, { id: `operation-fixture-${approvals.size}`, failed: approvals.size < (options.failedApprovals ?? 0) });
        return Response.json({ id: approvals.get(key)!.id, environment_id: "ccarenv_setup", state: "RUNNING" });
      }
      if (/\/environment-operations\//.test(url.pathname)) {
        const operation = [...approvals.values()].find(value => value.id === url.pathname.split("/").at(-1));
        return Response.json({ id: operation?.id, environment_id: "ccarenv_setup", state: operation?.failed ? "FAILED" : options.pending || options.missingConnector ? "RUNNING" : "SUCCEEDED" });
      }
      if (/\/approve\/complete$/.test(url.pathname)) {
        approved = true;
        const value = config(account, targetId); Object.assign(value, { version_id: "version-two", latest_ready_version_id: "version-two", version_revision: 2 });
        return Response.json(value);
      }
      if (/\/drafts\/draft-fixture$/.test(url.pathname)) return Response.json({ ...config(account, targetId), draft: { revision: 1 } });
      if (url.pathname === `/v1/environment-configs/asenvcfg_${account}`) return Response.json(config(account));
      if (url.pathname === `/v1/environment-configs/${targetId}` && configs.has(targetId)) return Response.json(configs.get(targetId));
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as { id?: number; method: string; params: Row };
        if (frame.id === undefined) return;
        calls.push({ method: frame.method, path: "socket", account: socket.data.account, body: frame.params });
        let result: unknown = {};
        switch (frame.method) {
          case "environment/status": result = { data: [{ environmentId: "ccarenv_setup", status: options.missingConnector ? "offline" : "online",
            observations: { phase: options.missingConnector || options.operationPhaseFailed ? "failed" : "ready", ...(options.missingConnector ? { failure: { code: "github_connector_not_configured", message: "private-provider-value" } } : {}) } }] }; break;
          case "thread/start": thread.environments[0]!.environmentConfigId = ((frame.params.environments as Row[])[0]!.environmentConfigId as string); result = { model: "gpt-6.1-sol", thread }; break;
          case "command/exec": result = { exitCode: 0, stdout: head + "\n", stderr: "" }; break;
          case "turn/start": result = { turn: { id: "turn-fixture" } }; break;
          case "thread/read": result = { model: "gpt-6.1-sol", thread }; break;
          case "thread/turns/list": result = { data: [{ id: "turn-fixture", status: "completed", model: "gpt-6.1-sol" }], nextCursor: null }; break;
          case "thread/items/list": result = { data: [{ turnId: "turn-fixture", item: { type: "agentMessage", text: 'Review complete.\n```json\n{"status":"pass","findings":[]}\n```' } }], nextCursor: null }; break;
        }
        socket.send(JSON.stringify({ id: frame.id, result }));
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const dependencies: HostedCloudDependencies = {
    authenticate: async account => ({ token: "fixture-auth", account: account.accountId }),
    socket: auth => new WebSocket(url.replace("http:", "ws:") + "/socket", { headers: { "ChatGPT-Account-Id": auth.account ?? "fixture" } }),
    fetch: (target, init) => {
      const original = new URL(target);
      if (!["https://codex-cloud-backend.chatgpt.com", "https://chatgpt.com"].includes(original.origin)) throw new Error("unexpected provider destination");
      const local = new URL(original.pathname + original.search, url);
      if (local.hostname !== "127.0.0.1") throw new Error("fixture egress refused");
      return fetch(local, init);
    },
    uuid: () => "command-fixture",
  };
  return { url, dependencies, calls, configs, setHead: (value: string) => { head = value; }, stop: () => server.stop(true) };
}
