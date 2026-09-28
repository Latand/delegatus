import fs from "node:fs";
import path from "node:path";
import { resolveBinary } from "@/lib/agent/cli";
import {
  claudeManagedEnvironment,
  claudeProviderForHome,
} from "@/lib/accounts/claude";
import type { AccountContext } from "@/lib/accounts/contracts";
import { statePath } from "@/lib/configDir";
import {
  claudeProviderCommand,
  launchDetached,
  headlessRuns,
  reviewerEnvironment,
  terminateHeadlessReviewerGroup,
  type HeadlessReviewRuntime,
  type LiveRun,
} from "./headless";
import {
  mapAgentLine,
  type EphemeralAgentEvent,
} from "@/lib/externalRelay/progress";

export class EphemeralProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EphemeralProfileError";
  }
}
export type EphemeralAgentRequest = {
  key: string;
  engine: "claude" | "codex";
  model: string;
  effort: string | null;
  account: AccountContext;
  ["prompt"]: string;
  schema: object;
  runDir: string;
  hardCapMs: number;
  onEvent?: (event: EphemeralAgentEvent) => void;
  runtime?: HeadlessReviewRuntime;
};
export type EphemeralAgentResult = {
  status: "done" | "failed" | "timeout" | "violation" | "cancelled";
  answer: unknown;
  durationMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
};
export type EphemeralAgentRun = {
  pid: number | null;
  identity: string | null;
  done: Promise<EphemeralAgentResult>;
  cancel(): void;
};
export type EphemeralCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  outputPath: string | null;
  sessionId: null;
  reviewerPath: null;
};
const answerEnvironment = (base: NodeJS.ProcessEnv) =>
  reviewerEnvironment(base, undefined, ["LLV_SPAWN_CAPABILITY", "LLV_RELAY_CREDENTIAL"]);
function answerHome(account: AccountContext): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(account.accountId))
    throw new EphemeralProfileError("invalid account id");
  const source = path.join(account.home, "auth.json");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile())
    throw new EphemeralProfileError("auth file unavailable");
  const home = statePath(`external-relay/codex-homes/${account.accountId}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const link = path.join(home, "auth.json");
  try {
    if (fs.readlinkSync(link) !== source) fs.rmSync(link, { force: true });
  } catch {
    fs.rmSync(link, { force: true });
  }
  if (!fs.existsSync(link)) fs.symlinkSync(source, link);
  return home;
}
function writeCatalog(
  account: AccountContext,
  home: string,
  model: string,
  runDir: string,
): string {
  const cache = [
    path.join(home, "models_cache.json"),
    path.join(account.home, "models_cache.json"),
  ].find((file) => fs.existsSync(file));
  if (!cache) throw new EphemeralProfileError("model catalog unavailable");
  let models: unknown;
  try {
    models = JSON.parse(fs.readFileSync(cache, "utf8")).models;
  } catch {
    throw new EphemeralProfileError("model catalog invalid");
  }
  const found = Array.isArray(models)
    ? models.find((item) => item && item.slug === model)
    : null;
  if (!found || typeof found !== "object")
    throw new EphemeralProfileError("model absent from catalog");
  const {
    multi_agent_version: _agents,
    apply_patch_tool_type: _patch,
    ...entry
  } = found;
  const file = path.join(runDir, "catalog.json");
  fs.writeFileSync(file, JSON.stringify({ models: [entry] }), { mode: 0o600 });
  return file;
}
export function buildEphemeralCommand(
  request: EphemeralAgentRequest,
): EphemeralCommand {
  if (
    !Number.isInteger(request.hardCapMs) ||
    request.hardCapMs < 60_000 ||
    request.hardCapMs > 14_400_000
  )
    throw new EphemeralProfileError("invalid hard cap");
  fs.mkdirSync(request.runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(request.runDir, "cwd"), {
    recursive: true,
    mode: 0o700,
  });
  const schemaPath = path.join(request.runDir, "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
  if (request.engine === "claude") {
    const provider = claudeProviderForHome(request.account.home);
    const baseEnv =
      request.account.kind === "managed"
        ? claudeManagedEnvironment(request.account.home, request.account.env)
        : request.account.env;
    const model = provider?.model ?? request.model;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--json-schema",
      JSON.stringify(request.schema),
      "--no-session-persistence",
      "--model",
      model,
      ...(request.effort ? ["--effort", request.effort] : []),
    ];
    return {
      ...claudeProviderCommand(request.account.home, provider, args),
      env: answerEnvironment(baseEnv),
      stdin: request.prompt,
      outputPath: null,
      sessionId: null,
      reviewerPath: null,
    };
  }
  const home = answerHome(request.account);
  const catalog = writeCatalog(
    request.account,
    home,
    request.model,
    request.runDir,
  );
  const output = path.join(request.runDir, "answer.json");
  const args = [
    "--disable",
    "multi_agent",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "goals",
    "--disable",
    "image_generation",
    "--disable",
    "memories",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "sleep_tool",
    "--disable",
    "view_image",
    "exec",
    "-",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    output,
    "-s",
    "read-only",
    "-c",
    "cli_auth_credentials_store=file",
    "-c",
    "web_search=disabled",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "include_environment_context=false",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "include_collaboration_mode_instructions=false",
    "-c",
    "include_permissions_instructions=false",
    "-c",
    "tools.experimental_request_user_input.enabled=false",
    "-c",
    `model_catalog_json=${JSON.stringify(catalog)}`,
    "-m",
    request.model,
    ...(request.effort
      ? ["-c", `model_reasoning_effort=${request.effort}`]
      : []),
  ];
  return {
    command: resolveBinary("codex"),
    args,
    env: answerEnvironment({ ...request.account.env, CODEX_HOME: home }),
    stdin: request.prompt,
    outputPath: output,
    sessionId: null,
    reviewerPath: null,
  };
}
export function runEphemeralAgent(
  request: EphemeralAgentRequest,
): EphemeralAgentRun {
  const built = buildEphemeralCommand(request);
  const stdout = path.join(request.runDir, "stdout.log");
  const stderr = path.join(request.runDir, "stderr.txt");
  let offset = 0;
  let remainder = "";
  let resultEvent: Record<string, unknown> | null = null;
  let timedOut = false;
  let cancelled = false;
  let violation = false;
  let sawClaudeInit = false;
  let pid: number | null = null;
  let identity: string | null = null;
  const cancel = () => {
    cancelled = true;
    if (pid)
      terminateHeadlessReviewerGroup(pid, identity, {
        ownedByLiveHandle: true,
      });
  };
  const tail = (final = false) => {
    let content: Buffer;
    try {
      const fd = fs.openSync(stdout, "r");
      try {
        const size = fs.fstatSync(fd).size;
        content = Buffer.alloc(Math.max(0, size - offset));
        fs.readSync(fd, content, 0, content.length, offset);
        offset = size;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const lines = (remainder + content.toString("utf8")).split("\n");
    remainder = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item?.type === "result") resultEvent = item;
        if (item?.type === "system" && item?.subtype === "init")
          sawClaudeInit = true;
      } catch {
        /* mapper ignores malformed lines */
      }
      for (const event of mapAgentLine(request.engine, line)) {
        request.onEvent?.(event);
        if (event.type === "violation") {
          violation = true;
          cancel();
        }
      }
    }
  };
  let finish!: (result: EphemeralAgentResult) => void;
  const done = new Promise<EphemeralAgentResult>((resolve) => {
    finish = resolve;
  });
  const ticker = setInterval(tail, 250);
  ticker.unref();
  const launched = launchDetached({
    key: request.key,
    built,
    cwd: path.join(request.runDir, "cwd"),
    stdoutPath: stdout,
    stderrPath: stderr,
    timeoutMs: request.hardCapMs,
    runtime: request.runtime,
    onTimeout: () => {
      timedOut = true;
    },
    onExit: (run: LiveRun) => {
      clearInterval(ticker);
      tail(true);
      headlessRuns.delete(request.key);
      let answer: unknown = null;
      try {
        answer =
          request.engine === "codex"
            ? JSON.parse(fs.readFileSync(built.outputPath!, "utf8"))
            : resultEvent?.subtype === "success"
              ? resultEvent.structured_output
              : null;
      } catch {
        /* invalid answer */
      }
      const exit = run.exit;
      const status: EphemeralAgentResult["status"] =
        violation || (request.engine === "claude" && !sawClaudeInit)
          ? "violation"
          : timedOut
            ? "timeout"
            : cancelled
              ? "cancelled"
              : exit?.code === 0 &&
                  exit.signal === null &&
                  answer &&
                  typeof answer === "object"
                ? "done"
                : "failed";
      finish({
        status,
        answer,
        durationMs: Date.now() - run.startedAt,
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
      });
    },
  });
  if (!launched) {
    clearInterval(ticker);
    finish({
      status: "failed",
      answer: null,
      durationMs: 0,
      code: null,
      signal: null,
    });
  } else {
    pid = launched.pid;
    identity = launched.identity;
  }
  return { pid, identity, done, cancel };
}
