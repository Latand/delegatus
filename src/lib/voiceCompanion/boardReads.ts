import { hardenedRedact } from "@/lib/view/compactText";
import { canonicalProject } from "@/lib/projects/aliases";
import { withoutLocalPaths } from "./redaction";

export const READ_TOOL_NAMES = ["list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages"] as const;
export type ReadToolName = typeof READ_TOOL_NAMES[number];
interface TaskRead { id: string; project: string; text: string; status: string; note?: { text: string }; hold?: { note: string }; steps?: Array<{ text: string; state: string }> }
interface PipelineRead { id: string; project: string; task: string; state: string; stages: Array<{ id: string; kind: string }>; runs: Array<{ stageId: string; attempts: Array<{ state: string; verdict?: string | null; historical?: boolean }> }> }
export interface ActivityRead { conversationId: string; project: string; title?: string | null; lifecycle: string }
export interface BoardReadPaths {
  tasks(): readonly TaskRead[];
  pipelines(): readonly PipelineRead[];
  activity(project: string): Promise<ActivityRead[]>;
  messages(conversationId: string): Promise<Array<{ role: string; text: string }>>;
}
export interface SpeechReadResult { speech: string; total?: number; rows?: unknown[]; item?: unknown; truncated: boolean }
/** The one projection of every read field. Length is cut last, so a path or
 * a credential is never left half inside the limit. */
const short = (value: string | null | undefined, limit = 160) => withoutLocalPaths(hardenedRedact(value ?? "").replace(/<!--[^]*?-->/g, ""))
  .replace(/\b(?:conversation_|task_|pipeline_)[A-Za-z0-9_-]+\b/g, "[reference]")
  .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[reference]").slice(0, limit);
const handle = (id: string) => id.length <= 128 ? id : undefined;
const taskRow = (row: TaskRead) => ({ handle: handle(row.id), title: short(row.text.split("\n")[0]), state: short(row.status, 32) });
const pipelineRow = (row: PipelineRead) => ({ handle: handle(row.id), title: short(row.task), state: short(row.state, 32),
  stages: row.stages.slice(0, 12).map((stage, index) => {
    const attempt = row.runs.find(run => run.stageId === stage.id)?.attempts.findLast(attempt => !attempt.historical);
    return { title: `Stage ${index + 1}`, kind: short(stage.kind, 32), state: short(attempt?.state ?? "pending", 32), verdict: short(attempt?.verdict, 32) || null };
  }) });

/** The complete server allowlist. No tool inventory is forwarded to this
 * class. Handles let the backend select a row; only speech is read aloud. */
export class CompanionBoardReads {
  constructor(private readonly paths: BoardReadPaths) {}
  async call(project: string, name: string, args: Record<string, unknown>): Promise<SpeechReadResult> {
    project = canonicalProject(project);
    if (!(READ_TOOL_NAMES as readonly string[]).includes(name)) throw new Error("TOOL_NOT_ALLOWED");
    const field = name === "get_task" ? "taskId" : name === "get_pipeline" ? "pipelineId" : name === "conversation_messages" ? "conversationId" : null;
    if (Object.keys(args).some(key => key !== field && key !== "project")) throw new Error("INVALID_TOOL_ARGUMENTS");
    if (args.project !== undefined && (typeof args.project !== "string" || canonicalProject(args.project) !== project)) throw new Error("PROJECT_REFUSED");
    if (field && (typeof args[field] !== "string" || !(args[field] as string).length || (args[field] as string).length > 128)) throw new Error("INVALID_TOOL_ARGUMENTS");
    const limit = 8;
    if (name === "list_tasks") {
      const rows = this.paths.tasks().filter(row => canonicalProject(row.project) === project);
      const shown = rows.slice(0, limit).map(taskRow);
      return { total: rows.length, rows: shown, speech: `${rows.length} tasks. ${shown.map(row => `${row.title}: ${row.state}`).join(". ")}`.slice(0, 1_600), truncated: rows.length > limit };
    }
    if (name === "get_task") {
      const row = this.paths.tasks().find(row => row.id === args.taskId);
      if (!row || canonicalProject(row.project) !== project) throw new Error("PROJECT_REFUSED");
      const item = { ...taskRow(row), note: short(row.note?.text, 320), hold: short(row.hold?.note, 200),
        steps: row.steps?.slice(0, 8).map(step => ({ text: short(step.text), state: short(step.state, 32) })) ?? [] };
      return { item, speech: `${item.title}: ${item.state}. ${item.note} ${item.hold} ${item.steps.map(step => `${step.text}: ${step.state}`).join(". ")}`.slice(0, 1_600), truncated: (row.steps?.length ?? 0) > 8 };
    }
    if (name === "list_pipelines" || name === "get_pipeline") {
      const rows = this.paths.pipelines();
      if (name === "get_pipeline") {
        const row = rows.find(row => row.id === args.pipelineId);
        if (!row || canonicalProject(row.project) !== project) throw new Error("PROJECT_REFUSED");
        const item = pipelineRow(row);
        return { item, speech: `${item.title}: ${item.state}. ${item.stages.map(stage => `${stage.title}: ${stage.state}`).join(". ")}`, truncated: row.stages.length > 12 };
      }
      const local = rows.filter(row => canonicalProject(row.project) === project);
      const shown = local.slice(0, limit).map(row => ({ ...taskRow({ id: row.id, project, text: row.task, status: row.state }) }));
      return { total: local.length, rows: shown, speech: `${local.length} pipelines. ${shown.map(row => `${row.title}: ${row.state}`).join(". ")}`.slice(0, 1_600), truncated: local.length > limit };
    }
    const activity = (await this.paths.activity(project)).filter(row => canonicalProject(row.project) === project && !["gone", "idle", "completed", "failed"].includes(row.lifecycle));
    if (name === "agent_activity") {
      const rows = activity.slice(0, limit).map(row => ({ handle: handle(row.conversationId), title: short(row.title) || "Agent", state: short(row.lifecycle, 32) }));
      return { total: activity.length, rows, speech: `${activity.length} active agents. ${rows.map(row => `${row.title}: ${row.state}`).join(". ")}`.slice(0, 1_600), truncated: activity.length > limit };
    }
    const agent = activity.find(row => row.conversationId === args.conversationId);
    if (!agent) throw new Error("PROJECT_REFUSED");
    const messages = (await this.paths.messages(agent.conversationId)).filter(row => row.role === "assistant" || row.role === "user");
    const rows = messages.slice(0, 4).map(row => ({ speaker: row.role, excerpt: short(row.text, 320) }));
    return { rows, speech: rows.map(row => row.excerpt).join(". ").slice(0, 1_600), truncated: messages.length > 4 };
  }
}
