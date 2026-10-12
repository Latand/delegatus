/*
 * Entry the shared evidence harness bundles and serves
 * (`serveEvidenceFixture(out, "docs/design/tasks-menu-prototype/fixture.tsx")`).
 * Query: `v` 0 (today's panel and sheet, the real components) or 1–3 (the
 * variants); `phone=1`; `tab=agents`; `scope=all`; `expand=<task>` (variants 1
 * and 2); `select=<task>` and `detail=1` (variant 3); `pop=<task>` pins that
 * row's status popover open (variants 1 and 3).
 */
import { useMemo } from "react";
import { createRoot } from "react-dom/client";

import { BarPanelToggles, DashboardBar } from "@/components/ProjectBar";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { TaskSheet } from "@/components/tasks/TaskSheet";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { FAVORITES, PROJECT, PROJECT_NAMES, TASKS, boardTask, foldOf } from "./data";
import { DockFrame, PhoneSheet, Variant1, Variant2, Variant3, type Scope, type Tab } from "./menu";
import { proto } from "./strings";

const params = new URLSearchParams(window.location.search);
const variant = Number(params.get("v") ?? "0");
const phone = params.get("phone") === "1";
const tab: Tab = params.get("tab") === "agents" ? "agents" : "tasks";
const scope: Scope = params.get("scope") === "all" ? "all" : "project";
const NOW = Date.now();

function favoriteFile(title: string, project: string): FileEntry {
  return { path: `/tmp/fixture/${title}.jsonl`, project, title, activity: "recent", mtime: NOW / 1000 - 600, engine: "claude" } as unknown as FileEntry;
}

function Board() {
  const { locale } = useLocale();
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-canvas" data-proto-board="">
      <span className="rounded-control border border-dashed border-border px-3 py-1.5 text-label text-muted">{proto(locale, "boardHere")}</span>
    </div>
  );
}

function Desktop() {
  const { locale, t } = useLocale();
  const wide = window.innerWidth >= 1200;
  const stored = useMemo(() => TASKS.map((task) => boardTask(task, NOW, locale)), [locale]);
  const openCount = variant === 0
    ? stored.filter((task) => task.project === PROJECT && task.status !== "done").length
    : TASKS.filter((task) => task.project === PROJECT && task.status !== "done" && foldOf(task) === "active").length;
  const bar = (
    <DashboardBar
      lead={() => <span className="truncate text-title font-bold">delegatus</span>}
      status={() => <span className="flex items-center gap-1.5 text-ui text-secondary"><i className="h-2 w-2 rounded-full bg-success" />{proto(locale, "workingCount", { count: 7 })}</span>}
      find={() => null}
      view={() => null}
      create={() => null}
      trail={(barWide) => <BarPanelToggles wide={barWide} orchestrator={{ open: false, onToggle: () => undefined }} tasks={{ open: true, count: openCount, onToggle: () => undefined }} />}
    />
  );
  let panel: React.ReactNode;
  if (variant === 0) {
    panel = (
      <TaskPanel
        tasks={stored}
        project={PROJECT}
        boardMembers={new Set()}
        favorites={FAVORITES.map((favorite) => ({ id: favorite.id, project: favorite.project, file: favoriteFile(favorite.title[locale], favorite.project) }))}
        onOpenFavorite={() => undefined}
        onToggleFavorite={() => undefined}
        onOpenTask={() => undefined}
        onClose={() => undefined}
      />
    );
  } else if (variant === 1) {
    panel = <DockFrame width={wide ? 380 : 340} title={t("tasks.panelTitle")}><Variant1 now={NOW} phone={false} initialTab={tab} initialScope={scope} expandedId={params.get("expand")} popId={params.get("pop")} /></DockFrame>;
  } else if (variant === 2) {
    panel = <DockFrame width={wide ? 420 : 360} title={t("tasks.panelTitle")}><Variant2 now={NOW} phone={false} initialTab={tab} initialScope={scope} expandedId={params.get("expand")} /></DockFrame>;
  } else if (variant === 3) {
    panel = <DockFrame width={wide ? 340 : 320} title={t("tasks.panelTitle")}><Variant3 now={NOW} phone={false} initialTab={tab} initialScope={scope} selectedId={params.get("select")} paneWidth={wide ? 380 : 360} popId={params.get("pop")} /></DockFrame>;
  }
  return (
    <div className="flex h-full flex-col">
      {bar}
      <div className="relative flex min-h-0 flex-1">
        <Board />
        {panel}
      </div>
    </div>
  );
}

function Phone() {
  const { locale, t } = useLocale();
  const stored = useMemo(() => TASKS.map((task) => boardTask(task, NOW, locale)).filter((task) => task.project === PROJECT), [locale]);
  if (variant === 0) {
    return <TaskSheet project={PROJECT} projectName={PROJECT_NAMES[PROJECT]} tasks={stored} files={[]} initialView="list" onClose={() => undefined} onOpenTask={() => undefined} />;
  }
  const body = variant === 1
    ? <Variant1 now={NOW} phone initialTab={tab} initialScope={scope} expandedId={params.get("expand")} />
    : variant === 2
      ? <Variant2 now={NOW} phone initialTab={tab} initialScope={scope} expandedId={params.get("expand")} />
      : <Variant3 now={NOW} phone initialTab={tab} initialScope={scope} selectedId={params.get("select")} phoneDetail={params.get("detail") === "1"} />;
  return <PhoneSheet title={t("tasks.panelTitle")}>{body}</PhoneSheet>;
}

createRoot(document.getElementById("root")!).render(phone ? <Phone /> : <Desktop />);
