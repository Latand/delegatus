import { ChevronDown, Ellipsis, Search } from "lucide-react";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { PRODUCT_NAME } from "@/lib/brand";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";
import { PROJECT_NAMES_STORAGE_KEY } from "@/lib/client/projectNameCache";

import { DelegatusMark } from "./brand/BrandMark";
import { kanbanColumnTracks, type KanbanLayoutMode } from "./kanban/kanbanLayout";
import { SEAT_HEIGHT_VERSION, SEAT_SHORT_WINDOW, SEAT_STORAGE_KEY } from "./kanban/kanbanSeatStore";
import { OVERVIEW } from "./projectModel";
import { RAIL_HIDDEN_STORAGE_KEY } from "./ProjectRail";
import { SKELETON_BAR, SkeletonRow } from "./skeletons";

/*
 * The first frame of the app (#2071, docs/design/skeletons-and-transitions.md
 * D1).
 *
 * The real tree reads the viewport, the stored project and its name from the
 * browser, none of which exists in a server render. It used to render the
 * desktop Overview there instead, so a phone painted a desktop layout that
 * said «No projects yet» until the bundle ran. This shell is what the server
 * and the hydration render draw instead: both form factors, one shown by the
 * same media query `useIsMobile` answers, in the shape of the board that is
 * coming. The inline script right after it names the project, picks the
 * language and sizes the seat and columns from this browser's storage before
 * the first paint, so the shell never shows a raw key or the wrong language.
 *
 * Deterministic on purpose: no hooks, no browser reads while rendering, so
 * the server and hydration renders agree. The Viewer replaces it with the real
 * tree right after hydration.
 */

const LOCALES: readonly Locale[] = ["en", "uk"];

/** A label in both languages; the boot script shows the one the page uses. */
function Label({ k }: { k: MessageKey }) {
  return (
    <>
      {LOCALES.map((locale) => (
        <span key={locale} data-boot-lang={locale}>{translate(locale, k)}</span>
      ))}
    </>
  );
}

function Bar({ width, height }: { width: string; height: number }) {
  return <span aria-hidden className={`block shrink-0 ${SKELETON_BAR}`} style={{ width, height }} />;
}

const MODES: readonly KanbanLayoutMode[] = ["wide", "narrow", "scroll", "tabs"];
const TRACKS = Object.fromEntries(MODES.map((mode) => [mode, kanbanColumnTracks(mode, { overview: false, wide: null, reading: new Set() })]));
const OVERVIEW_TRACKS = Object.fromEntries(MODES.map((mode) => [mode, kanbanColumnTracks(mode, { overview: true, wide: null, reading: new Set() })]));
const COLUMNS = ["inbox", "assigned", "blocked", "done"] as const;
const COLUMN_CARDS: Record<(typeof COLUMNS)[number], number> = { inbox: 2, assigned: 1, blocked: 0, done: 0 };

/**
 * Names the project, sets the language and sizes the desktop board, before
 * the first paint. Mirrors, in a few lines of ES5:
 * - `initialProjectFromState` (the `#p=` hash, then `llvProject`);
 * - `projectTitle` (the remembered name, then the readable key; an opaque
 *   `repo-`/`dir-` key stays a placeholder bar);
 * - the i18n detection (`llv_lang`, then the browser language);
 * - `kanbanLayoutMode` and `seatCollapsed` for the columns and the seat.
 */
export const BOOT_SHELL_SCRIPT = `(function(){try{
var d=document,r=d.querySelector("[data-boot-shell]");if(!r)return;
var s=null;try{s=window.localStorage}catch(e){}
function g(k){try{return s?s.getItem(k):null}catch(e){return null}}
var h=location.hash,p=null,m=/^#p=([^&]+)/.exec(h);
if(m){try{p=decodeURIComponent(m[1])}catch(e){}}
if(!p)p=g("llvProject");
var ov=!p||p===${JSON.stringify(OVERVIEW)};
var l=g("llv_lang");if(l!=="en"&&l!=="uk")l=String(navigator.language||"").toLowerCase().indexOf("uk")===0?"uk":"en";
d.documentElement.lang=l;r.setAttribute("data-boot-locale",l);
r.setAttribute("data-boot-view",ov?"overview":"project");
var t=null;
if(!ov){var n={};try{n=JSON.parse(g(${JSON.stringify(PROJECT_NAMES_STORAGE_KEY)})||"{}")||{}}catch(e){}
t=typeof n[p]==="string"&&n[p].trim()?n[p].trim():null;
if(!t&&!/^(?:repo|dir)-[0-9a-f]{16,}$/.test(p)){t=p==="project_unresolved"?"Unresolved project":p.indexOf("-agents-tools-")===0&&p.length>14?p.slice(14):(p.replace(/^-+/,"")||p)}}
var ts=r.querySelectorAll("[data-boot-title]");
for(var i=0;i<ts.length;i++){if(t){ts[i].textContent=t;ts[i].setAttribute("data-boot-named","")}}
var hidden=g(${JSON.stringify(RAIL_HIDDEN_STORAGE_KEY)})==="hidden";if(hidden)r.setAttribute("data-boot-rail","hidden");
var w=window.innerWidth-(hidden?34:248),md=w>=1400?"wide":w>=1200?"narrow":w>=768?"scroll":"tabs";
var TR=ov?${JSON.stringify(OVERVIEW_TRACKS)}:${JSON.stringify(TRACKS)};
var kb=r.querySelector("[data-boot-kb]"),bd=r.querySelector("[data-boot-board]"),nav=r.querySelector("[data-boot-tabs]");
if(kb)kb.setAttribute("data-mode",md);
if(bd){bd.className="board"+(md==="wide"?"":" "+md);var tr=TR[md];if(tr)for(var k in tr)bd.style.setProperty(k,tr[k])}
if(nav){nav.className="tabs-nav"+(md==="scroll"?" jump":"");nav.style.display=md==="wide"||md==="narrow"?"none":""}
var st=r.querySelector("[data-boot-seat]");
if(st&&!ov){var rc={};try{rc=JSON.parse(g(${JSON.stringify(SEAT_STORAGE_KEY)})||"{}")||{}}catch(e){}
var c=rc.collapsed&&typeof rc.collapsed[p]==="boolean"?rc.collapsed[p]:window.innerHeight<${SEAT_SHORT_WINDOW};
if(c)st.className="seat folded";else if(rc.heightV===${SEAT_HEIGHT_VERSION}&&typeof rc.height==="number")st.style.setProperty("--seat-h",rc.height+"px")}
}catch(e){}})();`;

/* Which shell shows, which language shows, and what the project view adds
   over the overview. The query is `useIsMobile`'s own, so the shell the
   server picks is the layout the app mounts. */
const BOOT_SHELL_STYLE = `
[data-boot-shell] [data-boot-phone]{display:none}
@media ${MOBILE_LAYOUT_QUERY}{[data-boot-shell] [data-boot-phone]{display:flex}[data-boot-shell] [data-boot-desk]{display:none}}
[data-boot-shell][data-boot-locale="uk"] [data-boot-lang="en"],[data-boot-shell]:not([data-boot-locale="uk"]) [data-boot-lang="uk"]{display:none}
[data-boot-shell]:not([data-boot-view="project"]) [data-boot-project-only],[data-boot-shell][data-boot-view="project"] [data-boot-overview-only]{display:none}
[data-boot-shell] [data-boot-title]:not([data-boot-named])+[data-boot-title-bar]{display:inline-block}
[data-boot-shell] [data-boot-title-bar]{display:none}
[data-boot-shell][data-boot-rail="hidden"] [data-boot-rail-aside]{display:none}
`;

function PhoneShell() {
  return (
    <div data-boot-phone="" className="h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-border bg-canvas px-1">
        <div className="flex h-11 min-w-0 flex-1 items-center gap-1 rounded-[8px] px-1.5">
          <span data-boot-project-only="" className="flex min-w-0 items-center">
            <span data-boot-title="" className="min-w-0 truncate text-title font-semibold leading-tight text-primary" />
            <span data-boot-title-bar="" aria-hidden className={`h-3 w-24 ${SKELETON_BAR}`} />
          </span>
          <span data-boot-overview-only="" className="min-w-0 truncate text-title font-semibold leading-tight text-primary"><Label k="rail.overview" /></span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </div>
        {/* Search and ⋯, inert until the app mounts over them. */}
        <span className="flex h-11 w-11 shrink-0 items-center justify-center text-secondary"><Search className="h-5 w-5" aria-hidden /></span>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center text-secondary"><Ellipsis className="h-5 w-5" aria-hidden /></span>
      </header>
      <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col overflow-hidden pb-3">
        <span className="sr-only"><Label k="dash.loadingBoard" /></span>
        <div data-boot-project-only="">
          <div className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary"><Label k="mobile2.board.orchestrator" /></div>
          <div className="px-3" aria-hidden>
            <div className="flex min-h-14 items-center gap-3 rounded-[12px] bg-card px-3 py-2 shadow-1">
              <span className="h-8 w-8 shrink-0 rounded-full bg-sunken" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5"><Bar width="42%" height={12} /><Bar width="58%" height={10} /></span>
            </div>
          </div>
        </div>
        <div className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary"><Label k="mobile2.board.working" /></div>
        <div className="flex flex-col gap-1.5 px-3">
          {Array.from({ length: 10 }, (_, index) => <SkeletonRow key={index} index={index} />)}
        </div>
      </div>
      <footer data-boot-project-only="" className="shrink-0 border-t border-border bg-card px-3 pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5">
        <div className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border bg-sunken pl-2 pr-1.5 text-body text-muted">
          <span aria-hidden className="h-7 w-7 shrink-0 rounded-full bg-accent-soft" />
          <span className="min-w-0 flex-1 truncate"><Label k="mobile2.board.orchestrator" /></span>
        </div>
      </footer>
    </div>
  );
}

function DeskShell() {
  return (
    <div data-boot-desk="" className="flex h-full min-h-0 min-w-0 flex-1">
      <aside data-boot-rail-aside="" className="flex w-[248px] shrink-0 flex-col border-r border-border bg-card">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-[13.5px] font-bold">
          <DelegatusMark size={20} />
          <span className="min-w-0 truncate">{PRODUCT_NAME}</span>
        </header>
        <div className="flex gap-1.5 px-2.5 pb-1 pt-2.5">
          <span className="h-[30px] w-full rounded-[9px] border border-border bg-canvas" />
        </div>
        <div className="flex flex-col gap-1 px-1.5 py-1">
          {Array.from({ length: 6 }, (_, index) => <SkeletonRow key={index} index={index} dot={false} compact />)}
        </div>
      </aside>
      {/* A hidden rail leaves its 34 px restore control. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div data-boot-project-only="" className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
          <h1 data-boot-title="" className="min-w-12 max-w-[220px] truncate text-[13.5px] font-bold" />
          <span data-boot-title-bar="" aria-hidden className={`h-3 w-24 ${SKELETON_BAR}`} />
        </div>
        <div data-boot-overview-only="" className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-card px-4">
          <h1 className="min-w-0 shrink truncate text-[13.5px] font-bold"><Label k="rail.overview" /></h1>
        </div>
        <div className="kb" data-boot-kb="" data-mode="wide">
          <div role="status" aria-busy="true" className="kb-body">
            <span className="sr-only"><Label k="dash.loadingBoard" /></span>
            <div className="kb-page">
              <section data-boot-seat="" data-boot-project-only="" className="seat" aria-hidden>
                <div className="seat-head">
                  <span className="h-6 w-6 shrink-0 rounded-full bg-sunken" />
                  <span className="text-[13px] font-semibold text-primary"><Label k="orchPanel.title" /></span>
                  <Bar width="96px" height={10} />
                </div>
              </section>
              <div className="board-frame">
                <div className="scroll-wrap">
                  <div data-boot-tabs="" className="tabs-nav" style={{ display: "none" }} aria-hidden>
                    {COLUMNS.map((status) => <button key={status} type="button" tabIndex={-1}><Label k={`kanban.status.${status}`} /></button>)}
                  </div>
                  <div data-boot-board="" className="board">
                    {COLUMNS.map((status, column) => (
                      <section key={status} className={`column${status === "assigned" ? " active" : ""}`} data-status={status}>
                        <div className="col-head"><h2><Label k={`kanban.status.${status}`} /></h2></div>
                        {Array.from({ length: COLUMN_CARDS[status] }, (_, index) => (
                          <div key={index} aria-hidden className="mx-3 mb-2 flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 shadow-1">
                            <Bar width={`${[68, 58, 72, 62][(column * 2 + index) % 4]}%`} height={12} />
                            <Bar width={`${[42, 38, 46, 40][(column * 2 + index) % 4]}%`} height={10} />
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function BootShell() {
  return (
    <div data-boot-shell="" className="flex h-full min-h-0 min-w-0">
      <style dangerouslySetInnerHTML={{ __html: BOOT_SHELL_STYLE }} />
      <PhoneShell />
      <DeskShell />
      <script dangerouslySetInnerHTML={{ __html: BOOT_SHELL_SCRIPT }} />
    </div>
  );
}
