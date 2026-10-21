import type { TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";
import type { MemoryProfileView, ProfilePartView } from "@/lib/memory/profileTypes";
import type { CuratorPassView, RoleMemoryProjectView, RuleView, ScopeView, StageLessonView } from "@/lib/memory/roleTypes";
import type { AutonomySetting } from "@/lib/monitor/autonomy";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskHold, TaskStatus } from "@/lib/tasks/types";
import type { BurndownPayload, BurndownSeries, FileEntry } from "@/lib/types";

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
 *
 * The autonomy flag (`autonomy=1` in a frame's query) turns the orchestrator's
 * full autonomy on for that frame alone: at step 5 the seat has answered the
 * retry window itself, so its Build runs again and nothing waits for you.
 * Below the world sit the seat tick's autonomy episode, the learned rules and
 * their curator, each task's limit spend and the accounts' limit history.
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

export function buildWorld(step: number, lang: Lang, bootSeconds: number, stepSeconds: number[], autonomy = false): World {
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
      model: "claude-opus-5-5", effort: "high", pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, cwd: `/work/${over.project ?? PROJECT}`,
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
  const codex = { engine: "codex", fmt: "claude", model: "gpt-6-sol", effort: "xhigh" };

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
      "On it. **Back off webhook retries** has a pipeline (Build, Review, Verify), and **Rotate webhook signing keys** has a builder on it. The ledger task stays in Waiting until finance answers.\n\nI'll report each stage as it lands, and bring you any decision the spec leaves open.",
      "Беруся. Для **Затримки повторів вебхуків** відкрив пайплайн (Build, Review, Verify), над **Ротацією ключів підпису** вже працює розробник. Задача з реєстром лишається в «Очікують», доки фінансисти не дадуть відповідь.\n\nЗвітуватиму про кожен етап і принесу тобі рішення, яких не дає специфікація.",
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

  /* Webhook retries: its builder works until the decision (step 5). Under
     full autonomy the seat answers it at once and the builder goes on. */
  const retriesDecided = step >= 5;
  const retriesAnswered = retriesDecided && autonomy;
  const retries = add("webhook-retries", L("Webhook retry backoff", "Затримка повторів вебхуків"), retriesAnswered
    ? working(L("Stopping retries after 72 hours", "Зупиняю повтори через 72 години"), at(5))
    : retriesDecided
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
  const charges = add("charges-pagination", L("Charges pagination", "Пагінація платежів"), { ...idle(3 * 60 * MIN), model: "claude-sonnet-5", effort: "medium" });
  write(charges, [
    asked(iso(4 * 60 * MIN), L("GET /charges returns every row. Add cursor pagination with a default page of 50 and a hard cap of 200.", "GET /charges повертає всі рядки. Додай пагінацію курсором: за замовчуванням 50 на сторінку, жорстка межа 200.")),
    ...tool(iso(3 * 60 * MIN + 200), "Bash", { command: "bun test src/charges", description: L("Run the charges tests", "Запустити тести платежів") }, " 7 pass\n 0 fail\nRan 7 tests across 2 files. [203.00ms]"),
    said(iso(3 * 60 * MIN), L(
      "`GET /charges` now takes `limit` (default 50, capped at 200) and an opaque `cursor`; the response carries `next_cursor` until the last page.",
      "`GET /charges` тепер приймає `limit` (за замовчуванням 50, не більше 200) і непрозорий `cursor`; відповідь містить `next_cursor` аж до останньої сторінки.",
    ), "claude-sonnet-5"),
  ]);

  /* The rest of a working week on harbor-api: one more builder at work, one
     waiting on its review, and what shipped before today. */
  const logs = add("request-logs", L("Structured request logs", "Структуровані логи запитів"), working(L("Replacing the router's console lines", "Замінюю рядки console у роутері"), 14 * MIN));
  write(logs, [
    asked(iso(15 * MIN), L("Log one JSON line per request: route, status, duration and the request id.", "Пиши один JSON-рядок на запит: маршрут, статус, тривалість і id запиту.")),
    said(iso(14 * MIN), L("I'll add one logger in the router middleware and drop the scattered console lines.", "Додам один логер у проміжний шар роутера і приберу розкидані рядки console.")),
  ]);
  const settled = (id: string, title: string, ask: string, answer: string, endedAgo: number, model = "claude-opus-5-5") => {
    const file = add(id, title, { ...idle(endedAgo), model });
    write(file, [asked(iso(endedAgo + 25 * MIN), ask), said(iso(endedAgo), answer, model)]);
    return file;
  };
  const receipts = settled("refund-receipts", L("Refund receipts", "Квитанції про повернення"),
    L("Email the customer a receipt once the provider confirms a refund, in the merchant's language.", "Надсилай клієнту квитанцію, щойно провайдер підтвердить повернення, мовою мерчанта."),
    L("The receipt goes out from the provider's confirmation webhook, once per refund. Ready for review.", "Квитанція йде з вебхука підтвердження провайдера, один раз на повернення. Готово до рев’ю."), 32 * MIN);
  const health = settled("replica-lag", L("Replica lag in /health", "Затримка репліки в /health"),
    L("Make /health report replica lag: degraded above 5 s, down above 60 s.", "Хай /health показує затримку репліки: degraded понад 5 с, down понад 60 с."),
    L("`/health` now reads the replica's lag and answers degraded above 5 s and down above 60 s.", "`/health` тепер читає затримку репліки: degraded понад 5 с, down понад 60 с."), 6 * 60 * MIN, "claude-sonnet-5");
  const postgres = settled("postgres-17", L("Postgres 17 upgrade", "Оновлення до Postgres 17"),
    L("Upgrade to Postgres 17. Replay every migration on a copy first; no downtime.", "Онови до Postgres 17. Спершу прожени всі міграції на копії; без простою."),
    L("All 42 migrations replayed on a copy, then the primary switched over with no downtime.", "Усі 42 міграції пройшли на копії, потім основна база перемкнулася без простою."), 26 * 60 * MIN);
  const timeouts = settled("provider-timeouts", L("Provider call timeouts", "Тайм-аути викликів провайдера"),
    L("Time out payment provider calls after 10 s so a hung provider stops holding workers.", "Обривай виклики платіжного провайдера через 10 с, щоб завислий провайдер не тримав воркерів."),
    L("Every provider call now carries a 10 s deadline and a hung call frees its worker.", "Кожен виклик провайдера тепер має межу 10 с, і завислий виклик звільняє воркера."), 30 * 60 * MIN);

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
      asked(since(2, 25), L(
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
      asked(since(3, 25), L(
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
    refundsVerify = add("refunds-verifier", L("Idempotent refunds · Verify", "Ідемпотентні повернення · Verify"), { ...working(L("Replaying a timed-out refund", "Повторюю повернення після тайм-ауту"), at(4)), model: "claude-sonnet-5", effort: "medium" });
    write(refundsVerify, [
      asked(since(4, 25), L("Run the gates and confirm a retried refund is answered from the stored response on a running server.", "Прожени перевірки й підтверди на запущеному сервері, що повторне повернення отримує збережену відповідь.")),
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
  const retriesWaits = retriesDecided && !retriesAnswered;
  const retriesAttempts = retriesAnswered ? [retriesBuildAttempt, { ...attempt("builder", "running", retries, since(5), null), n: 2 }] : [retriesBuildAttempt];
  pipelines.push(lane("p-retries", L("Back off webhook retries", "Затримка повторів вебхуків"), "t-retries", retriesWaits ? "needs_decision" : "running",
    [{ stageId: "build", attempts: retriesAttempts }],
    { stageId: "build", state: retriesWaits ? "needs_decision" : "running", input: null, activatedBy: null }, iso(21 * MIN),
    retriesWaits ? { stateDetail: L("Build needs a decision: retry window", "Build чекає рішення: вікно повторів") } : {}));

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
  const task = (id: string, status: TaskStatus, text: string, members: FileEntry[], updatedAgo: number, color: string, icon: string, project = PROJECT, hold?: Omit<TaskHold, "since" | "by">): BoardTask => ({
    id, project, text, status, placement: "unplaced", board: "shown", color, icon,
    ...(hold ? { hold: { ...hold, since: ago(updatedAgo), by: "agent" } } : {}),
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: ago(updatedAgo), engine: member.engine })),
    createdAt: ago(updatedAgo + 30 * MIN), updatedAt: ago(updatedAgo), revision: `task-v1:00000000-0000-4000-8000-${String(revision++).padStart(12, "0")}`,
  }) as unknown as BoardTask;
  const tasks: BoardTask[] = [
    task("t-errors", "inbox", L("Document refund error codes\nOne table in the API reference: code, meaning, whether a retry is safe.", "Описати коди помилок повернень\nОдна таблиця в довіднику API: код, значення, чи безпечно повторювати."), [], 55 * MIN, "pink", "file-text"),
    task("t-keys", "assigned", L("Rotate webhook signing keys\nSign with the new key, accept both for a day, then drop the old one.", "Ротація ключів підпису вебхуків\nПідписувати новим ключем, добу приймати обидва, потім прибрати старий."), [keys], 9 * MIN, "amber", "key-round"),
    task("t-retries", "assigned", L("Back off webhook retries\nExponential backoff with jitter, and a limit on how long a delivery retries.", "Затримка повторів вебхуків\nЕкспоненційна затримка з джитером і межа, як довго доставка повторюється."), [retries], retriesDecided ? at(5) : 20 * MIN, "teal", "repeat"),
    task("t-ledger", "blocked", L("Move invoices to the new ledger\nWaiting on finance to confirm the rounding rule for partial refunds.", "Перенести рахунки в новий реєстр\nЧекаємо, поки фінансисти підтвердять правило округлення часткових повернень."), [], 5 * 60 * MIN, "amber", "book-open", PROJECT,
      { kind: "external", note: L("finance confirms the rounding rule", "фінансисти підтвердять правило округлення") }),
    task("t-charges", "done", L("Paginate GET /charges\nCursor pagination, 50 per page, capped at 200.", "Пагінація GET /charges\nПагінація курсором, 50 на сторінку, не більше 200."), [charges], 3 * 60 * MIN, "lime", "list-ordered"),
    task("t-ratelimit", "inbox", L("Rate-limit refunds per merchant\nAt most 20 a minute; answer 429 with Retry-After.", "Обмежити частоту повернень для мерчанта\nНе більше 20 на хвилину; відповідати 429 з Retry-After."), [], 80 * MIN, "teal", "shield-check"),
    task("t-export", "inbox", L("Export refunds as CSV\nFor the finance team's monthly close.", "Експорт повернень у CSV\nДля щомісячного закриття у фінансистів."), [], 2 * 60 * MIN, "lime", "download"),
    task("t-logs", "assigned", L("Structured request logs\nOne JSON line per request: route, status, duration, request id.", "Структуровані логи запитів\nОдин JSON-рядок на запит: маршрут, статус, тривалість, id запиту."), [logs], 14 * MIN, "slate", "scroll-text"),
    task("t-receipts", "assigned", L("Email a receipt for each refund\nSent once the provider confirms, in the merchant's language.", "Квитанція на кожне повернення\nНадсилається після підтвердження провайдера, мовою мерчанта."), [receipts], 32 * MIN, "lime", "mail", PROJECT, { kind: "pr", ref: "131", note: "" }),
    task("t-v1", "blocked", L("Retire the v1 charges endpoint\nTwo merchants still call it; waiting on their move to v2.", "Прибрати ендпоінт платежів v1\nДва мерчанти ще його викликають; чекаємо, поки перейдуть на v2."), [], 26 * 60 * MIN, "slate", "archive", PROJECT,
      { kind: "external", note: L("two merchants move to v2", "двоє мерчантів перейдуть на v2") }),
    task("t-health", "done", L("Report replica lag in /health\nDegraded above 5 s of lag, down above 60 s.", "Затримка репліки в /health\nDegraded понад 5 с затримки, down понад 60 с."), [health], 6 * 60 * MIN, "teal", "activity"),
    task("t-postgres", "done", L("Upgrade to Postgres 17\nEvery migration replayed on a copy first; no downtime.", "Оновлення до Postgres 17\nУсі міграції спершу на копії; без простою."), [postgres], 26 * 60 * MIN, "teal", "database"),
    task("t-timeouts", "done", L("Time out provider calls after 10 s\nA hung provider no longer holds a worker.", "Тайм-аут викликів провайдера 10 с\nЗавислий провайдер більше не тримає воркера."), [timeouts], 30 * 60 * MIN, "coral", "timer"),
  ];
  const otherFile = (id: string) => others.find((entry) => entry.file.name === `${id}.jsonl`)!;
  tasks.push(
    task("t-grid", "assigned", L("Lazy-load the product grid\nImages below the fold load on scroll; measure LCP before and after.", "Ліниве завантаження сітки товарів\nЗображення нижче згину вантажаться під час прокрутки; виміряти LCP до і після."), [otherFile("product-grid").file], 6 * MIN, "teal", "layout-grid", "lumen-web"),
    task("t-cart", "done", L("Fix cart rounding\nKeep money in integer cents and format once.", "Виправити округлення в кошику\nЗберігати гроші в цілих центах і форматувати один раз."), [otherFile("cart-rounding").file], 95 * MIN, "coral", "calculator", "lumen-web"),
    task("t-drafts", "assigned", L("Offline drafts\nQueue edits without signal and sync them in order.", "Офлайн-чернетки\nСтавити правки в чергу без зв’язку й синхронізувати їх по порядку."), [otherFile("offline-drafts").file], 12 * MIN, "lime", "wifi-off", "fieldnotes"),
    task("t-import", "blocked", L("Speed up the nightly import\nGeocoding is 34 of 38 minutes. Waiting on a choice: cache by address or geocode changed rows only.", "Пришвидшити нічний імпорт\nГеокодування займає 34 з 38 хвилин. Чекає вибору: кешувати за адресою чи геокодувати лише змінені рядки."), [otherFile("import-profile").file], 140 * MIN, "teal", "gauge", "quarry",
      { kind: "operator", note: L("cache by address or geocode changed rows only", "кешувати за адресою чи геокодувати лише змінені рядки") }),
  );
  if (step >= 2) {
    tasks.splice(1, 0, task("t-refunds", "assigned", L("Idempotent refunds\nA retried POST /refunds must never refund twice.", "Ідемпотентні повернення\nПовторний POST /refunds ніколи не повинен повертати гроші двічі."),
      [refundsBuild, refundsReview, refundsVerify].filter((file): file is FileEntry => file !== null), at(Math.min(step, 4)), "sky", "receipt-text"));
  }

  /* ── the orchestrator's report log, newest last here ────────────────── */
  const reports: World["reports"] = [
    { seq: 101, at: iso(4 * 60 * MIN), class: "status", body: L("Two lanes running: webhook retries in Build, key rotation with its builder. The ledger move stays in Waiting until finance answers.", "Дві задачі в роботі: повтори вебхуків на етапі Build, ротація ключів у розробника. Перенесення реєстру лишається в «Очікують», доки не відповідять фінансисти.") },
    { seq: 102, at: iso(3 * 60 * MIN + 200), class: "review_verdict", body: L("Paginate GET /charges passed review with no findings: pages of 50, the cap of 200 holds, and next_cursor stops on the last page.", "Пагінація GET /charges пройшла рев’ю без зауважень: сторінки по 50, межа 200 тримається, next_cursor зупиняється на останній сторінці.") },
    { seq: 103, at: iso(3 * 60 * MIN), class: "completed", body: L("Paginate GET /charges is done: cursor pages of 50, capped at 200, 7 tests pass. The PR is merged and the task moved to Done.", "Пагінація GET /charges готова: сторінки по 50 з курсором, не більше 200, 7 тестів проходять. PR змерджено, задачу перенесено в «Готово».") },
  ];
  if (step >= 3) reports.push({ seq: 104, at: since(3), class: "completed", body: L("Idempotent refunds: Build passed. A repeated Idempotency-Key now answers from the stored response, and 4 tests pass. Review started on Codex.", "Ідемпотентні повернення: Build пройшов. Повторний Idempotency-Key тепер отримує збережену відповідь, 4 тести проходять. Review стартував на Codex.") });
  if (step >= 4) reports.push({ seq: 105, at: since(4), class: "review_verdict", body: L("Idempotent refunds passed review with no findings: two requests with one key refund once. Verify is running.", "Ідемпотентні повернення пройшли рев’ю без зауважень: два запити з одним ключем повертають гроші один раз. Verify виконується.") });
  if (step >= 5 && !retriesAnswered) reports.push({ seq: 106, at: since(5), class: "question", body: L("Back off webhook retries stopped on a decision the spec leaves open: stop retrying after 24 or 72 hours? It waits on the card.", "Затримка повторів вебхуків зупинилася на рішенні, якого немає в специфікації: припиняти повтори через 24 чи через 72 години? Чекає на картці.") });
  if (retriesAnswered) reports.push({ seq: 106, at: since(5), class: "status", body: L("Under full autonomy: webhook retries stop after 72 hours; the stage runs again.", "Під повною автономією: повтори вебхуків зупиняються через 72 години; етап запущено знову.") });

  return { files, tasks, pipelines, reports, transcripts, seat, seatBusy, request, needsYou: retriesWaits ? 1 : 0 };
}

/* ── the seat tick: an autonomy episode and the decisions it recorded ── */

const HOUR = 3600;
const isoAt = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Eight hours of full autonomy, turned on by the operator 3 h 48 min before
    the page opened, with the three decisions the seat made in it. */
export function buildAutonomy(lang: Lang, bootSeconds: number, decidedAtSeconds: number): AutonomySetting {
  const L = (en: string, uk: string) => (lang === "uk" ? uk : en);
  const seatActor = { kind: "manager" as const, conversationId: "conversation_orchestrator", project: PROJECT, seatEpoch: 1 };
  const operator = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };
  const startedAt = isoAt(bootSeconds - 3 * HOUR - 48 * MIN);
  return {
    enabled: true, startedAt, until: isoAt(bootSeconds + 4 * HOUR + 12 * MIN), endedAt: null, endReason: null,
    updatedAt: startedAt, setBy: operator, why: null,
    decisions: [
      {
        id: "d1", at: isoAt(decidedAtSeconds), taskId: "t-retries", by: seatActor, reviewState: "decided",
        decision: L("Webhook retries stop after 72 hours.", "Повтори вебхуків зупиняються через 72 години."),
        why: L("Most merchants fix a broken endpoint within a weekend; 24 hours would drop their deliveries.", "Більшість мерчантів лагодять зламаний ендпоінт за вихідні; за 24 години їхні доставки пропали б."),
        undo: L("Answer the decision on «Back off webhook retries» again with 24 hours; the stage runs again.", "Дай іншу відповідь на рішення в «Затримка повторів вебхуків» — 24 години; етап запуститься знову."),
      },
      {
        id: "d2", at: isoAt(bootSeconds - HOUR - 40 * MIN), taskId: "t-receipts", by: seatActor,
        decision: L("Receipts go out as plain text with a one-line summary.", "Квитанції йдуть простим текстом з підсумком в один рядок."),
        why: L("The other order emails are plain text, so no template engine is added.", "Інші листи про замовлення — простий текст, тож рушій шаблонів не потрібен."),
        undo: L("Ask the orchestrator for the HTML variant on «Email a receipt for each refund».", "Попроси оркестратора про HTML-варіант у задачі «Квитанція на кожне повернення»."),
      },
      {
        id: "d3", at: isoAt(bootSeconds - 3 * HOUR - 5 * MIN), by: seatActor,
        decision: L("Refund calls keep the same 10 s provider timeout.", "Виклики повернень мають той самий тайм-аут провайдера 10 с."),
        why: L("They go through the same provider client; one limit is easier to reason about.", "Вони йдуть через того самого клієнта провайдера; одну межу простіше тримати в голові."),
        undo: L("Set a separate refunds timeout in the provider client and tell the orchestrator.", "Задай окремий тайм-аут повернень у клієнті провайдера і скажи оркестраторові."),
      },
    ],
  };
}

/* ── agent memory: the learned rules and their curator ────────────── */

/**
 * The example rules. Each is a new text written for strangers from a rule an
 * agent of that kind really carries: generic, with no person, account, path,
 * id or project name, and within the product's 300 and 160 character limits.
 */
export const EXAMPLE_RULES = {
  O1: {
    rule: ["Answer a quick question from data you already have in the same turn. Start a pipeline only for work that needs one.",
      "Швидке питання, на яке вже є дані, закривай тим самим ходом. Пайплайн запускай лише для роботи, якій він потрібен."],
    why: ["A pipeline for a one-line answer made the person wait for a free slot.",
      "Пайплайн заради відповіді в один рядок змусив людину чекати вільного місця."],
  },
  O2: {
    rule: ["Run a load test that needs the whole machine at a quiet hour, in small batches, and stop starting runs when asked.",
      "Навантажувальний тест, якому потрібна вся машина, запускай у тиху годину, малими партіями, і припиняй нові запуски на прохання."],
    why: ["While it ran, every other task's checks slowed down.",
      "Поки він ішов, перевірки всіх інших задач сповільнились."],
  },
  B1: {
    rule: ["Change only what was asked. Add no labels, notices or explanations nobody requested; fix the cause of a complaint instead of explaining it.",
      "Змінюй лише те, що просили. Не додавай написів, повідомлень чи пояснень, яких ніхто не просив; виправляй причину скарги, а не пояснюй її."],
    why: ["Extra text added to answer one complaint became the next complaint.",
      "Зайвий текст, доданий у відповідь на скаргу, став наступною скаргою."],
  },
  R1: {
    rule: ["To prove the output never contains something, make the test's fake input contain it and check what comes out. A fake that already behaves passes before the fix and proves nothing.",
      "Щоб довести, що у виході чогось ніколи немає, дай це в підробленому вході тесту й перевір, що вийде. Підробка, яка вже поводиться правильно, проходить і до виправлення та нічого не доводить."],
    why: ["A test written the easy way stayed green with the bug put back.",
      "Тест, написаний легким шляхом, лишався зеленим і з поверненою помилкою."],
  },
  A1: {
    rule: ["When a design turns a setting on by default, list the existing tests that now reach it and the state they share.",
      "Коли дизайн вмикає налаштування за замовчуванням, перелічи наявні тести, які тепер до нього доходять, і спільний стан між ними."],
    why: ["Tests that passed one by one failed together after a default changed.",
      "Тести, що проходили поодинці, впали разом після зміни типового значення."],
  },
  P1: {
    rule: ["A fresh checkout has no dependencies: install them from the lockfile before the first commit, and never skip the commit hook to get past an error.",
      "У свіжій копії репозиторію немає залежностей: встанови їх із lock-файлу перед першим комітом і ніколи не обходь хук коміту, щоб проскочити помилку."],
    why: ["The hook failed on a missing module, and skipping it let a lint error through.",
      "Хук упав через відсутній модуль, а його обхід пропустив помилку лінтера."],
  },
  M1: {
    rule: ["Delete only the temporary files your own script created and recorded. Never choose files to delete by a name pattern.",
      "Видаляй лише тимчасові файли, які створив і записав твій власний скрипт. Ніколи не обирай файли для видалення за шаблоном імені."],
    why: ["A pattern matched files another task was still using.",
      "Шаблон зачепив файли, якими ще користувалась інша задача."],
  },
  M2: {
    rule: ["When a test run stops at its time limit, run it again with a longer limit before reading the results as failures.",
      "Якщо прогін тестів зупинився на ліміті часу, перезапусти його з довшим лімітом, перш ніж вважати результати падінням."],
    why: ["Tests cut off by the limit looked like real failures.",
      "Тести, обірвані лімітом, виглядали як справжні падіння."],
  },
  /* The builder rule's text before the curator merged it with its twin. */
  B1earlier: {
    rule: ["Build only the change the task asks for, and add no notice that explains it.",
      "Роби лише ту зміну, про яку просить задача, і не додавай повідомлення, що її пояснює."],
    why: ["An explanation added to the page drew a complaint of its own.",
      "Пояснення, додане на сторінку, само викликало скаргу."],
  },
  /* An invented one-task rule the curator archived. */
  P0: {
    rule: ["Retry the March refunds export twice before reporting it.",
      "Повтори березневий експорт повернень двічі, перш ніж звітувати."],
    why: ["The export failed once and then worked.",
      "Експорт раз упав, а потім спрацював."],
  },
} as const;

export const RULE_IDS = { O1: "rule-o1", O2: "rule-o2", B1: "rule-b1", R1: "rule-r1", A1: "rule-a1", P1: "rule-p1", M1: "rule-m1", M2: "rule-m2", P0: "rule-p0" } as const;

/** The project's learned rules as `GET /api/role-memory` answers them. */
export function buildRoleMemory(lang: Lang, bootSeconds: number): RoleMemoryProjectView {
  const i = lang === "uk" ? 1 : 0;
  const ago = (seconds: number) => isoAt(bootSeconds - seconds);
  const curated = ago(2 * HOUR);
  const rule = (key: Exclude<keyof typeof EXAMPLE_RULES, "B1earlier">, roleId: string | null, over: Partial<RuleView> = {}): RuleView => ({
    id: RULE_IDS[key], rule: EXAMPLE_RULES[key].rule[i], why: EXAMPLE_RULES[key].why[i], state: "active", hints: [], tasks: 1,
    roleId, fixRound: false, stageId: roleId === "orchestrator" ? "seat" : "build", fresh: false,
    createdAt: ago(5 * 24 * HOUR), changedAt: curated, curatedAt: curated, awaitingCuration: false, ...over,
  });
  const scope = (id: string, kind: ScopeView["kind"], roleId: string | null, active: RuleView[], left: RuleView[] = []): ScopeView => ({
    scope: id, kind, roleId, revision: active.length + left.length + 1, bound: 10_000, addedToday: active.filter((entry) => entry.fresh).length,
    chars: active.reduce((sum, entry) => sum + entry.rule.length + entry.why.length, 0), active, left,
  });
  const curatorRevision = { by: "curator" as const, at: curated };
  return {
    project: PROJECT, enabled: true,
    scopes: [
      scope(`role:${PROJECT}:orchestrator`, "role", "orchestrator", [rule("O2", "orchestrator", { createdAt: ago(3 * 24 * HOUR) })]),
      scope("role:*:orchestrator", "role", "orchestrator", [rule("O1", "orchestrator", { tasks: 3 })]),
      scope("role:*:builder", "role", "builder", [rule("B1", "builder", {
        tasks: 4, revisedBy: curatorRevision, mergedFrom: ["rule-b1a", "rule-b1b"],
        versions: [{ id: "rule-b1-v1", rule: EXAMPLE_RULES.B1earlier.rule[i], why: EXAMPLE_RULES.B1earlier.why[i], hints: [], createdAt: ago(4 * 24 * HOUR) }],
      })]),
      scope("role:*:reviewer", "role", "reviewer", [rule("R1", "reviewer", { stageId: "review", fixRound: true, tasks: 2 })]),
      scope("role:*:architect", "role", "architect", [rule("A1", "architect", { stageId: "design", awaitingCuration: true, curatedAt: undefined, fresh: true, createdAt: ago(40 * MIN), changedAt: ago(40 * MIN) })]),
      scope(`project:${PROJECT}`, "project", null, [rule("P1", "builder", { tasks: 2 })],
        [rule("P0", "verifier", { state: "archived", reason: "task-specific", stageId: "verify", changedAt: curated })]),
      scope("machine", "machine", null, [rule("M1", "builder", { tasks: 2 }), rule("M2", "verifier", { stageId: "verify" })]),
    ],
    curation: { lastAt: curated, nextAt: isoAt(bootSeconds + 4 * HOUR), newLessons: 1, passes: curatorPasses(bootSeconds) },
  };
}

/** The curator's two latest passes: today's, and yesterday's, which was undone. */
export function curatorPasses(bootSeconds: number): CuratorPassView[] {
  return [
    { id: "pass-2", state: "succeeded", claimedAt: isoAt(bootSeconds - 2 * HOUR - 6 * MIN), endedAt: isoAt(bootSeconds - 2 * HOUR), failure: null,
      counts: { calls: 1, changed: 4, rewritten: 2, merged: 1, moved: 0, split: 0, archived: 1, restored: 0 } },
    { id: "pass-1", state: "succeeded", claimedAt: isoAt(bootSeconds - 26 * HOUR - 5 * MIN), endedAt: isoAt(bootSeconds - 26 * HOUR), failure: null,
      counts: { calls: 1, changed: 1, rewritten: 1, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 }, revertedAt: isoAt(bootSeconds - 25 * HOUR) },
  ];
}

/** The line under the refunds Review report: the reviewer left one rule. */
export function buildLessons(step: number, lang: Lang): StageLessonView[] {
  if (step < 4) return [];
  return [{ pipelineId: "p-refunds", stageId: "review", attempt: 1, none: null,
    rules: [{ id: RULE_IDS.R1, rule: EXAMPLE_RULES.R1.rule[lang === "uk" ? 1 : 0], scope: "role", roleId: "reviewer" }] }];
}

/** The window's Profile page: a finished summary in the frame's language. */
export function buildProfile(lang: Lang, bootSeconds: number, rules: RoleMemoryProjectView): MemoryProfileView {
  const L = (en: string, uk: string) => (lang === "uk" ? uk : en);
  const part = (scope: string, headline: string, text: string, topics: ProfilePartView["answer"]["topics"] = []): ProfilePartView => ({
    scope, model: "claude-opus-5-5", promptVersion: 1, createdAt: isoAt(bootSeconds - 2 * HOUR + 4 * MIN), durationMs: 41_000, stale: false, answer: { headline, text, topics },
  });
  const slice: Record<string, [string, string, string, string]> = {
    [`role:${PROJECT}:orchestrator`]: ["Heavy runs wait for a quiet hour", "Big load tests run in small batches when the machine is free.", "Важкі прогони чекають тихої години", "Великі навантажувальні тести йдуть малими партіями, коли машина вільна."],
    "role:*:orchestrator": ["Small questions get small answers", "A question the data already answers never waits for a pipeline.", "Малі питання — малі відповіді", "Питання, на яке вже є дані, не чекає на пайплайн."],
    "role:*:builder": ["Only what was asked", "Builders change what the task names and fix causes instead of explaining them.", "Лише те, що просили", "Білдери змінюють те, що названо в задачі, і виправляють причини, а не пояснюють їх."],
    "role:*:reviewer": ["Tests that can fail", "A reviewer checks that a test would turn red with the bug put back.", "Тести, які можуть впасти", "Рев’юер перевіряє, що тест почервоніє, якщо повернути помилку."],
    "role:*:architect": ["Defaults reach old tests", "A new default comes with the list of tests it now touches.", "Типові значення доходять до старих тестів", "Нове типове значення приходить зі списком тестів, яких воно тепер торкається."],
    [`project:${PROJECT}`]: ["Hooks stay on", "Dependencies come from the lockfile, and the commit hook is never skipped.", "Хуки лишаються ввімкненими", "Залежності беруться з lock-файлу, а хук коміту ніколи не обходять."],
    machine: ["Clean up only your own", "Delete what you created, and read a timed-out run as unfinished.", "Прибирай лише своє", "Видаляй те, що створив сам, а прогін, що вперся в ліміт, вважай незавершеним."],
  };
  const rule = (key: keyof typeof RULE_IDS) => RULE_IDS[key];
  return {
    project: PROJECT, locale: lang, enabled: true, model: "claude-opus-5-5", stale: false, changes: { added: 0, rewritten: 0, removed: 0 },
    ruleCount: rules.scopes.reduce((sum, scope) => sum + scope.active.length, 0),
    overall: part("overall",
      L("Prove it on the real path, change only what was asked, clean up only your own", "Доводь на справжньому шляху, змінюй лише те, що просили, прибирай лише своє"),
      L("What this project's agents have learned: prove claims with the real path, keep changes to what was asked, and clean up only what you created.",
        "Чого навчились агенти цього проєкту: доводити твердження справжнім шляхом, тримати зміни в межах прохання і прибирати лише те, що створили самі."),
      [
        { title: L("Proof", "Докази"), text: L("A test has to fail without the fix; a timed-out run is not a failure.", "Тест має падати без виправлення; прогін, що вперся в ліміт, — не падіння."), ruleIds: [rule("R1"), rule("A1"), rule("M2")] },
        { title: L("Scope", "Межі"), text: L("Change what was asked and answer small questions at once.", "Змінюй те, що просили, а на малі питання відповідай одразу."), ruleIds: [rule("B1"), rule("O1")] },
        { title: L("Shared machine", "Спільна машина"), text: L("Heavy runs wait, hooks stay on, and only your own files are deleted.", "Важкі прогони чекають, хуки працюють, а видаляються лише свої файли."), ruleIds: [rule("O2"), rule("P1"), rule("M1")] },
      ]),
    slices: rules.scopes.filter((scope) => scope.active.length).map((scope) => {
      const words = slice[scope.scope];
      return { scope: scope.scope, kind: scope.kind, roleId: scope.roleId, acrossProjects: scope.scope.startsWith("role:*:"), count: scope.active.length,
        summary: words ? part(scope.scope, L(words[0], words[2]), L(words[1], words[3])) : null };
    }),
    run: { state: "done", startedAt: isoAt(bootSeconds - 2 * HOUR + 3 * MIN), errors: [], durationMs: 41_000 },
  };
}

/* ── limits: what each task spent, and the account's history ─────── */

/** Each task's estimated share of the weekly limits, as `GET /api/task-spend`
    answers the owner: Claude first, then Codex. Account weeks match the
    accounts panel (Main 31% of its week, Work 12%, Codex Main 22%). */
export function buildTaskSpend(lang: Lang): Record<string, TaskSpendSummary> {
  const L = (en: string, uk: string) => (lang === "uk" ? uk : en);
  const WEEK = { claude: { main: 31, work: 12 }, codex: { main: 22 } } as const;
  const account = (engine: "claude" | "codex", id: "main" | "work", label: string, plan: string, pp: number, sessionPp: number | null = null) => ({
    key: `${engine}:${id}`, label, plan, weeklyPp: pp, tokens: Math.round(pp * 410_000),
    week: { usedPercent: engine === "claude" ? WEEK.claude[id] : WEEK.codex.main, taskPp: pp }, sessionPp,
  });
  const main = L("Main", "Основний");
  const claude = (pp: number, accounts = [account("claude", "main", main, "max", pp)]) =>
    ({ engine: "claude" as const, weeklyPp: pp, tokens: Math.round(pp * 410_000), bound: "approx" as const, floor: null, accounts });
  const codex = (pp: number) =>
    ({ engine: "codex" as const, weeklyPp: pp, tokens: Math.round(pp * 380_000), bound: "approx" as const, floor: null, accounts: [account("codex", "main", main, "pro", pp)] });
  const spend = (...providers: TaskSpendSummary["providers"]): TaskSpendSummary => ({ providers });
  return {
    "t-refunds": spend(claude(3.2, [account("claude", "main", main, "max", 2.1, 9), account("claude", "work", L("Work", "Робочий"), "max", 1.1)]), codex(1.4)),
    /* Two builds and a decision: the board's one in-progress card with two cells. */
    "t-retries": spend(claude(5.6), codex(0.6)),
    "t-keys": spend(claude(0.4)),
    "t-logs": spend(claude(0.8)),
    "t-receipts": spend(claude(1.2)),
    "t-postgres": spend(claude(6.3), codex(2.1)),
    "t-charges": spend(claude(1.9), codex(0.7)),
    "t-health": spend(claude(0.9)),
    "t-timeouts": spend(claude(1.1)),
    "t-grid": spend(claude(0.7)),
    "t-cart": spend(claude(0.5)),
    "t-drafts": spend(claude(0.6)),
    "t-import": spend(claude(0.3)),
  };
}

/** Remaining quota sampled through the current window: flat at night, faster
    in working hours, ending at what the footer reads now. */
function series(nowSeconds: number, resetsAt: number, windowSeconds: number, stepSeconds: number, endRemaining: number): BurndownSeries {
  const windowStart = resetsAt - windowSeconds;
  const times: number[] = [];
  for (let at = windowStart; at < nowSeconds; at += stepSeconds) times.push(at);
  times.push(nowSeconds);
  /* How hard the agents worked in each step: the hours between 08 and 20 UTC carry the work. */
  const weight = (at: number) => {
    const hour = new Date(at * 1000).getUTCHours();
    return hour >= 8 && hour < 20 ? 1 + 0.35 * Math.sin(at / 5400) : 0.12;
  };
  const weights = times.map((at, index) => (index === 0 ? 0 : weight(at)));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let spent = 0;
  const samples = times.map((t, index) => {
    spent += weights[index]!;
    return { t, remaining: Math.round((100 - (100 - endRemaining) * (spent / total)) * 10) / 10 };
  });
  return { windowStart, resetsAt, windowSeconds, samples };
}

/** `GET /api/limits/history`: the active account of each engine, its week and
    its five hours, at the readings `/api/limits` gives for them. */
export function buildLimitsHistory(nowSeconds: number): BurndownPayload {
  const WEEK = 7 * 24 * HOUR;
  const FIVE = 5 * HOUR;
  return {
    claudeAccountId: "main", codexAccountId: "main", historySince: isoAt(nowSeconds - 9 * 24 * HOUR),
    claude: { weekly: series(nowSeconds, nowSeconds + 3 * 24 * HOUR, WEEK, 30 * MIN, 69), session: series(nowSeconds, nowSeconds + 140 * MIN, FIVE, 5 * MIN, 58) },
    codex: { weekly: series(nowSeconds, nowSeconds + 3 * 24 * HOUR, WEEK, 30 * MIN, 78), session: series(nowSeconds, nowSeconds + 170 * MIN, FIVE, 5 * MIN, 65) },
  };
}
