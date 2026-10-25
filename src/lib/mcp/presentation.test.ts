import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { describe, expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n/core";

import { describeMcpCall, isViewerMcpServer } from "./presentation";

const uk: TFunction = (key, params) => translate("uk", key, params);

describe("describeMcpCall", () => {
  test("describes a spawned reviewer and links its durable conversation", () => {
    expect(describeMcpCall("spawn_agent", {
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      role: "reviewer",
      "prompt": "Review PR #431",
    }, {
      conversationId: "conversation_431",
      transcriptPath: "/sessions/reviewer.jsonl",
    })).toEqual({
      icon: "bot",
      verb: "Creating",
      title: "Creating agent: gpt-5.6-sol xhigh reviewer · Review PR #431",
      subtitle: "/sessions/reviewer.jsonl",
      links: [{
        kind: "conversation",
        id: "conversation_431",
        label: "Open agent",
        href: "#c=conversation_431",
      }],
    });
  });

  test("gives every v1 tool its own action sentence and icon", () => {
    const cases = [
      ["send_message", { conversationId: "conversation_a", text: "Ship the fix" }, "message", "Sending message"],
      ["create_task", withTaskDue({ project: "viewer", text: "Audit MCP cards" }), "task", "Creating task"],
      ["update_task", { taskId: "task-a", status: "done" }, "task", "Updating task"],
      ["create_pipeline", { task: "Ship MCP", repoDir: "/repo" }, "pipeline", "Creating pipeline"],
      ["pipeline_action", { pipelineId: "pipe-a", action: "resume" }, "pipeline", "Resuming pipeline"],
      ["link_task_to_pipeline", { taskId: "task-a", pipelineId: "pipe-a" }, "link", "Linking task to pipeline"],
      ["list_conversations", { project: "viewer" }, "conversation", "Listing conversations"],
      ["search_transcripts", { query: "report" }, "conversation", "Searching transcripts"],
      ["get_conversation", { conversationId: "conversation_a" }, "conversation", "Opening conversation"],
      ["conversation_messages", { conversationId: "conversation_a" }, "conversation", "Reading messages"],
      ["deploy_exact_sha", { revision: "abcdef1234567890", confirm: "deploy" }, "deploy", "Deploying release"],
      ["get_pipeline", { pipelineId: "pipe-a" }, "pipeline", "Opening pipeline"],
      ["board_snapshot", { project: "viewer" }, "conversation", "Reading board snapshot"],
      ["list_flows", { project: "viewer" }, "pipeline", "Listing flows"],
      ["get_flow", { flowId: "flow-a" }, "pipeline", "Opening flow"],
      ["flow_action", { flowId: "flow-a", action: "pause" }, "pipeline", "Pausing flow"],
      ["list_pipelines", { project: "viewer" }, "pipeline", "Listing pipelines"],
      ["conversation_action", { conversationId: "conversation_a", action: "interrupt" }, "message", "Interrupting conversation"],
      ["operator_snapshot", { scope: { kind: "focused" } }, "conversation", "Reading operator snapshot"],
      ["list_tasks", { project: "viewer" }, "task", "Listing tasks"],
      ["get_task", { taskId: "task-a" }, "task", "Opening task"],
      ["deployment_status", { deploymentId: "deployment-a" }, "deploy", "Reading deployment status"],
      ["resources", { fresh: true }, "tool", "Reading resources"],
      ["conversation_migration", { conversationId: "conversation_a", action: "rollback" }, "conversation", "Rolling back conversation migration"],
      ["agent_activity", { project: "viewer" }, "conversation", "Checking agent activity"],
      ["lifecycle_events", { pipelineId: "pipe-a" }, "pipeline", "Reading lifecycle events"],
      ["lifecycle_events", { mode: "digest", subscriberId: "conversation_a" }, "pipeline", "Polling lifecycle digest"],
      ["request_attention", { target: { kind: "conversation", path: "/tmp/a.jsonl" }, reason: "The reviewer finished." }, "conversation", "Asking to show a conversation"],
      ["request_attention", { target: { kind: "task", taskId: "task-a" }, intent: "open", reason: "This is blocked." }, "conversation", "Asking to open a task"],
      ["dismiss_attention", { target: { kind: "task", taskId: "task-a" } }, "task", "Clearing needs-you on a task"],
      ["dismiss_attention", { target: { kind: "pipeline", pipelineId: "pipe-a" }, undo: true }, "pipeline", "Flagging a pipeline again"],
    ] as const;

    for (const [tool, args, icon, prefix] of cases) {
      const description = describeMcpCall(tool, args);
      expect(description.icon).toBe(icon);
      expect(description.title.startsWith(prefix)).toBe(true);
      expect(description.verb.length).toBeGreaterThan(0);
      /* The Ukrainian interface gets its own sentence and verb, never the English one (#2250). */
      const localized = describeMcpCall(tool, args, undefined, uk);
      expect(localized.icon).toBe(icon);
      expect(localized.title.startsWith(prefix)).toBe(false);
      expect(localized.title).not.toMatch(/\b(Creating|Sending|Updating|Listing|Reading|Opening|Linking|Asking|Clearing|Flagging|Searching|Deploying|Checking|Polling|Interrupting|Resuming|Pausing|Rolling)\b/);
      expect(localized.verb).not.toBe(description.verb);
      expect(localized.links).toEqual(description.links);
    }
  });

  test("writes the issue's rows in Ukrainian, ids and the operator's own text kept as written", () => {
    expect(describeMcpCall("create_task", { project: "viewer", text: "Audit MCP cards" }, { taskId: "task-431" }, uk)).toMatchObject({
      verb: "Створення",
      title: "Створення задачі: Audit MCP cards",
    });
    expect(describeMcpCall("link_task_to_pipeline", { taskId: "task-a", pipelineId: "pipe-a" }, undefined, uk).title).toBe("Прив’язка задачі до пайплайна: task-a → pipe-a");
    expect(describeMcpCall("link_task_to_pipeline", {}, undefined, uk).title).toBe("Прив’язка задачі до пайплайна: задача → пайплайн");
    expect(describeMcpCall("list_pipelines", {}, undefined, uk)).toMatchObject({ verb: "Список", title: "Список пайплайнів" });
    expect(describeMcpCall("list_pipelines", { project: "viewer" }, undefined, uk).title).toBe("Список пайплайнів: viewer");
    expect(describeMcpCall("pipeline_action", { pipelineId: "pipe-a", action: "resume" }, undefined, uk).title).toBe("Відновлення пайплайна pipe-a");
    expect(describeMcpCall("update_task", { taskId: "task-a", status: "done" }, undefined, uk).title).toBe("Оновлення задачі task-a: готово");
    expect(describeMcpCall("request_attention", { target: { kind: "task", taskId: "task-a" }, intent: "open" }, undefined, uk).title).toBe("Прохання відкрити: задача");
    expect(describeMcpCall("seat_tick_settings", { project: "viewer", wakeIntervalMinutes: 15 }, { changed: true }, uk).title).toBe("Налаштування тікера для viewer: одне пробудження на 15 хв");
    expect(describeMcpCall("conversation_migration", { conversationId: "conversation_a", action: "rollback" }, undefined, uk).title).toBe("Відкат міграції розмови для conversation_a");
    expect(describeMcpCall("future_tool", {}, undefined, uk)).toEqual({
      icon: "tool",
      verb: "Виконання",
      title: "Виконання інструмента MCP: future_tool",
      subtitle: "",
      links: [],
    });
  });

  test("an action named after an inherited property reads as the fallback in every action table (#2250)", () => {
    const tables: Array<[string, Record<string, string>, { verb: string; title: string }, { verb: string; title: string }, [string, string, string]]> = [
      ["pipeline_action", { pipelineId: "pipe-a" }, { verb: "Updating", title: "Updating pipeline pipe-a" }, { verb: "Оновлення", title: "Оновлення пайплайна pipe-a" }, ["resume", "Resuming pipeline pipe-a", "Відновлення пайплайна pipe-a"]],
      ["flow_action", { flowId: "flow-a" }, { verb: "Updating", title: "Updating flow flow-a" }, { verb: "Оновлення", title: "Оновлення флоу flow-a" }, ["pause", "Pausing flow flow-a", "Пауза флоу flow-a"]],
      ["conversation_action", { conversationId: "conversation_a" }, { verb: "Controlling", title: "Controlling conversation conversation_a" }, { verb: "Керування", title: "Керування розмовою conversation_a" }, ["kill", "Killing conversation conversation_a", "Примусова зупинка розмови conversation_a"]],
      ["conversation_migration", { conversationId: "conversation_a" }, { verb: "Migrating", title: "Migrating conversation migration for conversation_a" }, { verb: "Міграція", title: "Міграція розмови для conversation_a" }, ["rollback", "Rolling back conversation migration for conversation_a", "Відкат міграції розмови для conversation_a"]],
    ];
    for (const [tool, args, english, ukrainian, [known, knownEnglish, knownUkrainian]] of tables) {
      expect(describeMcpCall(tool, { ...args, action: known }).title).toBe(knownEnglish);
      expect(describeMcpCall(tool, { ...args, action: known }, undefined, uk).title).toBe(knownUkrainian);
      for (const action of ["frobnicate", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
        expect(describeMcpCall(tool, { ...args, action })).toMatchObject(english);
        expect(describeMcpCall(tool, { ...args, action }, undefined, uk)).toMatchObject(ukrainian);
      }
    }
  });

  test("a target kind or task status named after an inherited property is drawn as written (#2250)", () => {
    /* Known values translate; unknown and inherited names stay readable. */
    const kinds: Array<[string, string, string, string, string]> = [
      ["task", "Asking to show a task", "Прохання показати: задача", "Clearing needs-you on a task", "Зняття позначки «Потрібні ви»: задача"],
      ["frobnicate", "Asking to show a frobnicate", "Прохання показати: frobnicate", "Clearing needs-you on a frobnicate", "Зняття позначки «Потрібні ви»: frobnicate"],
    ];
    for (const kind of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      kinds.push([kind, `Asking to show a ${kind}`, `Прохання показати: ${kind}`, `Clearing needs-you on a ${kind}`, `Зняття позначки «Потрібні ви»: ${kind}`]);
    }
    for (const [kind, askEnglish, askUkrainian, clearEnglish, clearUkrainian] of kinds) {
      const target = { kind };
      expect(describeMcpCall("request_attention", { target }).title).toBe(askEnglish);
      expect(describeMcpCall("request_attention", { target }, undefined, uk).title).toBe(askUkrainian);
      expect(describeMcpCall("dismiss_attention", { target }).title).toBe(clearEnglish);
      expect(describeMcpCall("dismiss_attention", { target }, undefined, uk).title).toBe(clearUkrainian);
    }
    const statuses: Array<[string, string, string]> = [
      ["done", "Updating task task-a: done", "Оновлення задачі task-a: готово"],
      ["parked", "Updating task task-a: parked", "Оновлення задачі task-a: parked"],
    ];
    for (const status of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      statuses.push([status, `Updating task task-a: ${status}`, `Оновлення задачі task-a: ${status}`]);
    }
    for (const [status, english, ukrainian] of statuses) {
      expect(describeMcpCall("update_task", { taskId: "task-a", status }).title).toBe(english);
      expect(describeMcpCall("update_task", { taskId: "task-a", status }, undefined, uk).title).toBe(ukrainian);
    }
  });

  test("a delivery check leads with its state and keeps the operation id in the tooltip (#2250)", () => {
    const cases: Array<[string | undefined, string, string, string, string]> = [
      ["delivered", "Delivered · delivery check", "Доставлено · перевірка доставки", "Checking delivery of op-1: delivered", "Перевірка доставки op-1: доставлено"],
      ["failed", "Failed · delivery check", "Не доставлено · перевірка доставки", "Checking delivery of op-1: failed", "Перевірка доставки op-1: не доставлено"],
      ["in-flight", "In-flight · delivery check", "Доставляється · перевірка доставки", "Checking delivery of op-1: in-flight", "Перевірка доставки op-1: доставляється"],
      [undefined, "Unknown · delivery check", "Невідомо · перевірка доставки", "Checking delivery of op-1: unknown", "Перевірка доставки op-1: невідомо"],
      /* A state the server does not name yet, or one shaped like an inherited
         property, is drawn as written. */
      ["parked", "parked · delivery check", "parked · перевірка доставки", "Checking delivery of op-1: parked", "Перевірка доставки op-1: parked"],
      ["toString", "toString · delivery check", "toString · перевірка доставки", "Checking delivery of op-1: toString", "Перевірка доставки op-1: toString"],
    ];
    for (const [state, english, ukrainian, englishTip, ukrainianTip] of cases) {
      const result = state === undefined ? {} : { state };
      const en = describeMcpCall("message_receipt", { operationId: "op-1" }, result);
      const ua = describeMcpCall("message_receipt", { operationId: "op-1" }, result, uk);
      expect([en.title, ua.title]).toEqual([english, ukrainian]);
      expect([en.tooltip, ua.tooltip]).toEqual([englishTip, ukrainianTip]);
      expect(en.title).not.toContain("op-1");
      expect(ua.title).not.toContain("op-1");
    }
  });

  test("unknown tools use a stable generic fallback", () => {
    expect(describeMcpCall("future_tool", { payload: "x" })).toEqual({
      icon: "tool",
      verb: "Running",
      title: "Running MCP tool: future_tool",
      subtitle: "",
      links: [],
    });
  });
});

/* Delegatus rename (docs/design/rename-delegatus.md §6.4): the key stays
   `viewer`, and a server registered under either product name still renders
   as this server's calls. */
test("the Viewer MCP server is recognized under viewer, agent-log-viewer and delegatus keys", () => {
  for (const name of ["viewer", "viewer-dev", "agent-log-viewer", "agent-log-viewer-dev", "delegatus", "delegatus-dev"]) {
    expect(isViewerMcpServer(name)).toBe(true);
  }
  for (const name of ["delegatusx", "telegram", "viewerish"]) {
    expect(isViewerMcpServer(name)).toBe(false);
  }
});
