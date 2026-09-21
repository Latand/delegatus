/**
 * The seeded home the README screenshots render: four invented projects, the
 * agent conversations working in them, the tasks on their board, two
 * pipelines and two accounts per engine.
 *
 * Everything is written fresh under a capture root, with timestamps relative
 * to the moment of capture, so the board reads "working" and "3 min ago" the
 * way it does on a real machine. Nothing here names a real person, host,
 * repository or credential; the projects are plain folders on purpose, since a
 * repository identity would carry this machine's checkout into the frame.
 *
 * Used by scripts/capture-readme-media.ts.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { directoryProjectId } from "@/lib/projects/identity";

export const DEMO_PROJECTS = ["harbor-api", "lumen-web", "fieldnotes", "quarry"] as const;
export type DemoProject = (typeof DEMO_PROJECTS)[number];

export type DemoLayout = {
  home: string;
  stateDir: string;
  now: number;
  ids: Record<DemoProject, string>;
  dirs: Record<DemoProject, string>;
};

/** A session id in the engines' UUID shape, derived from a label so it is
    stable per run and never written out as a literal. */
export function demoSessionId(label: string): string {
  const hex = createHash("sha256").update(`readme-demo:${label}`).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

const iso = (ms: number) => new Date(ms).toISOString();

/* ── transcripts ────────────────────────────────────────────────────────── */

type Step =
  | { user: string }
  | { say: string }
  | { tool: string; input: Record<string, unknown>; result: string; error?: boolean };

type Conversation = {
  key: string;
  project: DemoProject;
  model: string;
  /** Minutes before capture of the first record. */
  startedMinutesAgo: number;
  /** Seconds between consecutive records. */
  pace: number;
  steps: Step[];
  /** A conversation mid-turn ends on a tool call with no answer yet. */
  midTurn?: { tool: string; input: Record<string, unknown> };
};

function claudeConversations(dirs: Record<DemoProject, string>): Conversation[] {
  const harbor = dirs["harbor-api"];
  const lumen = dirs["lumen-web"];
  const field = dirs.fieldnotes;
  const quarry = dirs.quarry;
  return [
    {
      key: "refunds-builder",
      project: "harbor-api",
      model: "claude-opus-5",
      startedMinutesAgo: 34,
      pace: 21,
      steps: [
        { user: "Add idempotency keys to POST /refunds so a retried request never refunds twice. Keep the API shape and cover it with tests." },
        { say: "I'll look at how the refunds handler writes today, then add the key lookup before the charge call." },
        {
          tool: "Grep",
          input: { pattern: "createRefund", path: "src", output_mode: "content" },
          result: "src/refunds/handler.ts:42:export async function createRefund(req: Request): Promise<Response> {\nsrc/refunds/handler.test.ts:3:import { createRefund } from \"./handler\";\nsrc/routes.ts:18:  post(\"/refunds\", createRefund),",
        },
        {
          tool: "Read",
          input: { file_path: `${harbor}/src/refunds/handler.ts`, offset: 40, limit: 24 },
          result: "40\t\n41\t/** POST /refunds */\n42\texport async function createRefund(req: Request): Promise<Response> {\n43\t  const body = RefundRequest.parse(await req.json());\n44\t  const charge = await payments.refund(body.chargeId, body.amount);\n45\t  const row = await db.refunds.insert({ ...body, providerId: charge.id });\n46\t  return Response.json(row, { status: 201 });\n47\t}",
        },
        { say: "The handler calls the payment provider before it records anything, so a client that retries after a timeout gets refunded twice. I'll store the key and the response in the same transaction as the refund row, and answer a repeated key from that row." },
        {
          tool: "Write",
          input: {
            file_path: `${harbor}/migrations/0042_idempotency_keys.sql`,
            content: "CREATE TABLE idempotency_keys (\n  key text PRIMARY KEY,\n  request_hash text NOT NULL,\n  response jsonb NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);\n",
          },
          result: "File created successfully at: migrations/0042_idempotency_keys.sql",
        },
        {
          tool: "Edit",
          input: {
            file_path: `${harbor}/src/refunds/handler.ts`,
            old_string: "  const body = RefundRequest.parse(await req.json());\n  const charge = await payments.refund(body.chargeId, body.amount);",
            new_string: "  const body = RefundRequest.parse(await req.json());\n  const key = req.headers.get(\"Idempotency-Key\");\n  const replay = key ? await idempotency.lookup(key, body) : null;\n  if (replay) return Response.json(replay.response, { status: replay.status });\n  const charge = await payments.refund(body.chargeId, body.amount);",
          },
          result: "The file src/refunds/handler.ts has been updated.",
        },
        {
          tool: "Bash",
          input: { command: "bun test src/refunds", description: "Run the refunds tests" },
          result: "src/refunds/handler.test.ts:\n✓ creates a refund [12.40ms]\n✓ answers a repeated key with the stored response [4.10ms]\n✓ rejects a reused key with a different body (409) [3.20ms]\n✓ refunds normally without a key [2.90ms]\n\n 4 pass\n 0 fail\n 11 expect() calls\nRan 4 tests across 1 file. [188.00ms]",
        },
        { say: "Done. `POST /refunds` now honours an `Idempotency-Key` header:\n\n- a repeated key with the same body returns the first response and never calls the provider again;\n- the same key with a different body answers **409**;\n- requests without a key behave exactly as before.\n\nThe key and the response are written in the refund's transaction (migration `0042`), so a crash between the charge and the insert cannot leave a key without its row. Four tests cover it." },
      ],
    },
    {
      key: "cart-rounding",
      project: "lumen-web",
      model: "claude-sonnet-5",
      startedMinutesAgo: 95,
      pace: 18,
      steps: [
        { user: "The cart shows 19.989999 for three items at 6.663. Round money in one place and fix the display." },
        {
          tool: "Grep",
          input: { pattern: "toFixed|\\* quantity", path: "src/cart" },
          result: "src/cart/CartSummary.tsx:31:  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\nsrc/cart/LineItem.tsx:14:  {(item.price * item.quantity).toFixed(2)}",
        },
        {
          tool: "Edit",
          input: {
            file_path: `${lumen}/src/cart/CartSummary.tsx`,
            old_string: "  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
            new_string: "  const total = sumCents(items.map((item) => lineCents(item)));",
          },
          result: "The file src/cart/CartSummary.tsx has been updated.",
        },
        {
          tool: "Bash",
          input: { command: "bun test src/cart", description: "Run the cart tests" },
          result: " 9 pass\n 0 fail\nRan 9 tests across 3 files. [241.00ms]",
        },
        { say: "Money is now kept in integer cents from the line item up (`lineCents`, `sumCents` in `src/money.ts`) and formatted once at the edge. Three items at 6.663 show **19.99**." },
      ],
    },
    {
      key: "product-grid",
      project: "lumen-web",
      model: "claude-sonnet-5",
      startedMinutesAgo: 6,
      pace: 25,
      steps: [
        { user: "Make the product grid lazy-load images below the fold. Measure before and after on the category page." },
        { say: "I'll take a baseline on the category page first." },
        {
          tool: "Bash",
          input: { command: "bun run perf:category --runs 5", description: "Baseline the category page" },
          result: "LCP  2.84 s (median of 5)\nbytes on first load  4.1 MB\nimages requested  48",
        },
      ],
      midTurn: { tool: "Edit", input: { file_path: `${lumen}/src/catalog/ProductGrid.tsx`, old_string: "<img src={product.image}", new_string: "<img loading=\"lazy\" src={product.image}" } },
    },
    {
      key: "offline-drafts",
      project: "fieldnotes",
      model: "claude-opus-5",
      startedMinutesAgo: 12,
      pace: 30,
      steps: [
        { user: "Offline drafts: queue note edits while the phone has no signal and sync them in order when it comes back." },
        { say: "I'll put a small write-ahead queue in front of the sync client so edits survive an app restart." },
        {
          tool: "Read",
          input: { file_path: `${field}/src/sync/client.ts` },
          result: "1\timport { api } from \"../api\";\n2\t\n3\texport async function saveNote(note: Note) {\n4\t  return api.put(`/notes/${note.id}`, note);\n5\t}",
        },
      ],
      midTurn: { tool: "Write", input: { file_path: `${field}/src/sync/queue.ts`, content: "export class EditQueue {}\n" } },
    },
    {
      key: "import-profile",
      project: "quarry",
      model: "claude-opus-5",
      startedMinutesAgo: 140,
      pace: 40,
      steps: [
        { user: "Why does the nightly import take 40 minutes now? Profile it and report before changing anything." },
        {
          tool: "Bash",
          input: { command: "bun run import --dry-run --profile", description: "Profile the import in dry-run mode" },
          result: "parse        1m 12s\nvalidate       48s\ngeocode     34m 05s\nwrite        2m 31s",
        },
        { say: "The geocoder is 34 of the 38 minutes: every row is geocoded again, including the 96% that did not move since last night. Two options:\n\n1. cache results by normalised address (fast, needs a table);\n2. only geocode rows whose address changed (no new storage, relies on the diff).\n\nWhich one do you want?" },
      ],
    },
  ];
}

function claudeTranscript(conversation: Conversation, cwd: string, sessionId: string, now: number): { lines: string[]; lastAt: number } {
  const lines: string[] = [];
  let at = now - conversation.startedMinutesAgo * 60_000;
  let n = 0;
  const base = { cwd, sessionId, version: "2.1.0", gitBranch: "main" };
  const next = () => {
    at += conversation.pace * 1000;
    n += 1;
    return { uuid: demoSessionId(`${conversation.key}:${n}`), timestamp: iso(at) };
  };
  for (const step of conversation.steps) {
    if ("user" in step) {
      lines.push(JSON.stringify({ type: "user", ...next(), ...base, message: { role: "user", content: step.user } }));
    } else if ("say" in step) {
      lines.push(JSON.stringify({ type: "assistant", ...next(), ...base, message: { role: "assistant", model: conversation.model, content: [{ type: "text", text: step.say }] } }));
    } else {
      const id = `toolu_${createHash("sha256").update(`${conversation.key}:${n}`).digest("hex").slice(0, 20)}`;
      lines.push(JSON.stringify({ type: "assistant", ...next(), ...base, message: { role: "assistant", model: conversation.model, content: [{ type: "tool_use", id, name: step.tool, input: step.input }] } }));
      lines.push(JSON.stringify({ type: "user", ...next(), ...base, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: step.result, ...(step.error ? { is_error: true } : {}) }] } }));
    }
  }
  if (conversation.midTurn) {
    const id = `toolu_${createHash("sha256").update(`${conversation.key}:pending`).digest("hex").slice(0, 20)}`;
    lines.push(JSON.stringify({ type: "assistant", ...next(), ...base, message: { role: "assistant", model: conversation.model, content: [{ type: "tool_use", id, name: conversation.midTurn.tool, input: conversation.midTurn.input }] } }));
  }
  return { lines, lastAt: at };
}

/** The reviewer the running pipeline's review stage has open: a Codex
    rollout, mid-turn. */
function codexReviewRollout(cwd: string, sessionId: string, now: number): { lines: string[]; lastAt: number; stamp: string } {
  let at = now - 4 * 60_000;
  const start = at;
  const step = (seconds: number) => {
    at += seconds * 1000;
    return iso(at);
  };
  const lines = [
    { type: "session_meta", timestamp: iso(at), payload: { id: sessionId, cwd, originator: "codex_cli_rs", cli_version: "0.151.0", source: "cli", model_provider: "openai" } },
    { type: "turn_context", timestamp: step(1), payload: { cwd, model: "gpt-5.6-sol", effort: "xhigh", approval_policy: "never", sandbox_policy: { type: "read-only" } } },
    { type: "event_msg", timestamp: step(2), payload: { type: "user_message", message: "Review the idempotent refunds change against the acceptance criteria: a repeated key never reaches the provider, a reused key with a different body answers 409, and requests without a key are unchanged." } },
    { type: "event_msg", timestamp: step(9), payload: { type: "agent_message", message: "Reading the diff against main first, then the tests that claim each criterion.", phase: "commentary" } },
    { type: "response_item", timestamp: step(4), payload: { type: "function_call", name: "shell", call_id: "call-review-1", arguments: JSON.stringify({ command: ["git", "diff", "--stat", "main...HEAD"] }) } },
    { type: "response_item", timestamp: step(2), payload: { type: "function_call_output", call_id: "call-review-1", output: " migrations/0042_idempotency_keys.sql |  6 ++++\n src/refunds/handler.test.ts          | 58 +++++++++++++++\n src/refunds/handler.ts               | 19 ++++-\n src/refunds/idempotency.ts           | 41 ++++++++++\n 4 files changed, 122 insertions(+), 2 deletions(-)" } },
    { type: "event_msg", timestamp: step(20), payload: { type: "agent_message", message: "The lookup and the insert share one transaction. Checking what happens when two requests with the same key arrive together.", phase: "commentary" } },
    { type: "response_item", timestamp: step(3), payload: { type: "function_call", name: "shell", call_id: "call-review-2", arguments: JSON.stringify({ command: ["bun", "test", "src/refunds"] }) } },
  ];
  return { lines: lines.map((line) => JSON.stringify(line)), lastAt: at, stamp: iso(start) };
}

/* ── state files ────────────────────────────────────────────────────────── */

type Written = { path: string; lastAt: number };

function assignment(file: Written, engine: "claude" | "codex") {
  return { path: file.path, panePid: null, state: "delivered", error: null, at: iso(file.lastAt - 60_000), accountId: "default", engine };
}

function buildTasks(layout: DemoLayout, files: Record<string, Written>) {
  const { ids, now } = layout;
  const ago = (minutes: number) => iso(now - minutes * 60_000);
  const task = (id: string, project: DemoProject, status: string, text: string, assignments: unknown[], createdMinutesAgo: number) => ({
    id, project: ids[project], status, text, placement: "unplaced", assignments, createdAt: ago(createdMinutesAgo), updatedAt: ago(Math.max(1, createdMinutesAgo - 5)),
  });
  return {
    tasks: [
      task("task-refunds", "harbor-api", "assigned", "Idempotent refunds\nA retried POST /refunds must never refund twice.", [assignment(files["refunds-builder"]!, "claude")], 36),
      task("task-webhook-retries", "harbor-api", "inbox", "Back off webhook retries\nExponential backoff with jitter; stop after 24 hours and surface the failure.", [], 50),
      task("task-cart-rounding", "lumen-web", "done", "Fix cart rounding\nKeep money in integer cents and format once.", [assignment(files["cart-rounding"]!, "claude")], 100),
      task("task-product-grid", "lumen-web", "assigned", "Lazy-load the product grid\nImages below the fold load on scroll; measure LCP before and after.", [assignment(files["product-grid"]!, "claude")], 8),
      task("task-offline-drafts", "fieldnotes", "assigned", "Offline drafts\nQueue edits without signal and sync them in order.", [assignment(files["offline-drafts"]!, "claude")], 14),
      task("task-editor-dark", "fieldnotes", "inbox", "Dark mode for the note editor\nFollow the system setting; keep the highlight colours readable.", [], 70),
      task("task-import-speed", "quarry", "blocked", "Speed up the nightly import\nGeocoding is 34 of 38 minutes. Waiting on a choice: cache by address or geocode changed rows only.", [assignment(files["import-profile"]!, "claude")], 145),
    ],
  };
}

const STAGE_ROLES = {
  builder: { engine: "claude", model: "opus", effort: "high", access: "read-write" },
  reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only" },
  verifier: { engine: "claude", model: "sonnet", effort: "medium", access: "read-only" },
} as const;

type RoleId = keyof typeof STAGE_ROLES;

const SCAFFOLDS: Record<RoleId, string> = {
  builder: "You are a Builder. Implement the pinned task with focused checks and report the evidence.",
  reviewer: "You are a Reviewer. Read the full diff against the acceptance criteria and report a verdict.",
  verifier: "You are a Verifier. Run the gates and confirm the change behaves where it should.",
};

/* Each record has to pass the store's own validator (isPipeline in
   src/lib/pipelines/store.ts) or the Viewer refuses to boot on it: a
   role-bound stage carries a non-empty scaffold, the worktree and branch
   derive from the id, and fail edges sit on run stages only. */
function effectiveRole(roleId: RoleId) {
  return { roleId, ...STAGE_ROLES[roleId], promptScaffold: SCAFFOLDS[roleId] };
}

function stage(id: string, roleId: RoleId, prompt: string, next: string | null, onFail: { to: string; maxRounds: number } | null = null) {
  return { id, kind: "run", role: { roleId }, prompt, next, onFail, effectiveRole: effectiveRole(roleId) };
}

type Activation = { stageId: string; attempt: number; edge: "pass" | "fail" } | null;

function attempt(roleId: RoleId, state: string, startedAt: string, completedAt: string | null, output: string | null, agentPath: string | null, activatedBy: Activation) {
  return {
    n: 1,
    state,
    effectiveRole: effectiveRole(roleId),
    definition: null,
    launchId: null,
    conversationId: null,
    sessionId: null,
    agentPath,
    paneId: null,
    flowId: null,
    startedAt,
    completedAt,
    input: null,
    activatedBy,
    output,
    verdict: state === "passed" ? { status: "pass", findings: [] } : null,
    error: null,
  };
}

/** Same derivation as pipelineIdentity in the store. */
function identity(id: string, task: string, repoDir: string) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
  return { worktreeDir: path.join(path.dirname(repoDir), `${path.basename(repoDir)}-pipeline-${id}`), branch: `pipeline/${slug}-${id}` };
}

function buildPipelines(layout: DemoLayout, files: Record<string, Written>) {
  const { ids, dirs, now } = layout;
  const ago = (minutes: number) => iso(now - minutes * 60_000);
  const stages = [
    stage("build", "builder", "Implement {{task}} and cover it with tests.", "review"),
    stage("review", "reviewer", "Review the full diff against the acceptance criteria.", "verify", { to: "build", maxRounds: 3 }),
    stage("verify", "verifier", "Run the gates and confirm the behaviour end to end.", null),
  ];
  const common = { baseBranch: "main", baseRef: "", lastPassedCommit: "", publishedCommit: null, stages, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, hiddenAt: null };

  const refundsTask = "Idempotent refunds";
  const running = {
    ...common,
    id: "4c9e21d7",
    task: refundsTask,
    taskIds: ["task-refunds"],
    project: ids["harbor-api"],
    repoDir: dirs["harbor-api"],
    ...identity("4c9e21d7", refundsTask, dirs["harbor-api"]),
    spec: "A repeated Idempotency-Key never reaches the payment provider; a reused key with a different body answers 409; requests without a key are unchanged.",
    runs: [
      { stageId: "build", attempts: [attempt("builder", "passed", ago(33), ago(5), "Idempotency keys stored with the refund in one transaction; four tests.", files["refunds-builder"]!.path, null)] },
      { stageId: "review", attempts: [attempt("reviewer", "running", ago(4), null, null, files["refunds-review"]!.path, { stageId: "build", attempt: 1, edge: "pass" })] },
      { stageId: "verify", attempts: [] },
    ],
    cursor: { stageId: "review", state: "running", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } },
    state: "running",
    createdAt: ago(35),
    closedAt: null,
  };

  const roundingTask = "Fix cart rounding";
  const landed = {
    ...common,
    id: "8f30b6a2",
    task: roundingTask,
    taskIds: ["task-cart-rounding"],
    project: ids["lumen-web"],
    repoDir: dirs["lumen-web"],
    ...identity("8f30b6a2", roundingTask, dirs["lumen-web"]),
    spec: "Three items at 6.663 show 19.99; money stays in integer cents until it is displayed.",
    runs: [
      { stageId: "build", attempts: [attempt("builder", "passed", ago(94), ago(88), "Money kept in cents; one formatter.", files["cart-rounding"]!.path, null)] },
      { stageId: "review", attempts: [attempt("reviewer", "passed", ago(87), ago(80), "No findings.", null, { stageId: "build", attempt: 1, edge: "pass" })] },
      { stageId: "verify", attempts: [attempt("verifier", "passed", ago(79), ago(74), "Tests and the cart page agree.", null, { stageId: "review", attempt: 1, edge: "pass" })] },
    ],
    cursor: null,
    state: "completed",
    createdAt: ago(96),
    closedAt: ago(74),
  };

  return { schemaVersion: 5, pipelines: [running, landed] };
}

/* ── the home ───────────────────────────────────────────────────────────── */

/**
 * Write the whole demo home under `home`. Returns what the capture needs to
 * address it: the project ids the Viewer derives and the transcript paths.
 */
export function seedDemoHome(home: string, stateDir: string, now: number): DemoLayout & { files: Record<string, Written> } {
  const dirs = {} as Record<DemoProject, string>;
  const ids = {} as Record<DemoProject, string>;
  for (const project of DEMO_PROJECTS) {
    const directory = path.join(home, "Projects", project);
    fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    dirs[project] = fs.realpathSync.native(directory);
    ids[project] = directoryProjectId(dirs[project]);
  }
  const layout: DemoLayout = { home, stateDir, now, ids, dirs };
  const files: Record<string, Written> = {};

  const write = (file: string, lines: string[], lastAt: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const mtime = new Date(lastAt);
    fs.utimesSync(file, mtime, mtime);
    return { path: file, lastAt };
  };

  for (const conversation of claudeConversations(dirs)) {
    const cwd = dirs[conversation.project];
    const sessionId = demoSessionId(conversation.key);
    const { lines, lastAt } = claudeTranscript(conversation, cwd, sessionId, now);
    const folder = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    files[conversation.key] = write(path.join(folder, `${sessionId}.jsonl`), lines, lastAt);
  }

  const reviewId = demoSessionId("refunds-review");
  const review = codexReviewRollout(dirs["harbor-api"], reviewId, now);
  const day = review.stamp.slice(0, 10).split("-");
  const rolloutName = `rollout-${review.stamp.slice(0, 19).replaceAll(":", "-")}-${reviewId}.jsonl`;
  files["refunds-review"] = write(path.join(home, ".codex", "sessions", day[0]!, day[1]!, day[2]!, rolloutName), review.lines, review.lastAt);

  fs.mkdirSync(stateDir, { recursive: true });
  const json = (name: string, value: unknown) => fs.writeFileSync(path.join(stateDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  json("tasks.json", buildTasks(layout, files));
  json("pipelines.json", buildPipelines(layout, files));
  json("resources.json", {
    system: { ramTotal: 32 * 2 ** 30, ramAvailable: 19 * 2 ** 30, swapTotal: 8 * 2 ** 30, swapUsed: 0, capturedAt: iso(now) },
    sessions: [],
  });

  assertNoRepositoryLeak(home);
  return { ...layout, files };
}

/**
 * Two accounts per engine with limit readings, written through the Viewer's
 * own account and registry modules. The caller must already have pointed
 * HOME, XDG_CONFIG_HOME and LLV_STATE_DIR at the demo home.
 */
export async function seedDemoAccounts(home: string, now: number): Promise<void> {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}", { mode: 0o600 });

  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const { agentRegistry } = await import("@/lib/agent/registry");

  const codexSide = createManagedCodexAccount("Side project");
  fs.writeFileSync(path.join(codexSide.home, "auth.json"), "{}", { mode: 0o600 });
  const claudeWork = createManagedClaudeAccount("Work");
  fs.writeFileSync(path.join(claudeWork.home, ".credentials.json"), "{}", { mode: 0o600 });

  const DAY = 86_400;
  const nowS = Math.floor(now / 1000);
  const at = iso(now);
  const live = { source: "live" as const, reason: null, staleSince: null };
  const window = (usedPercent: number, resetsAfter: number, windowMinutes: number) => ({ usedPercent, resetsAt: nowS + resetsAfter, windowMinutes });
  const observation = (engine: "claude" | "codex", accountId: string) => ({ engine, accountId, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "readme", provenance: live });

  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [
      { ...observation("codex", "default"), limits: { session: window(27, 3 * 3_600 + 1_260, 300), weekly: window(46, 3 * DAY + 5 * 3_600, 10_080), plan: "pro", capturedAt: nowS }, resetCredits: { availableCount: 0, expiresAt: null } },
      { ...observation("codex", codexSide.id), limits: { session: window(4, 4 * 3_600, 300), weekly: window(12, 6 * DAY, 10_080), plan: "plus", capturedAt: nowS }, resetCredits: { availableCount: 0, expiresAt: null } },
    ],
    signature: null, bootId: "readme", now: at, minimumGapMs: 60_000,
  });
  agentRegistry().recordQuotaEvaluation({
    engine: "claude",
    observations: [
      {
        ...observation("claude", "default"),
        limits: { session: window(38, 2 * 3_600 + 600, 300), weekly: window(52, 4 * DAY + 2 * 3_600, 10_080), flagship: { ...window(61, 4 * DAY + 2 * 3_600, 10_080), tier: "opus" }, plan: "max", capturedAt: nowS },
      },
      { ...observation("claude", claudeWork.id), limits: { session: window(9, 4 * 3_600, 300), weekly: window(23, 5 * DAY, 10_080), plan: "max", capturedAt: nowS } },
    ],
    signature: null, bootId: "readme", now: at, minimumGapMs: 60_000,
  });
}

/** The projects are plain folders on purpose: a repository identity would
    carry this machine's checkout into the frame. */
export function assertNoRepositoryLeak(home: string): void {
  const result = spawnSync("git", ["-C", path.join(home, "Projects"), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) throw new Error(`demo projects resolved into a repository: ${result.stdout.trim()}`);
}
