"use client";

import { ChevronRight, Copy, Ellipsis, FileText, Square } from "lucide-react";
import { useState } from "react";

import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

import { copyText } from "../feed/CopyButton";
import { LogFeed } from "../LogFeed";
import { TASK_TONES, taskTitle } from "../tasks/taskModel";
import type { TaskRelation } from "../tasks/taskRelations";
import { useProcessKill } from "../TaskHeader";
import { activityDot, fmtAge } from "../utils";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";

/*
 * The two things that used to sit in strips under the conversation's header on
 * the phone — the pinned message and the background tasks — now open from the
 * header's `⋯` menu as bottom sheets, so the header keeps its height and the
 * transcript starts directly under it.
 *
 * The pinned message is the board task related to the conversation (assigned
 * into it, or captured from it): the sheet reads its full text and opens its
 * card. The background tasks are the shell processes the conversation started;
 * each row carries one `⋯` of its own, because stopping a task is a rare act
 * and does not earn a permanent button.
 */

const noop = () => undefined;

export function MobilePinnedSheet({ relations, onOpenTask, onClose }: {
  relations: readonly TaskRelation[];
  onOpenTask: (task: BoardTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <MobileSheet name="pinned" title={t("mobile2.chat.menuPinned")} onClose={onClose}>
      <div data-mobile2-pinned className="flex flex-col">
        {relations.map(({ task }, index) => (
          <div key={task.id} data-mobile2-pinned-item={task.id} className="flex flex-col">
            {index > 0 ? <MobileSheetDivider /> : null}
            <div className="flex items-start gap-2 px-4 pb-1 pt-2">
              <span aria-hidden className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TASK_TONES[task.status].color }} />
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-body leading-[1.45] text-primary">{task.text}</p>
            </div>
            <MobileSheetRow
              icon={<FileText className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pinned.openCard")}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={() => { onClose(); onOpenTask(task); }}
              ariaLabel={`${t("mobile2.pinned.openCard")}: ${taskTitle(task.text) || t("tasks.untitled")}`}
              attrs={{ "data-mobile2-pinned-open": task.id }}
            />
          </div>
        ))}
      </div>
    </MobileSheet>
  );
}

export function MobileBackgroundSheet({ tasks, onClose }: { tasks: readonly FileEntry[]; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <MobileSheet name="background" title={`${t("mobile2.tasks.title")} · ${tasks.length}`} onClose={onClose}>
      <ul data-mobile2-background className="flex flex-col">
        {tasks.map((task) => <BackgroundTaskRow key={task.path} file={task} />)}
      </ul>
    </MobileSheet>
  );
}

function BackgroundTaskRow({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const kill = useProcessKill(file);
  const [menuOpen, setMenuOpen] = useState(false);
  const [output, setOutput] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = cleanTitle(file.cmdDesc || file.title, 80);
  const age = fmtAge(file.mtime);
  return (
    <li data-mobile2-task={file.path} className="flex flex-col border-b border-border last:border-b-0">
      <div className="flex min-h-11 items-center gap-2 pl-4 pr-1">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
        <span className="flex min-w-0 flex-1 flex-col py-1.5">
          <span className="min-w-0 truncate text-body font-semibold text-primary" title={cleanTitle(file.title)}>{title}</span>
          {age ? <span className="min-w-0 truncate text-label font-medium text-muted">{t("mobile2.tasks.lastOutput", { age })}</span> : null}
        </span>
        <button
          type="button"
          data-mobile2-task-menu
          aria-label={t("task.menuAria", { title })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Ellipsis className="h-5 w-5" aria-hidden />
        </button>
      </div>
      {menuOpen ? (
        <div role="menu" aria-label={t("task.menuAria", { title })} data-mobile2-task-actions className="flex flex-col bg-sunken/60 pb-1">
          {file.pid === null ? null : (
            <div className="flex min-h-9 items-center px-4 text-label font-semibold tabular-nums text-secondary">{t("task.menuPid", { pid: file.pid })}</div>
          )}
          {kill.state === "hidden" ? null : (
            <MobileSheetRow
              role="menuitem"
              danger
              icon={<Square className="h-[18px] w-[18px]" fill="currentColor" aria-hidden />}
              label={t("task.stopTask")}
              disabled={kill.state === "disabled" || kill.busy}
              trailing={kill.state === "disabled" ? kill.reason : kill.force ? "SIGKILL" : undefined}
              ariaLabel={file.pid === null ? undefined : t("task.stopAria", { pid: file.pid })}
              onSelect={() => { void kill.kill().then((ok) => { if (ok) setMenuOpen(false); }); }}
              attrs={{ "data-mobile2-task-stop": "" }}
            />
          )}
          <MobileSheetRow
            role="menuitem"
            icon={<FileText className="h-[18px] w-[18px]" aria-hidden />}
            label={output ? t("task.hideOutput") : t("task.showOutput")}
            onSelect={() => { setOutput((open) => !open); setMenuOpen(false); }}
            attrs={{ "data-mobile2-task-output": "" }}
          />
          <MobileSheetRow
            role="menuitem"
            icon={<Copy className="h-[18px] w-[18px]" aria-hidden />}
            label={t("task.copyCommand")}
            trailing={copied ? t("common.copied") : undefined}
            disabled={!file.cmd}
            onSelect={() => { void copyText(file.cmd ?? "").then((ok) => setCopied(ok)); }}
            attrs={{ "data-mobile2-task-copy": "" }}
          />
          {kill.message ? <span role="status" className="px-4 pb-1 text-label font-semibold text-secondary">{kill.message}</span> : null}
        </div>
      ) : kill.message ? (
        <span role="status" className="px-4 pb-1.5 text-label font-semibold text-secondary">{kill.message}</span>
      ) : null}
      {output ? (
        <div data-mobile2-task-output-feed className="flex h-[220px] flex-col border-t border-dashed border-border bg-canvas/60">
          <LogFeed file={file} showSvc={false} lineFilter="" onStatus={noop} paused={false} follow setFollow={noop} compact />
        </div>
      ) : null}
    </li>
  );
}
