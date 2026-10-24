import { translate, type MessageKey, type TFunction } from "@/lib/i18n/core";

export type McpCallIcon =
  | "bot"
  | "message"
  | "task"
  | "pipeline"
  | "link"
  | "conversation"
  | "deploy"
  | "tool";

export type McpCallLink = {
  kind: "conversation" | "pipeline" | "task";
  id: string;
  label: string;
  href: string;
};

/* The chip labels `describeMcpCall` writes, and the message each one reads as
   in the operator's language. A label outside this map is drawn as written. */
const LINK_LABEL_KEYS: Record<string, "mcp.link.task" | "mcp.link.pipeline" | "mcp.link.conversation" | "mcp.link.agent"> = {
  "Open task": "mcp.link.task",
  "Open pipeline": "mcp.link.pipeline",
  "Open conversation": "mcp.link.conversation",
  "Open agent": "mcp.link.agent",
};

/** An entity chip's label in the interface language. */
export function mcpLinkLabel(t: (key: (typeof LINK_LABEL_KEYS)[string]) => string, link: McpCallLink): string {
  const key = Object.hasOwn(LINK_LABEL_KEYS, link.label) ? LINK_LABEL_KEYS[link.label] : undefined;
  return key ? t(key) : link.label;
}

export type McpCallDescription = {
  icon: McpCallIcon;
  verb: string;
  title: string;
  subtitle: string;
  links: McpCallLink[];
};

export function isViewerMcpServer(serverName: string): boolean {
  return serverName === "viewer"
    || serverName.startsWith("viewer-")
    || serverName.startsWith("viewer_")
    || serverName === "agent-log-viewer"
    || serverName.startsWith("agent-log-viewer-")
    || serverName === "delegatus"
    || serverName.startsWith("delegatus-");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/* An action's verb and title keys. The action comes from the call's own
   arguments, so a name like `toString` or `__proto__` must miss the table and
   read as the fallback instead of an inherited property. */
function actionKeys(actions: Record<string, [MessageKey, MessageKey]>, action: string, fallback: [MessageKey, MessageKey]): [MessageKey, MessageKey] {
  return Object.hasOwn(actions, action) ? actions[action] : fallback;
}

/* The receipt states `message_receipt` answers, read in the interface
   language; a state outside them is drawn as written. */
const RECEIPT_STATE_KEYS: Record<string, MessageKey> = {
  delivered: "mcp.call.receiptState.delivered",
  failed: "mcp.call.receiptState.failed",
  "in-flight": "mcp.call.receiptState.inFlight",
};

function compact(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function conversationLink(result: Record<string, unknown>): McpCallLink[] {
  const id = string(result.conversationId);
  return id ? [{ kind: "conversation", id, label: "Open agent", href: `#c=${encodeURIComponent(id)}` }] : [];
}

function entityId(result: Record<string, unknown>, key: "task" | "pipeline"): string {
  return string(result[`${key}Id`]) || string(record(result[key]).id);
}

function entityLink(kind: "task" | "pipeline", id: string): McpCallLink[] {
  if (!id) return [];
  const label = kind === "task" ? "Open task" : "Open pipeline";
  return [{ kind, id, label, href: `#${kind}=${encodeURIComponent(id)}` }];
}

/* Titles and verbs are written in the language `t` reads (#2250). Callers that
   are not drawing a row (the deputy note's links) keep the English default. */
const english: TFunction = (key, params) => translate("en", key, params);

/* What a request or a needs-you flag is about, named in the interface language;
   a kind this build does not know is shown as written. */
const KIND_KEYS: Record<string, MessageKey> = {
  conversation: "mcp.call.kind.conversation",
  task: "mcp.call.kind.task",
  pipeline: "mcp.call.kind.pipeline",
  target: "mcp.call.kind.target",
};

const TASK_STATUS_KEYS: Record<string, MessageKey> = {
  inbox: "tasks.status.inbox",
  assigned: "tasks.status.assigned",
  blocked: "tasks.status.blocked",
  done: "tasks.status.done",
};

function replaySubtitle(result: Record<string, unknown>, detail: string): string {
  const replay = result.replay === true || result.replayed === true;
  return [replay ? "Replay" : "", detail].filter(Boolean).join(" · ");
}

export function describeMcpCall(
  toolName: string,
  argsValue: unknown,
  resultValue?: unknown,
  t: TFunction = english,
): McpCallDescription {
  const args = record(argsValue);
  const result = record(resultValue);
  /* An optional `: <scope>` after a title, the same in both languages. */
  const scoped = (value: string) => (value ? `: ${value}` : "");
  const kindName = (kind: string) => (KIND_KEYS[kind] ? t(KIND_KEYS[kind]) : kind);

  if (toolName === "spawn_agent") {
    const profile = [string(args.model) || string(args.engine), string(args.effort), string(args.role)]
      .filter(Boolean)
      .join(" ");
    const prompt = compact(string(args.prompt));
    const subject = [profile, prompt].filter(Boolean).join(" · ") || t("mcp.call.newWorker");
    return {
      icon: "bot",
      verb: t("mcp.verb.creating"),
      title: t("mcp.call.spawnAgent", { subject }),
      subtitle: string(result.transcriptPath),
      links: conversationLink(result),
    };
  }

  if (toolName === "send_message") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    return {
      icon: "message",
      verb: t("mcp.verb.sending"),
      title: conversationId
        ? t("mcp.call.sendMessageTo", { conversation: conversationId, text: compact(string(args.text)) || t("mcp.call.messageFallback") })
        : t("mcp.call.sendMessage", { text: compact(string(args.text)) || t("mcp.call.messageFallback") }),
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "message_receipt") {
    const operationId = string(result.operationId) || string(args.operationId);
    const rawState = string(result.state);
    const state = !rawState
      ? t("mcp.call.unknownState")
      : Object.hasOwn(RECEIPT_STATE_KEYS, rawState) ? t(RECEIPT_STATE_KEYS[rawState]) : rawState;
    const conversationId = string(result.conversationId);
    return {
      icon: "message",
      verb: t("mcp.verb.checking"),
      title: t("mcp.call.messageReceipt", { operation: operationId || t("mcp.call.aSend"), state }),
      subtitle: string(result.reason),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "create_task") {
    const id = entityId(result, "task");
    return {
      icon: "task",
      verb: t("mcp.verb.creating"),
      title: t("mcp.call.createTask", { text: compact(string(args.text)) || t("mcp.call.untitledTask") }),
      subtitle: replaySubtitle(result, string(args.project)),
      links: entityLink("task", id),
    };
  }

  if (toolName === "update_task") {
    const id = entityId(result, "task") || string(args.taskId);
    const status = string(args.status);
    const change = (TASK_STATUS_KEYS[status] ? t(TASK_STATUS_KEYS[status]) : status) || compact(string(args.text)) || t("mcp.call.taskDetails");
    return {
      icon: "task",
      verb: t("mcp.verb.updating"),
      title: id ? t("mcp.call.updateTaskId", { id, change }) : t("mcp.call.updateTask", { change }),
      subtitle: replaySubtitle(result, ""),
      links: entityLink("task", id),
    };
  }

  if (toolName === "create_pipeline") {
    const id = entityId(result, "pipeline");
    return {
      icon: "pipeline",
      verb: t("mcp.verb.creating"),
      title: t("mcp.call.createPipeline", { task: compact(string(args.task)) || t("mcp.call.untitledPipeline") }),
      subtitle: replaySubtitle(result, string(args.repoDir)),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "pipeline_action") {
    const id = entityId(result, "pipeline") || string(args.pipelineId);
    const action = string(args.action) || "update";
    const actions: Record<string, [MessageKey, MessageKey]> = {
      start: ["mcp.verb.starting", "mcp.call.pipeline.start"],
      pause: ["mcp.verb.pausing", "mcp.call.pipeline.pause"],
      resume: ["mcp.verb.resuming", "mcp.call.pipeline.resume"],
      "retry-stage": ["mcp.verb.retrying", "mcp.call.pipeline.retryStage"],
      "skip-stage": ["mcp.verb.skippingStage", "mcp.call.pipeline.skipStage"],
      close: ["mcp.verb.closing", "mcp.call.pipeline.close"],
      delete: ["mcp.verb.deleting", "mcp.call.pipeline.delete"],
    };
    const [verbKey, titleKey] = actionKeys(actions, action, ["mcp.verb.updating", "mcp.call.pipeline.update"]);
    return {
      icon: "pipeline",
      verb: t(verbKey),
      title: t(titleKey, { target: id ? ` ${id}` : "" }),
      subtitle: replaySubtitle(result, action),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "link_task_to_pipeline") {
    const taskId = string(result.taskId) || string(args.taskId);
    const pipelineId = string(result.pipelineId) || string(args.pipelineId);
    return {
      icon: "link",
      verb: t("mcp.verb.linking"),
      title: t("mcp.call.linkTask", { task: taskId || t("mcp.call.kind.task"), pipeline: pipelineId || t("mcp.call.kind.pipeline") }),
      subtitle: replaySubtitle(result, ""),
      links: [...entityLink("task", taskId), ...entityLink("pipeline", pipelineId)],
    };
  }

  if (toolName === "list_conversations") {
    const scope = string(args.project) || string(args.query);
    return {
      icon: "conversation",
      verb: t("mcp.verb.listing"),
      title: t("mcp.call.listConversations", { scope: scoped(scope ? compact(scope) : "") }),
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "search_transcripts") {
    const query = compact(string(args.query));
    const total = typeof result.total === "number" ? `${result.total} ${result.order === "relevance" ? "conversations" : "matches"}` : "";
    return {
      icon: "conversation",
      verb: t("mcp.verb.searching"),
      title: t("mcp.call.searchTranscripts", { scope: scoped(query) }),
      subtitle: replaySubtitle(result, total),
      links: [],
    };
  }

  if (toolName === "get_conversation") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const transcriptPath = string(result.transcriptPath) || string(args.transcriptPath);
    const links = conversationId
      ? [{ kind: "conversation" as const, id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
      : [];
    return {
      icon: "conversation",
      verb: t("mcp.verb.opening"),
      title: t("mcp.call.getConversation", { target: conversationId || transcriptPath || t("mcp.call.kind.conversation") }),
      subtitle: replaySubtitle(result, transcriptPath),
      links,
    };
  }

  if (toolName === "conversation_messages") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const transcriptPath = string(result.transcriptPath) || string(args.transcriptPath);
    const links = conversationId
      ? [{ kind: "conversation" as const, id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
      : [];
    return {
      icon: "conversation",
      verb: t("mcp.verb.reading"),
      title: t("mcp.call.conversationMessages", { target: conversationId || transcriptPath || t("mcp.call.kind.conversation") }),
      subtitle: replaySubtitle(result, transcriptPath),
      links,
    };
  }

  if (toolName === "deploy_exact_sha") {
    /* #795: the exact revision is machine evidence; the operator-facing card
       names the release by its short form and leaves the full SHA to the
       deployment ledger. */
    const revision = string(result.revision) || string(args.revision);
    return {
      icon: "deploy",
      verb: t("mcp.verb.deploying"),
      title: t("mcp.call.deploy", { revision: revision ? revision.slice(0, 12) : t("mcp.call.currentHead") }),
      subtitle: replaySubtitle(result, string(result.deploymentId)),
      links: [],
    };
  }

  if (toolName === "get_pipeline") {
    const id = entityId(result, "pipeline") || string(args.pipelineId);
    return {
      icon: "pipeline",
      verb: t("mcp.verb.opening"),
      title: t("mcp.call.getPipeline", { id: id || t("mcp.call.kind.pipeline") }),
      subtitle: replaySubtitle(result, string(record(result.pipeline).state)),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "board_snapshot") {
    return {
      icon: "conversation",
      verb: t("mcp.verb.reading"),
      title: t("mcp.call.boardSnapshot", { scope: scoped(compact(string(args.project))) }),
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} conversations` : ""),
      links: [],
    };
  }

  if (toolName === "list_flows") {
    return {
      icon: "pipeline",
      verb: t("mcp.verb.listing"),
      title: t("mcp.call.listFlows", { scope: scoped(compact(string(args.project))) }),
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "get_flow") {
    const id = string(args.flowId) || string(result.flowId);
    return {
      icon: "pipeline",
      verb: t("mcp.verb.opening"),
      title: t("mcp.call.getFlow", { id: id || t("mcp.call.flowFallback") }),
      subtitle: replaySubtitle(result, string(record(result.flow).state)),
      links: [],
    };
  }

  if (toolName === "flow_action") {
    const id = string(args.flowId) || string(result.flowId);
    const action = string(args.action);
    const actions: Record<string, [MessageKey, MessageKey]> = {
      pause: ["mcp.verb.pausing", "mcp.call.flow.pause"],
      resume: ["mcp.verb.resuming", "mcp.call.flow.resume"],
      advance: ["mcp.verb.advancing", "mcp.call.flow.advance"],
      "retry-round": ["mcp.verb.retrying", "mcp.call.flow.retryRound"],
      "cancel-round": ["mcp.verb.cancellingRound", "mcp.call.flow.cancelRound"],
      extend: ["mcp.verb.extending", "mcp.call.flow.extend"],
      "another-round": ["mcp.verb.startingRound", "mcp.call.flow.anotherRound"],
      close: ["mcp.verb.closing", "mcp.call.flow.close"],
    };
    const [verbKey, titleKey] = actionKeys(actions, action, ["mcp.verb.updating", "mcp.call.flow.update"]);
    return {
      icon: "pipeline",
      verb: t(verbKey),
      title: t(titleKey, { target: id ? ` ${id}` : "" }),
      subtitle: replaySubtitle(result, action),
      links: [],
    };
  }

  if (toolName === "list_pipelines") {
    return {
      icon: "pipeline",
      verb: t("mcp.verb.listing"),
      title: t("mcp.call.listPipelines", { scope: scoped(compact(string(args.project))) }),
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "conversation_action") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const action = string(args.action);
    const actions: Record<string, [MessageKey, MessageKey]> = {
      interrupt: ["mcp.verb.interrupting", "mcp.call.conversation.interrupt"],
      kill: ["mcp.verb.killing", "mcp.call.conversation.kill"],
      resume: ["mcp.verb.resuming", "mcp.call.conversation.resume"],
      compact: ["mcp.verb.compacting", "mcp.call.conversation.compact"],
      "dialog-key": ["mcp.verb.answeringDialog", "mcp.call.conversation.dialogKey"],
      permission: ["mcp.verb.answeringPermission", "mcp.call.conversation.permission"],
      archive: ["mcp.verb.archiving", "mcp.call.conversation.archive"],
      unarchive: ["mcp.verb.unarchiving", "mcp.call.conversation.unarchive"],
    };
    const [verbKey, titleKey] = actionKeys(actions, action, ["mcp.verb.controlling", "mcp.call.conversation.control"]);
    return {
      icon: "message",
      verb: t(verbKey),
      title: t(titleKey, { target: conversationId ? ` ${conversationId}` : "" }),
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "operator_snapshot") {
    return {
      icon: "conversation",
      verb: t("mcp.verb.reading"),
      title: t("mcp.call.operatorSnapshot"),
      subtitle: replaySubtitle(result, string(record(result.view).mode)),
      links: [],
    };
  }

  if (toolName === "list_tasks") {
    return {
      icon: "task",
      verb: t("mcp.verb.listing"),
      title: t("mcp.call.listTasks", { scope: scoped(compact(string(args.project))) }),
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "get_task") {
    const id = entityId(result, "task") || string(args.taskId);
    return {
      icon: "task",
      verb: t("mcp.verb.opening"),
      title: t("mcp.call.getTask", { id: id || t("mcp.call.kind.task") }),
      subtitle: replaySubtitle(result, string(record(result.task).status)),
      links: entityLink("task", id),
    };
  }

  if (toolName === "deployment_status") {
    const id = string(args.deploymentId) || string(result.deploymentId) || string(args.operationId) || string(result.operationId);
    return {
      icon: "deploy",
      verb: t("mcp.verb.reading"),
      title: t("mcp.call.deploymentStatus", { scope: scoped(id) }),
      subtitle: replaySubtitle(result, string(record(result.deployment).state) || string(record(record(result.operation).receipt).status)),
      links: [],
    };
  }

  if (toolName === "resources") {
    return {
      icon: "tool",
      verb: t("mcp.verb.reading"),
      title: t("mcp.call.resources"),
      subtitle: replaySubtitle(result, Array.isArray(result.sessions) ? `${result.sessions.length} sessions` : ""),
      links: [],
    };
  }

  if (toolName === "conversation_migration") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const action = string(args.action);
    const actions: Record<string, [MessageKey, MessageKey]> = {
      reseat: ["mcp.verb.reseating", "mcp.call.migration.reseat"],
      retry: ["mcp.verb.retrying", "mcp.call.migration.retry"],
      rollback: ["mcp.verb.rollingBack", "mcp.call.migration.rollback"],
      cancel: ["mcp.verb.cancelling", "mcp.call.migration.cancel"],
      withdraw: ["mcp.verb.withdrawing", "mcp.call.migration.withdraw"],
      "keep-current": ["mcp.verb.releasingHeld", "mcp.call.migration.keepCurrent"],
    };
    const [verbKey, titleKey] = actionKeys(actions, action, ["mcp.verb.migrating", "mcp.call.migration.migrate"]);
    return {
      icon: "conversation",
      verb: t(verbKey),
      title: t(titleKey, { target: conversationId ? ` ${t("mcp.call.migrationFor", { id: conversationId })}` : "" }),
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "agent_activity") {
    const scope = string(args.conversationId) || string(args.project) || t("mcp.call.allLiveAgents");
    const stalled = typeof result.stalledCount === "number" ? result.stalledCount : null;
    const counted = typeof result.count === "number" ? `${result.count} checked` : "";
    return {
      icon: "conversation",
      verb: t("mcp.verb.checking"),
      title: t("mcp.call.agentActivity", { scope: compact(scope) }),
      subtitle: replaySubtitle(result, [counted, stalled ? `${stalled} stalled` : ""].filter(Boolean).join(" · ")),
      links: conversationLink(args),
    };
  }

  if (toolName === "lifecycle_events") {
    const digest = string(args.mode) === "digest";
    const relay = record(result.relay);
    const items = Array.isArray(relay.items) ? relay.items.length : 0;
    const scope = string(args.pipelineId) || string(args.conversationId) || string(args.project);
    const detail = digest
      ? (result.relay ? `${string(relay.reason)} relay · ${items} change(s)` : "nothing due")
      : (typeof result.count === "number" ? `${result.count} event(s)` : "");
    return {
      icon: "pipeline",
      verb: t(digest ? "mcp.verb.polling" : "mcp.verb.reading"),
      title: t(digest ? "mcp.call.lifecycleDigest" : "mcp.call.lifecycleEvents", { scope: scoped(scope ? compact(scope) : "") }),
      subtitle: replaySubtitle(result, detail),
      links: entityLink("pipeline", string(args.pipelineId)),
    };
  }

  if (toolName === "request_attention") {
    /* The operator reads this line about a request made ABOUT them, so it says
       what was asked and which of show/open it was — the same two facts the
       card itself puts in front of them before they agree. */
    const target = record(args.target);
    const kind = string(target.kind) || "target";
    const opening = string(args.intent) === "open";
    return {
      icon: "conversation",
      verb: t("mcp.verb.asking"),
      title: t(opening ? "mcp.call.askOpen" : "mcp.call.askShow", { kind: kindName(kind) }),
      subtitle: replaySubtitle(result, compact(string(args.reason))),
      links: kind === "conversation" && string(target.path)
        ? []
        : entityLink(kind === "task" ? "task" : "pipeline", string(target.taskId) || string(target.pipelineId)),
    };
  }

  if (toolName === "dismiss_attention") {
    if (args.target === undefined) return { icon: "task", verb: t("mcp.verb.reading"), title: t("mcp.call.waitingForYou"), subtitle: replaySubtitle(result, `${typeof result.count === "number" ? result.count : 0} rows · ${typeof result.staleCount === "number" ? result.staleCount : 0} with stale evidence`), links: [] };
    /* A needs-you flag cleared off the operator's board, or brought back: what
       kind of thing, and whether anything actually moved. */
    const target = record(args.target);
    const kind = string(target.kind) || "target";
    const undo = args.undo === true;
    const cleared = Array.isArray(result.dismissed) ? result.dismissed.length : 0;
    /* A seat handing a wait routed to it to the operator's decision form. */
    if (args.escalate !== undefined) {
      return {
        icon: kind === "conversation" ? "conversation" : "pipeline",
        verb: t(undo ? "mcp.verb.withdrawing" : "mcp.verb.escalating"),
        title: t(undo ? "mcp.call.takeBackEscalation" : "mcp.call.escalate", { kind: kindName(kind) }),
        subtitle: replaySubtitle(result, undo ? "" : compact(string(record(args.escalate).reviewId))),
        links: kind === "conversation" ? conversationLink({ conversationId: string(target.conversationId) }) : entityLink("pipeline", string(target.pipelineId)),
      };
    }
    return {
      icon: kind === "conversation" ? "conversation" : kind === "task" ? "task" : "pipeline",
      verb: t(undo ? "mcp.verb.flagging" : "mcp.verb.clearing"),
      title: t(undo ? "mcp.call.flagAgain" : "mcp.call.clearNeedsYou", { kind: kindName(kind) }),
      subtitle: replaySubtitle(result, Array.isArray(result.dismissed) && !cleared ? "already clear" : ""),
      links: kind === "conversation"
        ? conversationLink({ conversationId: string(target.conversationId) })
        : entityLink(kind === "task" ? "task" : "pipeline", string(target.taskId) || string(target.pipelineId)),
    };
  }

  if (toolName === "seat_tick_settings") {
    /* The operator's own line for a change to how often a project is woken —
       so a tick that goes quiet is legible here as well as on the board. */
    const project = string(result.project) || string(args.project);
    const changed = result.changed === true;
    const off = args.enabled === false;
    const minutes = typeof args.wakeIntervalMinutes === "number" ? args.wakeIntervalMinutes : null;
    const target = project ? ` ${t("mcp.call.tickFor", { project: compact(project) })}` : "";
    return {
      icon: "tool",
      verb: t(changed ? "mcp.verb.setting" : "mcp.verb.reading"),
      title: !changed
        ? t("mcp.call.tickRead", { scope: scoped(project ? compact(project) : "") })
        : off
          ? t("mcp.call.tickOff", { target })
          : minutes !== null
            ? t("mcp.call.tickEvery", { target, minutes })
            : t("mcp.call.tickSet", { target }),
      subtitle: replaySubtitle(result, compact(string(args.reason))),
      links: [],
    };
  }

  return {
    icon: "tool",
    verb: t("mcp.verb.running"),
    title: t("mcp.call.runningTool", { tool: toolName || t("mcp.call.unknownTool") }),
    subtitle: "",
    links: [],
  };
}
