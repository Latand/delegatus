import type { ClaudeCloudDependencies, ClaudeSendOutcome } from "./cloudClaudeClient";

type Row = Record<string, unknown>;

/** The shapes observed on the installed CLI's read channel, on an owned loopback
 * listener. Only the injected fetch can reach it. Run-call answers are the part
 * no live run has confirmed yet, so each case states the answer it assumes. */
export function fakeClaudeCloud(options: {
  training?: boolean; task?: Row | null; runAnswer?: () => Response; sessionId?: string; probeStatus?: [number, number];
  exportDiff?: string; finalMessage?: string;
  /** Replaces the fake's session behaviour for a sent message. */
  onSend?: (text: string, sessionId: string) => ClaudeSendOutcome | null;
  closedIssue?: number | null;
} = {}) {
  const sessionId = options.sessionId ?? "session_fixture0001";
  const sessions = new Map<string, { created: string; events: Row[]; status: string }>();
  const calls: { method: string; path: string; login: string | null; organization: string | null; body: Row | null }[] = [];
  const sent: string[] = [];
  let clock = Date.UTC(2026, 10, 1);
  const push = (id: string, payload: Row) => {
    const session = sessions.get(id)!;
    session.events.push({ sequence_num: String(session.events.length + 1), event_id: `event-${session.events.length + 1}`, event_type: payload.type, source: "worker", payload });
  };
  const open = (id: string, prompt: string | null = null) => {
    sessions.set(id, { created: new Date(clock).toISOString(), events: [], status: "active" });
    push(id, { type: "env_manager_log" });
    if (prompt !== null) push(id, { type: "user", uuid: "prompt", message: { role: "user", content: prompt } });
  };
  const assistant = (id: string, content: unknown[]) => push(id, { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content } });
  const endTurn = (id: string, extra: Row = {}) => push(id, { type: "result", subtype: "success", is_error: false, result: "", stop_reason: "end_turn", ...extra });
  const bash = (id: string, useId: string, command: string, stdout: string) => {
    assistant(id, [{ type: "tool_use", id: useId, name: "Bash", input: { command } }]);
    push(id, { type: "user", uuid: `result-${useId}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: stdout, is_error: false }] },
      tool_use_result: { interrupted: false, isImage: false, stderr: "", stdout } });
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => null) as Row | null : null;
    const login = request.headers.get("authorization"), organization = request.headers.get("x-organization-uuid");
    calls.push({ method: request.method, path: url.pathname + url.search, login, organization, body });
    if (url.pathname === "/api/oauth/account/settings") return Response.json({ grove_enabled: options.training ?? false });
    if (url.pathname.endsWith("/issues")) return Response.json(options.closedIssue === null ? [] : [{ number: options.closedIssue ?? 7, state: "closed" }]);
    const task = /^\/v1\/code\/triggers\/([^/]+)$/.exec(url.pathname);
    if (task) return options.task === null ? Response.json({ type: "error" }, { status: 400 }) : Response.json(options.task ?? { id: task[1], enabled: true,
      job_config: { ccr: { session_context: { model: "claude-opus-5-5", sources: [{ git_repository: { url: "https://github.com/sample/project" } }] } } } });
    if (/^\/v1\/code\/triggers\/[^/]+\/run$/.test(url.pathname)) {
      if (options.runAnswer) return options.runAnswer();
      open(sessionId, `<routine-fire-payload>${String(body?.text)}</routine-fire-payload>`);
      return Response.json({ session_id: sessionId });
    }
    if (url.pathname === "/v1/code/sessions") return Response.json({ data: [...sessions].map(([id, session]) => ({ id, created_at: session.created, status: session.status })), next_cursor: null });
    const events = /^\/v1\/code\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      const session = sessions.get(events[1]!);
      if (!session) return Response.json({ type: "error" }, { status: 404 });
      const limit = Number(url.searchParams.get("limit") ?? 50), from = Number(url.searchParams.get("cursor") ?? 0);
      const ordered = url.searchParams.get("sort_order") === "asc" ? session.events : [...session.events].reverse();
      const data = ordered.slice(from, from + limit);
      return Response.json({ data, next_cursor: from + limit < ordered.length ? String(from + limit) : null, resume_cursor: "resume" });
    }
    const record = /^\/v1\/code\/sessions\/([^/]+)$/.exec(url.pathname);
    if (record) return Response.json({ response_shape: { id: record[1], status: sessions.get(record[1]!)?.status ?? "active" } });
    return Response.json({ type: "error" }, { status: 404 });
  } });
  const send: ClaudeCloudDependencies["send"] = async input => {
    sent.push(input.text);
    const replaced = options.onSend?.(input.text, input.sessionId);
    if (replaced) return replaced;
    deliver(input.text, input.sessionId);
    return { state: "queued" };
  };
  /** What a session does with a part: runs the probe, or does the work on the last part. */
  function deliver(text: string, id: string) {
    const token = /token ([a-z0-9-]+),/.exec(text)?.[1] ?? "";
    push(id, { type: "user", uuid: `user-${token}`, message: { role: "user", content: text } });
    if (text.startsWith("GitHub write probe")) {
      const commands = text.split("\n").filter(line => line.startsWith("gh api "));
      const [first, second] = options.probeStatus ?? [403, 403];
      bash(id, `probe-${token}-1`, commands[0]!, `HTTP/2.0 ${first} Forbidden\n{}`);
      bash(id, `probe-${token}-2`, commands[1]!, `HTTP/2.0 ${second} Forbidden\n{}`);
      assistant(id, [{ type: "text", text: 'Probe done.\n```json\n{"status":"pass","findings":[]}\n```' }]);
      endTurn(id, { user_message_uuid: `user-${token}` });
      return;
    }
    const part = /^Input part (\d+)\/(\d+),/.exec(text);
    if (!part || part[1] !== part[2]) return;
    if (options.exportDiff !== undefined) {
      const bytes = Buffer.from(options.exportDiff), nonce = /nonce ([a-z0-9]+),/.exec(text)![1]!;
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const encoded = bytes.toString("base64").match(/.{1,2000}/g) ?? [];
      bash(id, `export-${token}`, "git add -A", `DELEGATUS-DIFF ${nonce} ${bytes.length} ${digest}\n${encoded.length}`);
      bash(id, `blocks-${token}`, "awk", encoded.map((block, index) => `DELEGATUS-DIFF-BLOCK ${nonce} ${index + 1} ${block}`).join("\n"));
    }
    assistant(id, [{ type: "text", text: options.finalMessage ?? `Receipt ${token}\nAll checked.\n\n\`\`\`json\n{"status":"pass","findings":[]}\n\`\`\`` }]);
    endTurn(id, { user_message_uuid: `user-${token}` });
  }
  const origin = `http://127.0.0.1:${server.port}`;
  const dependencies: Partial<ClaudeCloudDependencies> = {
    fetch: ((target: string | URL | Request, init?: RequestInit) => {
      const original = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
      if (!["https://api.anthropic.com", "https://api.github.com"].includes(original.origin)) throw new Error("unexpected provider destination");
      return fetch(new URL(original.pathname + original.search, origin), init);
    }) as typeof fetch,
    readLogin: async account => {
      const login = `subscription-login-${account.accountId}`;
      return { accessToken: login, organization: "org-fixture", expiresAt: 0 };
    },
    send,
    random: (() => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); })(),
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
  };
  return { dependencies, calls, sent, sessions, sessionId, open, push, assistant, endTurn, deliver, advance: (ms: number) => { clock += ms; },
    runCalls: () => calls.filter(call => call.method === "POST" && call.path.endsWith("/run")).length, stop: () => server.stop(true) };
}
