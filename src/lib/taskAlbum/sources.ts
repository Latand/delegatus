import type { Flow } from "@/lib/reviewHistory/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

/**
 * Where a task's pictures come from: every transcript of every conversation
 * the task holds and of every attempt of every pipeline stage bound to it,
 * review rounds included. A conversation that moved across transcripts
 * (a resume, an account migration) contributes each of them.
 */

/** Which conversation a transcript belongs to, as the album names it. */
export interface AlbumSource {
  /** Stable grouping key: the conversation id, else the transcript path. */
  key: string;
  conversationId: string | null;
  /** The transcript a link to this source opens. */
  path: string;
  stage?: { pipelineId: string; stageId: string; attempt: number; round?: number };
}

export interface AlbumTranscript {
  path: string;
  source: AlbumSource;
}

export interface TaskAlbumWorld {
  task(taskId: string): BoardTask | null;
  pipelines(): readonly Pipeline[];
  flow(flowId: string): Flow | null;
  /** Every transcript a conversation has had, newest last. */
  conversationPaths(conversationId: string): readonly string[];
  /** Whether a transcript lies under a scanned transcript root. */
  transcriptAllowed(path: string): boolean;
}

export function taskAlbumTranscripts(taskId: string, world: TaskAlbumWorld): AlbumTranscript[] {
  const task = world.task(taskId);
  if (!task) return [];
  const out: AlbumTranscript[] = [];
  const seen = new Set<string>();
  const add = (conversationId: string | null | undefined, path: string | null | undefined, stage?: AlbumSource["stage"]) => {
    const paths = conversationId ? [...world.conversationPaths(conversationId)] : [];
    if (path && !paths.includes(path)) paths.push(path);
    const current = paths.at(-1);
    if (!current) return;
    const source: AlbumSource = { key: conversationId ?? current, conversationId: conversationId ?? null, path: current, ...(stage ? { stage } : {}) };
    for (const transcript of paths) {
      if (seen.has(transcript) || !world.transcriptAllowed(transcript)) continue;
      seen.add(transcript);
      out.push({ path: transcript, source });
    }
  };

  /* Stages first: a stage's conversation is also a task assignment, and the
     album names it by its stage. */
  for (const pipeline of world.pipelines()) {
    if (!pipeline.taskIds.includes(taskId)) continue;
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        const stage = { pipelineId: pipeline.id, stageId: run.stageId, attempt: attempt.n };
        add(attempt.conversationId, attempt.agentPath, stage);
        const flow = attempt.flowId ? world.flow(attempt.flowId) : null;
        if (!flow) continue;
        add(flow.implementerConversationId, flow.implementerPath, stage);
        for (const round of flow.rounds) add(round.reviewerConversationId, round.reviewerPath, { ...stage, round: round.n });
      }
    }
  }
  for (const assignment of task.assignments) add(assignment.conversationId, assignment.path);
  return out;
}
