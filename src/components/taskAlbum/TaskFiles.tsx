"use client";

import { FileCode, FileImage, FileText, File as FileIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2 } from "@/components/icons";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import { formatBytes } from "@/components/preview/artifactResource";
import { openArtifactPreview } from "@/components/preview/previewBus";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskFile, TaskFilesLane } from "@/lib/taskFiles/files";
import { LANES_PER_REQUEST, PREVIEW_MAX_BYTES } from "@/lib/taskFiles/limits";
import { cleanTitle } from "@/lib/title";

/**
 * The Files view of a task's album (docs/design/task-file-preview.md §7.3):
 * what each of the task's lanes committed, newest lane first. It reads one
 * small list per page of lanes when it is shown, never on a timer, and no file
 * content until a row is pressed. A row opens the shared preview sheet above
 * the album, reading the committed blob through the task's own route.
 */

/** Declared, document and image rows show; the rest fold behind one button. */
const VISIBLE_ROWS = 24;
const VISIBLE_GROUPS = new Set<TaskFile["group"]>(["declared", "document", "image"]);

/** `omitted`: the answer left this lane out (stale, unbound or not readable by the caller). It says no more than that. */
type LaneState = TaskFilesLane | "loading" | "omitted";
type FilesAnswer = { lanes: TaskFilesLane[]; omitted: number };

const exactTime = (ts: number) => new Date(ts).toLocaleString();

function basenameOf(path: string): string {
  return path.split("/").pop() || path;
}
function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function laneTitle(pipeline: Pipeline | undefined, fallback: string): string {
  return cleanTitle((pipeline?.task ?? "").split("\n")[0] ?? "", 90) || fallback;
}

/** Why a row cannot open, or null when it can. A deleted row says "deleted" in its own words. */
function noPreviewReason(t: TFunction, file: TaskFile): string | null {
  if (file.previewable || file.op === "delete") return null;
  if (file.mode === "link") return t("files.link");
  if (file.mode === "submodule") return t("files.submodule");
  if (file.size !== null && file.size > PREVIEW_MAX_BYTES) return t("files.tooLarge");
  return t("files.noPreview");
}

function KindGlyph({ file }: { file: TaskFile }) {
  const cls = "h-4 w-4 shrink-0 text-muted";
  if (file.group === "image") return <FileImage className={cls} aria-hidden />;
  if (file.group === "source") return <FileCode className={cls} aria-hidden />;
  if (file.group === "other") return <FileIcon className={cls} aria-hidden />;
  return <FileText className={cls} aria-hidden />;
}

function previewBase(taskId: string, lane: string, head: string, file: string): string {
  const query = new URLSearchParams({ lane, head, file });
  return `/api/tasks/${encodeURIComponent(taskId)}/files/content?${query.toString()}`;
}

function openFile(taskId: string, lane: Extract<TaskFilesLane, { status: "ok" }>, file: TaskFile): void {
  const base = previewBase(taskId, lane.lane, lane.head, file.path);
  openArtifactPreview(file.path, { kind: "file", path: file.path, line: null, column: null, anchor: null }, {
    source: { metaUrl: `${base}&mode=meta`, contentUrl: base },
    layer: "overlay",
  });
}

export function TaskFiles({ taskId, pipelines }: { taskId: string; pipelines: readonly Pipeline[] }) {
  const { t } = useLocale();
  /* Newest lane first. */
  const lanes = useMemo(() => [...pipelines].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : 1)), [pipelines]);
  const [requested, setRequested] = useState(LANES_PER_REQUEST);
  const [answers, setAnswers] = useState<Record<string, LaneState>>({});
  const [failed, setFailed] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const controllers = useRef(new Set<AbortController>());

  /* One list read for some lanes. `initial` failing fails the view; a page of
     older lanes failing says so beside its button; a retried lane keeps the rest. */
  const read = useCallback(async (ids: readonly string[], kind: "initial" | "older" | "retry") => {
    const controller = new AbortController();
    controllers.current.add(controller);
    setAnswers((held) => ({ ...held, ...Object.fromEntries(ids.map((id) => [id, "loading" as const])) }));
    try {
      const query = ids.map(encodeURIComponent).join(",");
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/files?lanes=${query}`, { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as FilesAnswer;
      setAnswers((held) => {
        const next = { ...held };
        const answered = new Set(body.lanes.map((lane) => lane.lane));
        for (const id of ids) {
          if (answered.has(id)) delete next[id];
          else next[id] = "omitted";
        }
        for (const lane of body.lanes) if (ids.includes(lane.lane)) next[lane.lane] = lane;
        return next;
      });
      if (kind === "initial") setFailed(false);
      if (kind === "older") setOlderFailed(false);
    } catch {
      if (controller.signal.aborted) return;
      setAnswers((held) => {
        const next = { ...held };
        for (const id of ids) if (next[id] === "loading") delete next[id];
        return next;
      });
      if (kind === "initial") setFailed(true);
      else if (kind === "older") setOlderFailed(true);
      else setAnswers((held) => ({ ...held, ...Object.fromEntries(ids.map((id) => [id, { lane: id, status: "unavailable", reason: "failed" } as const])) }));
    } finally {
      controllers.current.delete(controller);
    }
  }, [taskId]);

  /* The first page, once, when the view is first shown. */
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void read(lanes.slice(0, LANES_PER_REQUEST).map((lane) => lane.id), "initial");
  }, [lanes, read]);
  useEffect(() => {
    const held = controllers.current;
    return () => {
      for (const controller of held) controller.abort();
      held.clear();
      started.current = false;
    };
  }, []);

  const showOlder = useCallback(() => {
    const next = requested + LANES_PER_REQUEST;
    setRequested(next);
    setOlderFailed(false);
    void read(lanes.slice(requested, next).map((lane) => lane.id), "older");
  }, [lanes, read, requested]);

  const shown = lanes.slice(0, requested).filter((lane) => answers[lane.id] !== undefined);
  const loading = shown.length === 0 && !failed;
  const hasOlder = lanes.length > requested;
  const everyLaneEmpty = shown.length > 0 && shown.every((lane) => {
    const answer = answers[lane.id];
    return typeof answer === "object" && answer.status === "ok" && answer.files.length === 0;
  });

  if (failed && shown.length === 0) {
    return (
      <div role="alert" data-task-files-failed="" className="flex flex-col items-start gap-2 rounded-control border border-danger/45 bg-danger-soft px-3 py-2 text-label font-semibold text-danger">
        {t("files.failed")}
        <button type="button" className="min-h-11 rounded-control border border-border bg-canvas px-3 text-label font-semibold text-secondary sm:min-h-8" onClick={() => { setFailed(false); void read(lanes.slice(0, LANES_PER_REQUEST).map((lane) => lane.id), "initial"); }}>
          {t("album.retry")}
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <p role="status" data-task-files-loading="" className="m-0 flex items-center gap-2 py-6 text-label font-semibold text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loadingCap")}
      </p>
    );
  }
  if (everyLaneEmpty && !hasOlder) {
    return <p data-task-files-empty="" className="m-0 py-6 text-center text-ui text-muted">{t("files.empty")}</p>;
  }

  return (
    <div data-task-files="" className="flex flex-col gap-6">
      {shown.map((pipeline) => (
        <LaneSection
          key={pipeline.id}
          taskId={taskId}
          pipeline={pipeline}
          answer={answers[pipeline.id]!}
          expanded={expanded.has(pipeline.id)}
          onToggle={() => setExpanded((held) => { const next = new Set(held); if (!next.delete(pipeline.id)) next.add(pipeline.id); return next; })}
          onRetry={() => void read([pipeline.id], "retry")}
        />
      ))}
      {hasOlder ? (
        <button
          type="button"
          data-task-files-older=""
          className="inline-flex min-h-11 items-center justify-center gap-1.5 self-center rounded-control border border-border bg-canvas px-4 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-9"
          onClick={showOlder}
        >
          {t("files.olderLanes")}
        </button>
      ) : null}
      {olderFailed ? <p role="alert" data-task-files-older-failed="" className="m-0 self-center text-label text-danger">{t("files.olderFailed")}</p> : null}
    </div>
  );
}

function LaneSection({ taskId, pipeline, answer, expanded, onToggle, onRetry }: {
  taskId: string;
  pipeline: Pipeline;
  answer: LaneState;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  const title = laneTitle(pipeline, pipeline.id);
  const ok = typeof answer === "object" && answer.status === "ok" ? answer : null;
  return (
    <section data-task-files-lane={pipeline.id} className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="m-0 min-w-0 truncate text-ui font-semibold text-secondary" title={title}>{title}</h3>
        {ok ? (
          <span className="shrink-0 text-label tabular-nums text-muted" title={`${t("files.committedAt", { time: exactTime(ok.committedAt) })} · ${ok.head}`}>
            <span className="font-mono">{t("files.at", { sha: ok.head.slice(0, 7) })}</span>
          </span>
        ) : null}
      </div>
      {ok?.headSource === "last-passed" ? <p className="m-0 text-label text-muted">{t("files.lastPassed")}</p> : null}
      {pipeline.state === "running" ? <p data-task-files-running="" className="m-0 text-label text-muted">{t("files.running")}</p> : null}
      {answer === "loading" ? (
        <p role="status" className="m-0 flex items-center gap-2 text-label font-semibold text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loadingCap")}
        </p>
      ) : answer === "omitted" ? (
        <p data-task-files-unavailable="omitted" className="m-0 text-label text-muted">{t("files.unavailable.omitted")}</p>
      ) : answer.status === "unavailable" ? (
        <div data-task-files-unavailable={answer.reason} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted">
          <span>{t(`files.unavailable.${answer.reason === "repository-missing" ? "repository" : answer.reason === "commits-gone" ? "commits" : answer.reason}`)}</span>
          {answer.reason === "busy" || answer.reason === "failed" ? (
            <button type="button" className="min-h-11 rounded-control border border-border bg-canvas px-3 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-8" onClick={onRetry}>
              {t("album.retry")}
            </button>
          ) : null}
        </div>
      ) : (
        <LaneFiles taskId={taskId} pipeline={pipeline} lane={answer} expanded={expanded} onToggle={onToggle} />
      )}
    </section>
  );
}

function LaneFiles({ taskId, pipeline, lane, expanded, onToggle }: {
  taskId: string;
  pipeline: Pipeline;
  lane: Extract<TaskFilesLane, { status: "ok" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  if (lane.files.length === 0) return <p data-task-files-lane-empty="" className="m-0 text-label text-muted">{t("files.noChanges")}</p>;
  const visible: TaskFile[] = [];
  const folded: TaskFile[] = [];
  for (const file of lane.files) (VISIBLE_GROUPS.has(file.group) && visible.length < VISIBLE_ROWS ? visible : folded).push(file);
  const rows = expanded ? [...visible, ...folded] : visible;
  const hidden = lane.total - lane.files.length;
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((file) => <FileRow key={file.path} taskId={taskId} pipeline={pipeline} lane={lane} file={file} />)}
      </ul>
      {folded.length ? (
        <button
          type="button"
          data-task-files-fold=""
          aria-expanded={expanded}
          className="inline-flex min-h-11 items-center self-start rounded-control px-1 text-label font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-8"
          onClick={onToggle}
        >
          {expanded ? t("files.less") : t("files.more", { count: folded.length })}
        </button>
      ) : null}
      {lane.truncated ? <p data-task-files-truncated="" className="m-0 text-label text-muted">{t("files.truncated", { count: hidden })}</p> : null}
    </>
  );
}

function FileRow({ taskId, pipeline, lane, file }: {
  taskId: string;
  pipeline: Pipeline;
  lane: Extract<TaskFilesLane, { status: "ok" }>;
  file: TaskFile;
}) {
  const { t } = useLocale();
  const name = basenameOf(file.path);
  const directory = directoryOf(file.path);
  const opWord = t(`files.op.${file.op}`);
  const reason = noPreviewReason(t, file);
  const stage = file.declaredBy ? pipeline.stages.find((entry) => entry.id === file.declaredBy) : undefined;
  const declared = file.declaredBy ? t("files.declared", { stage: stage ? stageDisplayName(t, stage) : file.declaredBy }) : null;
  const counts = file.binary ? t("files.binary") : file.op === "delete" ? `−${file.removed}` : `+${file.added} −${file.removed}`;
  const body = (
    <>
      <KindGlyph file={file} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-ui text-primary" title={file.path}>{name}</span>
          <span className="shrink-0 text-label font-semibold text-secondary">{opWord}</span>
          <span className="shrink-0 text-label tabular-nums text-muted">{counts}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-caption text-muted">
          {/* The directory shortens from its start: the end names the place. */}
          <span className="min-w-0 flex-1 truncate" style={{ direction: "rtl", textAlign: "left" }} title={directory || undefined}>{directory ? <bdi>{directory}</bdi> : null}</span>
          {file.size !== null ? <span className="shrink-0 tabular-nums">{formatBytes(file.size)}</span> : null}
        </span>
        {declared || reason ? (
          <span className="flex flex-wrap gap-x-2 text-caption">
            {declared ? <span data-task-file-declared="" className="font-semibold text-accent">{declared}</span> : null}
            {reason ? <span data-task-file-reason="" className="text-muted">{reason}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  const rowClass = "flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-control border px-3 py-2 sm:min-h-8";
  const aria = directory ? t("files.rowAria", { name, state: opWord, dir: directory }) : t("files.rowAriaRoot", { name, state: opWord });
  return (
    <li className="min-w-0" data-task-file={file.path} data-task-file-op={file.op}>
      {file.previewable ? (
        <button
          type="button"
          aria-label={aria}
          className={`${rowClass} border-border bg-canvas hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          onClick={() => openFile(taskId, lane, file)}
        >
          {body}
        </button>
      ) : (
        <div className={`${rowClass} border-transparent bg-sunken opacity-90`}>{body}</div>
      )}
    </li>
  );
}
