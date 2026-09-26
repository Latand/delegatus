import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * The landing demo's world: one invented project, harbor-api, as Delegatus
 * would answer it, at each step of the scripted walkthrough. Every record is a
 * function of (step, language), so a jump or a language switch rebuilds the
 * same world in the other words. Nothing here names a real person, machine or
 * repository.
 *
 * Steps:
 *   0  the operator's request waits in the orchestrator's composer
 *   1  sent; the orchestrator is working
 *   2  it answered: a task on the board, its pipeline's Build running
 *   3  Build passed and reported; Review runs on Codex
 *   4  Review passed and reported; Verify runs
 *   5  the webhook-retries pipeline stopped on a decision: Needs you
 */

export type Lang = "en" | "uk";
export const LAST_STEP = 5;
export const PROJECT = "harbor-api";

const MIN = 60;

export interface World {
  files: FileEntry[];
  tasks: BoardTask[];
  pipelines: Pipeline[];
  reports: Array<{ seq: number; at: string; class: string; body: string }>;
  transcripts: Map<string, string>;
  /** The conversation id of the orchestrator's seat. */
  seat: FileEntry;
  seatBusy: boolean;
  /** The request the composer carries at step 0. */
  request: string;
  needsYou: number;
}

/* ── transcripts, in the Claude line format ─────────────────────────── */
const transcriptLine = (when: string, body: Record<string, unknown>) => JSON.stringify({ timestamp: when, ...body });
/** An agent's reply, as a transcript line. */
export const saidLine = (when: string, text: string, model = "claude-opus-5-5") => transcriptLine(when, { type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn" } });
/** What the operator typed, as a transcript line. */
export const askedLine = (when: string, text: string) => transcriptLine(when, { type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });

export function buildWorld(step: number, lang: Lang, bootSeconds: number, stepSeconds: number[]): World {
  const L = (en: string, uk: string) => (lang === "uk" ? uk : en);
  /* Times read relative to the page's boot, and a step's own records to the
     moment that step arrived, so "just now" stays true while the visitor reads. */
  const now = Math.floor(Date.now() / 1000);
  /* History is dated from the boot, so a transcript's earlier lines never change between reads. */
  const iso = (secondsBeforeBoot: number) => new Date((bootSeconds - secondsBeforeBoot) * 1000).toISOString();
  const ago = (seconds: number) => new Date((now - seconds) * 1000).toISOString();
  /** How long ago step `s` arrived, in seconds. */
  const at = (s: number) => Math.max(1, Math.round(now - (stepSeconds[s] ?? now)));
  /** The moment step `s` arrived, less `before` seconds, to the millisecond. */
  const since = (s: number, before = 0) => new Date(Math.round(((stepSeconds[s] ?? now) - before) * 1000)).toISOString();

  const files: FileEntry[] = [];
  const transcripts = new Map<string, string>();
  const add = (id: string, title: string, over: Record<string, unknown> = {}) => {
    const file = {
      /* Under the account the conversation runs on, as a managed account keeps them, so every surface names it. */
      path: `/work/.delegatus/accounts/${over.engine ?? "claude"}/main/projects/${over.project ?? PROJECT}/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`, project: PROJECT, title,
      engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: now - 40 * MIN, size: 4096, activity: "idle", proc: null, pid: null,
      model: "claude-opus-5-5", pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, cwd: `/work/${over.project ?? PROJECT}`,
      ...over,
    } as unknown as FileEntry;
    files.push(file);
    return file;
  };
  const working = (current: string, startedAgo = 90) => ({
    activity: "live", proc: "running", pid: 4401, mtime: now - 4,
    authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    lastTurn: { startedAt: (now - startedAgo) * 1000, endedAt: null },
    plan: { current },
  });
  const idle = (endedAgo: number) => ({
    mtime: now - endedAgo,
    authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: new Date((now - endedAgo) * 1000).toISOString() },
    lastTurn: { startedAt: (now - endedAgo - 300) * 1000, endedAt: (now - endedAgo) * 1000 },
  });
  const codex = { engine: "codex", fmt: "claude", model: "gpt-6-sol" };

  const line = transcriptLine;
  const said = saidLine;
  const asked = askedLine;
  let toolN = 0;
  const tool = (when: string, name: string, input: Record<string, unknown>, result: string) => {
    toolN += 1;
    const id = `toolu_demo_${toolN}`;
    return [
      line(when, { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" } }),
      line(when, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] } }),
    ];
  };
  const write = (file: FileEntry, lines: string[]) => {
    const body = `${lines.join("\n")}\n`;
    transcripts.set(file.path, body);
    (file as unknown as { size: number }).size = new TextEncoder().encode(body).length;
  };

  const request = L(
    "Add idempotency keys to POST /refunds: a retried request must never refund twice.",
    "Додай ключі ідемпотентності до POST /refunds: повторний запит ніколи не повинен повертати гроші двічі.",
  );

  /* The orchestrator's seat. */
  const seatBusy = step === 1;
  const seat = add("orchestrator", L("Orchestrator · harbor-api", "Оркестратор · harbor-api"), step === 1 ? working(L("Planning the refunds task", "Планую задачу про повернення"), at(1)) : idle(step >= 2 ? at(2) : 25 * MIN));
  const seatLines = [
    asked(iso(52 * MIN), L(
      "Take the open harbor-api work: the webhook retries and the key rotation first. The ledger move waits for finance.",
      "Візьмися за відкриту роботу в harbor-api: спершу повтори вебхуків і ротація ключів. Перенесення в новий реєстр чекає на фінансистів.",
    )),
    said(iso(51 * MIN), L(
      "On it. **Back off webhook retries** has a pipeline (Build, Review, Verify), and **Rotate webhook signing keys** has a builder on it. The ledger task stays in Blocked until finance answers.\n\nI'll report each stage as it lands, and bring you any decision the spec leaves open.",
      "Беруся. Для **Затримки повторів вебхуків** відкрив пайплайн (Build, Review, Verify), над **Ротацією ключів підпису** вже працює розробник. Задача з реєстром лишається в «Заблоковано», доки фінансисти не дадуть відповідь.\n\nЗвітуватиму про кожен етап і принесу тобі рішення, яких не дає специфікація.",
    )),
  ];
  if (step >= 2) {
    seatLines.push(asked(since(1), request));
    seatLines.push(...tool(since(2), "mcp__viewer__create_task", { project: PROJECT, text: L("Idempotent refunds", "Ідемпотентні повернення") }, "task created"));
    seatLines.push(...tool(since(2), "mcp__viewer__create_pipeline", { project: PROJECT, task: L("Idempotent refunds", "Ідемпотентні повернення"), stages: ["build", "review", "verify"] }, "pipeline started"));
    seatLines.push(said(since(2), L(
      "On it. **Idempotent refunds** is on the board with a pipeline: Build on Claude, Review on Codex, then Verify. The reviewer starts fresh and read-only.\n\nI'll report when Build lands.",
      "Беруся. **Ідемпотентні повернення** вже на дошці, з пайплайном: Build на Claude, Review на Codex, далі Verify. Рев’юер стартує з нуля і лише читає код.\n\nЗвітую, щойно Build завершиться.",
    )));
  }
  write(seat, seatLines);

  /* Key rotation: a plain conversation, working the whole time. */
  const keys = add("key-rotation", L("Signing key rotation", "Ротація ключа підпису"), working(L("Adding the key ring", "Додаю зв’язку ключів"), 9 * MIN));
  write(keys, [
    asked(iso(9 * MIN), L(
      "Rotate the webhook signing keys without downtime: sign with the new key, accept both for a day, then drop the old one.",
      "Зроби ротацію ключів підпису вебхуків без простою: підписуй новим ключем, добу приймай обидва, потім прибери старий.",
    )),
    said(iso(8 * MIN), L(
      "I'll add a key ring with an activation time, so verification accepts the previous key during the overlap.",
      "Додам зв’язку ключів із часом активації, щоб перевірка приймала попередній ключ, поки діють обидва.",
    )),
    ...tool(iso(7 * MIN), "Grep", { pattern: "hmac\\(", path: "src/webhooks" }, "src/webhooks/sign.ts:9:  return hmac(currentKey(), payload);\nsrc/webhooks/verify.ts:7:  const expected = hmac(currentKey(), payload);"),
  ]);

  /* Webhook retries: its builder works until the decision (step 5). */
  const retriesDecided = step >= 5;
  const retries = add("webhook-retries", L("Webhook retry backoff", "Затримка повторів вебхуків"), retriesDecided
    ? idle(at(5))
    : working(L("Reading the delivery loop", "Читаю цикл доставки"), 20 * MIN));
  const retriesLines = [
    asked(iso(21 * MIN), L(
      "Back off webhook retries: exponential with jitter, and stop at some point instead of retrying forever.",
      "Зроби експоненційну затримку повторів вебхуків із джитером, і хай вони колись зупиняються, а не йдуть вічно.",
    )),
    ...tool(iso(19 * MIN), "Grep", { pattern: "scheduleRetry", path: "src/webhooks" }, "src/webhooks/deliver.ts:31:  await scheduleRetry(delivery, 60);\nsrc/webhooks/deliver.ts:48:export async function scheduleRetry(delivery: Delivery, seconds: number) {"),
  ];
  if (retriesDecided) retriesLines.push(said(since(5), L(
    "Every failed delivery retries after a flat 60 s today, with no limit. The backoff is straightforward, but where to stop is a product choice, so I'm reporting this stage as a decision: stop after **24 hours** (about 12 attempts) or after **72 hours** (about 18, which covers an endpoint that is down over a weekend)?",
    "Зараз кожна невдала доставка повторюється через рівні 60 с, без межі. Затримку зробити просто, але де зупинятися — рішення продукту, тож я віддаю цей етап на рішення: зупиняти через **24 години** (близько 12 спроб) чи через **72 години** (близько 18, це покриває ендпоінт, що лежить усі вихідні)?",
  )));
  write(retries, retriesLines);

  /* Charges pagination: done this morning. */
  const charges = add("charges-pagination", L("Charges pagination", "Пагінація платежів"), { ...idle(3 * 60 * MIN), model: "claude-sonnet-5" });
  write(charges, [
    asked(iso(4 * 60 * MIN), L("GET /charges returns every row. Add cursor pagination with a default page of 50 and a hard cap of 200.", "GET /charges повертає всі рядки. Додай пагінацію курсором: за замовчуванням 50 на сторінку, жорстка межа 200.")),
    ...tool(iso(3 * 60 * MIN + 200), "Bash", { command: "bun test src/charges", description: L("Run the charges tests", "Запустити тести платежів") }, " 7 pass\n 0 fail\nRan 7 tests across 2 files. [203.00ms]"),
    said(iso(3 * 60 * MIN), L(
      "`GET /charges` now takes `limit` (default 50, capped at 200) and an opaque `cursor`; the response carries `next_cursor` until the last page.",
      "`GET /charges` тепер приймає `limit` (за замовчуванням 50, не більше 200) і непрозорий `cursor`; відповідь містить `next_cursor` аж до останньої сторінки.",
    ), "claude-sonnet-5"),
  ]);

  /* The refunds pipeline's three conversations, from step 2 on. */
  let refundsBuild: FileEntry | null = null;
  let refundsReview: FileEntry | null = null;
  let refundsVerify: FileEntry | null = null;
  if (step >= 2) {
    const building = step === 2;
    refundsBuild = add("refunds-builder", L("Idempotent refunds · Build", "Ідемпотентні повернення · Build"), building
      ? working(L("Writing the key lookup", "Пишу пошук ключа"), at(2))
      : idle(at(3)));
    const buildLines = [
      asked(since(2), L(
        "Add idempotency keys to POST /refunds so a retried request never refunds twice. Keep the API shape and cover it with tests.",
        "Додай ключі ідемпотентності до POST /refunds, щоб повторний запит ніколи не повертав гроші двічі. Форму API не змінюй, покрий тестами.",
      )),
      said(since(2), L(
        "I'll look at how the refunds handler writes today, then add the key lookup before the charge call.",
        "Подивлюся, як обробник повернень пише зараз, і додам пошук ключа перед викликом платіжного провайдера.",
      )),
      ...tool(since(2), "Read", { file_path: "src/refunds/handler.ts", offset: 40, limit: 8 },
        "40\t\n41\t/** POST /refunds */\n42\texport async function createRefund(req: Request): Promise<Response> {\n43\t  const body = RefundRequest.parse(await req.json());\n44\t  const charge = await payments.refund(body.chargeId, body.amount);\n45\t  const row = await db.refunds.insert({ ...body, providerId: charge.id });\n46\t  return Response.json(row, { status: 201 });\n47\t}"),
    ];
    if (!building) {
      buildLines.push(
        ...tool(since(3, 20), "Edit", {
          file_path: "src/refunds/handler.ts",
          old_string: "  const body = RefundRequest.parse(await req.json());\n  const charge = await payments.refund(body.chargeId, body.amount);",
          new_string: "  const body = RefundRequest.parse(await req.json());\n  const key = req.headers.get(\"Idempotency-Key\");\n  const replay = key ? await idempotency.lookup(key, body) : null;\n  if (replay) return Response.json(replay.response, { status: replay.status });\n  const charge = await payments.refund(body.chargeId, body.amount);",
        }, "The file src/refunds/handler.ts has been updated."),
        ...tool(since(3, 8), "Bash", { command: "bun test src/refunds", description: L("Run the refunds tests", "Запустити тести повернень") },
          "src/refunds/handler.test.ts:\n✓ creates a refund [12.40ms]\n✓ answers a repeated key with the stored response [4.10ms]\n✓ rejects a reused key with a different body (409) [3.20ms]\n✓ refunds normally without a key [2.90ms]\n\n 4 pass\n 0 fail\nRan 4 tests across 1 file. [188.00ms]"),
        said(since(3), L(
          "Done. `POST /refunds` now honours an `Idempotency-Key` header. A repeated key with the same body returns the first response without calling the provider again, the same key with a different body answers **409**, and requests without a key behave as before.",
          "Готово. `POST /refunds` тепер враховує заголовок `Idempotency-Key`. Повторний ключ із тим самим тілом повертає першу відповідь, не звертаючись до провайдера вдруге, той самий ключ з іншим тілом отримує **409**, а запити без ключа працюють як раніше.",
        )),
      );
    }
    write(refundsBuild, buildLines);
  }
  if (step >= 3) {
    const reviewing = step === 3;
    refundsReview = add("refunds-reviewer", L("Idempotent refunds · Review", "Ідемпотентні повернення · Review"), {
      ...codex, ...(reviewing ? working(L("Two requests with one key, at once", "Два запити з одним ключем одночасно"), at(3)) : idle(at(4))),
    });
    const reviewLines = [
      asked(since(3), L(
        "Review the idempotent refunds change against the acceptance criteria: a repeated key never reaches the provider, a reused key with a different body answers 409, and requests without a key are unchanged.",
        "Перевір зміну з ідемпотентними поверненнями за критеріями: повторний ключ ніколи не доходить до провайдера, той самий ключ з іншим тілом отримує 409, запити без ключа не змінюються.",
      )),
      said(since(3), L("Reading the diff against main first, then the tests that claim each criterion.", "Спершу читаю дифф відносно main, потім тести, що покривають кожен критерій."), "gpt-6-sol"),
      ...tool(since(3), "Bash", { command: "git diff --stat main...HEAD" }, " migrations/0042_idempotency_keys.sql |  6 ++++\n src/refunds/handler.test.ts          | 58 +++++++++++++++\n src/refunds/handler.ts               | 19 ++++-\n src/refunds/idempotency.ts           | 41 ++++++++++\n 4 files changed, 122 insertions(+), 2 deletions(-)"),
    ];
    if (!reviewing) reviewLines.push(said(since(4), L(
      "**Pass.** The lookup and the insert share one transaction, so two requests with the same key arriving together refund once; I ran that case against a local database. No findings.",
      "**Пройдено.** Пошук і вставка йдуть в одній транзакції, тож два одночасні запити з однаковим ключем повертають гроші один раз; я прогнав цей випадок на локальній базі. Зауважень немає.",
    ), "gpt-6-sol"));
    write(refundsReview, reviewLines);
  }
  if (step >= 4) {
    refundsVerify = add("refunds-verifier", L("Idempotent refunds · Verify", "Ідемпотентні повернення · Verify"), { ...working(L("Replaying a timed-out refund", "Повторюю повернення після тайм-ауту"), at(4)), model: "claude-sonnet-5" });
    write(refundsVerify, [
      asked(since(4), L("Run the gates and confirm a retried refund is answered from the stored response on a running server.", "Прожени перевірки й підтверди на запущеному сервері, що повторне повернення отримує збережену відповідь.")),
      ...tool(since(4), "Bash", { command: "bun run typecheck && bun test src/refunds" }, " 4 pass\n 0 fail"),
    ]);
  }

  /* Other projects, so the rail reads like a machine with more than one. */
  const others: Array<{ file: FileEntry; project: string }> = [];
  const other = (id: string, project: string, title: string, over: Record<string, unknown> = {}) => {
    const file = add(id, title, { project, ...over });
    write(file, [asked(iso(2 * 60 * MIN), title), said(iso(2 * 60 * MIN - 60), L("On it.", "Беруся."))]);
    others.push({ file, project });
  };
  other("cart-rounding", "lumen-web", L("Cart rounding", "Округлення кошика"), idle(95 * MIN));
  other("product-grid", "lumen-web", L("Lazy product grid", "Ліниве завантаження сітки товарів"), working(L("Measuring LCP", "Вимірюю LCP"), 6 * MIN));
  other("offline-drafts", "fieldnotes", L("Offline edit queue", "Черга офлайн-правок"), working(L("Writing the edit queue", "Пишу чергу правок"), 12 * MIN));
  other("import-profile", "quarry", L("Import profiling", "Профілювання імпорту"), idle(140 * MIN));

  /* ── pipelines ──────────────────────────────────────────────────────── */
  const role = (roleId: string, engine: string, model: string, effort: string, access: string) => ({ roleId, engine, model, effort, access, promptScaffold: null });
  const ROLES = {
    builder: role("builder", "claude", "opus", "high", "read-write"),
    reviewer: role("reviewer", "codex", "gpt-6-sol", "xhigh", "read-only"),
    verifier: role("verifier", "claude", "sonnet", "medium", "read-only"),
  };
  const stage = (id: string, roleId: keyof typeof ROLES, prompt: string, next: string | null, onFail: { to: string; maxRounds: number } | null = null) =>
    ({ id, kind: "run", role: { roleId }, prompt, next, onFail, effectiveRole: ROLES[roleId] });
  const attempt = (roleId: keyof typeof ROLES, state: string, file: FileEntry | null, startedAt: string, completedAt: string | null, activatedBy: unknown = null, verdict: unknown = state === "passed" ? { status: "pass", findings: [] } : null) => ({
    n: 1, state, effectiveRole: ROLES[roleId], launchId: file ? `launch-${file.name}` : null, conversationId: file?.conversationId ?? null,
    sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null, startedAt, completedAt, input: null, activatedBy, output: null, verdict, error: null,
  });
  const lane = (id: string, task: string, taskId: string, state: string, runs: unknown[], cursor: unknown, createdAt: string, over: Record<string, unknown> = {}) => ({
    id, task, taskIds: [taskId], project: PROJECT, repoDir: `/work/${PROJECT}`, worktreeDir: `/work/${PROJECT}-${id}`, branch: `pipeline/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "", runs, cursor, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt, closedAt: null,
    stages: [
      stage("build", "builder", L("{{task}}\n\nImplement it with focused tests.", "{{task}}\n\nРеалізуй це з точковими тестами."), "review"),
      stage("review", "reviewer", L("{{prev.output}}\n\nReview the diff against the acceptance criteria.", "{{prev.output}}\n\nПеревір дифф за критеріями приймання."), "verify", { to: "build", maxRounds: 3 }),
      stage("verify", "verifier", L("{{prev.output}}\n\nRun the gates on a running server.", "{{prev.output}}\n\nПрожени перевірки на запущеному сервері."), null),
    ],
    ...over,
  }) as unknown as Pipeline;

  const pipelines: Pipeline[] = [];
  const retriesBuildAttempt = attempt("builder", retriesDecided ? "needs_decision" : "running", retries, iso(20 * MIN), retriesDecided ? since(5) : null, null,
    retriesDecided ? { status: "needs_decision", findings: [L(
      "Retry window: stop retrying a failed delivery after 24 hours or after 72 hours? The spec leaves it open, and it sets how many attempts a delivery gets.",
      "Вікно повторів: припиняти повтори невдалої доставки через 24 години чи через 72? Специфікація цього не каже, а від цього залежить, скільки спроб отримає доставка.",
    )] } : null);
  pipelines.push(lane("p-retries", L("Back off webhook retries", "Затримка повторів вебхуків"), "t-retries", retriesDecided ? "needs_decision" : "running",
    [{ stageId: "build", attempts: [retriesBuildAttempt] }],
    { stageId: "build", state: retriesDecided ? "needs_decision" : "running", input: null, activatedBy: null }, iso(21 * MIN),
    retriesDecided ? { stateDetail: L("Build needs a decision: retry window", "Build чекає рішення: вікно повторів") } : {}));

  if (step >= 2) {
    const runs: Array<{ stageId: string; attempts: unknown[] }> = [
      { stageId: "build", attempts: [attempt("builder", step === 2 ? "running" : "passed", refundsBuild, since(2), step >= 3 ? since(3) : null)] },
    ];
    if (step >= 3) runs.push({ stageId: "review", attempts: [attempt("reviewer", step === 3 ? "running" : "passed", refundsReview, since(3), step >= 4 ? since(4) : null, { stageId: "build", attempt: 1, edge: "pass" })] });
    if (step >= 4) runs.push({ stageId: "verify", attempts: [attempt("verifier", "running", refundsVerify, since(4), null, { stageId: "review", attempt: 1, edge: "pass" })] });
    const current = step === 2 ? "build" : step === 3 ? "review" : "verify";
    pipelines.push(lane("p-refunds", L("Idempotent refunds", "Ідемпотентні повернення"), "t-refunds", "running", runs, { stageId: current, state: "running", input: null, activatedBy: null }, since(2), {
      stageReports: [
        ...(step >= 3 ? [{ seq: 1, at: since(3), actor: { kind: "agent", role: "builder", conversationId: refundsBuild?.conversationId }, stageId: "build", attempt: 1, status: "pass", findings: 0, replaces: null, summary: L("Repeated keys answer from the stored response; 4 tests pass.", "Повторні ключі отримують збережену відповідь; 4 тести проходять.") }] : []),
        ...(step >= 4 ? [{ seq: 2, at: since(4), actor: { kind: "agent", role: "reviewer", conversationId: refundsReview?.conversationId }, stageId: "review", attempt: 1, status: "pass", findings: 0, replaces: null, summary: L("No findings; parallel requests refund once.", "Зауважень немає; паралельні запити повертають гроші один раз.") }] : []),
      ],
    }));
  }

  /* ── tasks ──────────────────────────────────────────────────────────── */
  let revision = 1;
  const task = (id: string, status: TaskStatus, text: string, members: FileEntry[], updatedAgo: number, color: string, icon: string, project = PROJECT): BoardTask => ({
    id, project, text, status, placement: "unplaced", board: "shown", color, icon,
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: ago(updatedAgo), engine: member.engine })),
    createdAt: ago(updatedAgo + 30 * MIN), updatedAt: ago(updatedAgo), revision: `task-v1:00000000-0000-4000-8000-${String(revision++).padStart(12, "0")}`,
  }) as unknown as BoardTask;
  const tasks: BoardTask[] = [
    task("t-errors", "inbox", L("Document refund error codes\nOne table in the API reference: code, meaning, whether a retry is safe.", "Описати коди помилок повернень\nОдна таблиця в довіднику API: код, значення, чи безпечно повторювати."), [], 55 * MIN, "pink", "file-text"),
    task("t-keys", "assigned", L("Rotate webhook signing keys\nSign with the new key, accept both for a day, then drop the old one.", "Ротація ключів підпису вебхуків\nПідписувати новим ключем, добу приймати обидва, потім прибрати старий."), [keys], 9 * MIN, "amber", "key-round"),
    task("t-retries", "assigned", L("Back off webhook retries\nExponential backoff with jitter, and a limit on how long a delivery retries.", "Затримка повторів вебхуків\nЕкспоненційна затримка з джитером і межа, як довго доставка повторюється."), [retries], retriesDecided ? at(5) : 20 * MIN, "teal", "repeat"),
    task("t-ledger", "blocked", L("Move invoices to the new ledger\nWaiting on finance to confirm the rounding rule for partial refunds.", "Перенести рахунки в новий реєстр\nЧекаємо, поки фінансисти підтвердять правило округлення часткових повернень."), [], 5 * 60 * MIN, "amber", "book-open"),
    task("t-charges", "done", L("Paginate GET /charges\nCursor pagination, 50 per page, capped at 200.", "Пагінація GET /charges\nПагінація курсором, 50 на сторінку, не більше 200."), [charges], 3 * 60 * MIN, "lime", "list-ordered"),
  ];
  const otherFile = (id: string) => others.find((entry) => entry.file.name === `${id}.jsonl`)!;
  tasks.push(
    task("t-grid", "assigned", L("Lazy-load the product grid\nImages below the fold load on scroll; measure LCP before and after.", "Ліниве завантаження сітки товарів\nЗображення нижче згину вантажаться під час прокрутки; виміряти LCP до і після."), [otherFile("product-grid").file], 6 * MIN, "teal", "layout-grid", "lumen-web"),
    task("t-cart", "done", L("Fix cart rounding\nKeep money in integer cents and format once.", "Виправити округлення в кошику\nЗберігати гроші в цілих центах і форматувати один раз."), [otherFile("cart-rounding").file], 95 * MIN, "coral", "calculator", "lumen-web"),
    task("t-drafts", "assigned", L("Offline drafts\nQueue edits without signal and sync them in order.", "Офлайн-чернетки\nСтавити правки в чергу без зв’язку й синхронізувати їх по порядку."), [otherFile("offline-drafts").file], 12 * MIN, "lime", "wifi-off", "fieldnotes"),
    task("t-import", "blocked", L("Speed up the nightly import\nGeocoding is 34 of 38 minutes. Waiting on a choice: cache by address or geocode changed rows only.", "Пришвидшити нічний імпорт\nГеокодування займає 34 з 38 хвилин. Чекає вибору: кешувати за адресою чи геокодувати лише змінені рядки."), [otherFile("import-profile").file], 140 * MIN, "teal", "gauge", "quarry"),
  );
  if (step >= 2) {
    tasks.splice(1, 0, task("t-refunds", "assigned", L("Idempotent refunds\nA retried POST /refunds must never refund twice.", "Ідемпотентні повернення\nПовторний POST /refunds ніколи не повинен повертати гроші двічі."),
      [refundsBuild, refundsReview, refundsVerify].filter((file): file is FileEntry => file !== null), at(Math.min(step, 4)), "sky", "receipt-text"));
  }

  /* ── the orchestrator's report log, newest last here ────────────────── */
  const reports: World["reports"] = [
    { seq: 101, at: iso(4 * 60 * MIN), class: "status", body: L("Two lanes running: webhook retries in Build, key rotation with its builder. The ledger move stays in Blocked until finance answers.", "Дві задачі в роботі: повтори вебхуків на етапі Build, ротація ключів у розробника. Перенесення реєстру лишається в «Заблоковано», доки не відповідять фінансисти.") },
    { seq: 102, at: iso(3 * 60 * MIN + 200), class: "review_verdict", body: L("Paginate GET /charges passed review with no findings: pages of 50, the cap of 200 holds, and next_cursor stops on the last page.", "Пагінація GET /charges пройшла рев’ю без зауважень: сторінки по 50, межа 200 тримається, next_cursor зупиняється на останній сторінці.") },
    { seq: 103, at: iso(3 * 60 * MIN), class: "completed", body: L("Paginate GET /charges is done: cursor pages of 50, capped at 200, 7 tests pass. The PR is merged and the task moved to Done.", "Пагінація GET /charges готова: сторінки по 50 з курсором, не більше 200, 7 тестів проходять. PR змерджено, задачу перенесено в «Готово».") },
  ];
  if (step >= 3) reports.push({ seq: 104, at: since(3), class: "completed", body: L("Idempotent refunds: Build passed. A repeated Idempotency-Key now answers from the stored response, and 4 tests pass. Review started on Codex.", "Ідемпотентні повернення: Build пройшов. Повторний Idempotency-Key тепер отримує збережену відповідь, 4 тести проходять. Review стартував на Codex.") });
  if (step >= 4) reports.push({ seq: 105, at: since(4), class: "review_verdict", body: L("Idempotent refunds passed review with no findings: two requests with one key refund once. Verify is running.", "Ідемпотентні повернення пройшли рев’ю без зауважень: два запити з одним ключем повертають гроші один раз. Verify виконується.") });
  if (step >= 5) reports.push({ seq: 106, at: since(5), class: "question", body: L("Back off webhook retries stopped on a decision the spec leaves open: stop retrying after 24 or 72 hours? It waits on the card.", "Затримка повторів вебхуків зупинилася на рішенні, якого немає в специфікації: припиняти повтори через 24 чи через 72 години? Чекає на картці.") });

  return { files, tasks, pipelines, reports, transcripts, seat, seatBusy, request, needsYou: retriesDecided ? 1 : 0 };
}
