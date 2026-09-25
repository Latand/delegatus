"use client";

import { ChevronRight, Crown, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { formatConversationHash, isArchivedPredecessor, parseConversationHash, resolveConversationTarget, withoutArchivedPredecessors, type ConversationHash } from "@/lib/accounts/identity";
import { navigateToFragment, NOTIFICATION_OPEN_MESSAGE, setFragmentNavigator } from "@/lib/navigation/fragmentNavigation";
import { createTraversalFence, FOCUS_HISTORY_STATE_KEY, focusEntryFor, parseFocusHistoryState, recordFocusNavigation, recordProjectNavigation, retargetRecordedProject, setFocusHistoryOwner } from "@/lib/navigation/focusHistory";
import { onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useArchivedProjects } from "@/hooks/useArchivedProjects";
import { useProjectCuration } from "@/hooks/useProjectCuration";
import { useEffectiveFlows } from "@/components/flows/flowModel";
import { WorkLinksProvider } from "@/components/workLinks/workLinksContext";
import { useFiles } from "@/hooks/useFiles";
import { ServerReachProvider, useDerivedServerReach } from "@/hooks/serverReach";
import { publishConversationAvailability } from "@/lib/mcp/availability";
import { useBoardState } from "@/hooks/useBoardState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewPresence } from "@/hooks/useViewPresence";
import { OVERVIEW_CONTEXT, OVERVIEW_SLICE, viewBus } from "@/hooks/viewPresenceBus";
import { projectDisplayName, projectTitle } from "@/lib/displayNames";
import { cachedProjectName, rememberProjectNames } from "@/lib/client/projectNameCache";
import { canonicalClientProject } from "@/lib/projects/clientAliases";
import { useLocale } from "@/lib/i18n";
import type { AttentionNotice } from "@/lib/attention/types";
import type { FileEntry } from "@/lib/types";

import { advanceAttentionCycle, attentionExpiries, attentionId, type AttentionItem } from "./attention";
import { AttentionHost } from "./attention/AttentionHost";
import { useDismissalOverlay } from "./attention/dismissalOverlay";
import { clearNotice, markNoticesSeen, usePhoneNotices } from "./attention/phoneNotices";
import { BootShell } from "./BootShell";
import { AttentionIsland, AttentionLaneRow, AttentionQueueRow } from "./attention/AttentionIsland";
import { AttentionToast } from "./attention/AttentionToast";
import { attentionEntryProject, buildNeedsYouQueue, laneFocusPath, type MobileAttentionEntry } from "./attention/attentionQueue";
import { MobileAttentionSheet, type MobileNoticeRow } from "./attention/MobileAttentionSheet";
import { roleNameById } from "./builderCopy";
import { purgeLegacyOperatorCredential } from "./operatorCredential";
import { ArtifactPreviewHost } from "./preview/ArtifactPreviewHost";
import { OnboardingHost } from "./onboarding/OnboardingDialog";
import { SelfUpdateHost } from "./selfUpdate/SelfUpdateDialog";
import { VoiceBridgeRelayHost } from "./voice/VoiceBridgeRelayHost";
import { VoiceComposerHost } from "./voice/VoiceComposerHost";
import { VoicePipHost } from "./voice/VoicePipHost";
import { focusHandoffBus } from "./attention/focusHandoffBus";
import { expandKanbanSeat } from "./kanban/kanbanSeatStore";
import { ConnectionPill } from "./ConnectionPill";
import { resolveFavoriteRows, type FavoriteRow } from "./favorites/favoriteRows";
import { KeepAwakeProvider } from "./KeepAwakeControl";
import { useClosingPipelines } from "./mobile/MobilePipelineScreen";
import { getMobileNav, readMobileNavEntry, screenKey, standsOnOwnUrl, topScreen, useMobileNavStore, type MobileNavConfig, type MobileScreen } from "./mobile/mobileNav";
import { MobileProjectSheet } from "./mobile/MobileProjectSheet";
import { overviewLiftProject, overviewScreenProject, overviewStackKey, overviewStackScreens } from "./mobile/overviewPhone";
import type { MobileShellHost } from "./mobile/MobileShell";
import { dropPendingSeatConfirmOutside, onOrchestratorDraftRequest } from "./orchestrator/draftPrefill";
import { OrchestratorDock, dockOpenFor, rememberDockOpen } from "./orchestrator/OrchestratorDock";
import { OverviewBoard } from "./OverviewBoard";
import { BarIslandProvider } from "./ProjectBar";
import { GlobalSearch, transcriptFocusHash } from "./search/GlobalSearch";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { isChildConversation, OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail, RAIL_HIDDEN_STORAGE_KEY } from "./ProjectRail";
import { DeploymentStatusPill } from "./runtime/DeploymentStatusPill";
import { StagingBadge } from "./StagingBadge";
import { activityDot, cleanTitle } from "./utils";
import { PRODUCT_NAME } from "@/lib/brand";

const PROJECT_KEY = "llvProject";

/** Reads the location hash into its conversation/file/project intent. Recognises
    the canonical `#c=<conversationId>` deep link alongside the legacy `#f=` /
    `#p=` forms (see parseConversationHash). */
function readHash(): ConversationHash {
  return parseConversationHash(location.hash);
}

export function initialProjectFromState(hash: string, storedProject: string | null): string {
  return parseConversationHash(hash).project ?? storedProject ?? OVERVIEW;
}

export function filesRequestPin(pendingHash: ConversationHash | null, retainedPath: string | null): string | null {
  return pendingHash?.filePath ?? pendingHash?.conversationId ?? retainedPath;
}

/** Every fragment key this app speaks, each with a payload: conversation
    (`#c=`), transcript path (`#f=`), project (`#p=`), artifact preview
    (`#a=`, issue #884 — handled by ArtifactPreviewHost) — plus the empty
    hash, and while the phone layout is up a phone screen (`#task=`,
    `#pipeline=`, `#pipelines`, `#accounts`, #2105), which only the phone
    opens. A pasted URL outside this set means nothing here; quietly landing
    on the default view read as a broken deployment, so the shell says so. */
export function recognizedFragment(hash: string, { phone = false }: { phone?: boolean } = {}): boolean {
  if (hash === "" || /^#(?:c|f|p|a)=./.test(hash)) return true;
  return phone && /^#(?:(?:task|pipeline)=.|(?:pipelines|accounts)$)/.test(hash);
}

export type CatalogPinState = { path: string; hydrated: boolean; conversationId: string | null } | null;
export type CatalogPinEvent =
  | { kind: "open"; path: string; conversationId?: string }
  | { kind: "resolve"; path: string; conversationId?: string }
  | { kind: "release"; path?: string }
  | { kind: "files"; paths: ReadonlySet<string>; pending: boolean; currentPath?: string };

export function reduceCatalogPin(state: CatalogPinState, event: CatalogPinEvent): CatalogPinState {
  if (event.kind === "open") return { path: event.path, hydrated: false, conversationId: event.conversationId ?? null };
  if (event.kind === "resolve") return { path: event.path, hydrated: true, conversationId: event.conversationId ?? null };
  if (event.kind === "release") return !event.path || state?.path === event.path ? null : state;
  if (!state) return state;
  const current = event.currentPath && event.currentPath !== state.path ? { ...state, path: event.currentPath } : state;
  if (current.hydrated && !event.pending && !event.paths.has(current.path)) return null;
  return current;
}

/** The URL a project selection lands on: the project hash, or the bare route
    for the overview. History semantics (push over a focused-card entry, replace
    otherwise) live in `recordProjectNavigation`. */
function projectUrl(project: string): string {
  return project !== OVERVIEW ? "#p=" + encodeURIComponent(project) : location.pathname;
}

/** How long an unresolved conversation intent — a Back/Forward replay (issue
    #866) or a pasted `#c=`/`#f=` deep link — waits for its pinned poll to
    resolve the target before it reports the entry stale: a few poll rounds,
    then the intent clears so the failure is visible and later history actions
    stay usable. */
const STALE_FOCUS_REPLAY_MS = 8_000;

/** How long the unknown-fragment notice stays up before it dismisses itself.
    The stale-conversation notice never self-dismisses: an unresolved deep link
    keeps its visible not-found state until the operator navigates, resolves a
    new target, or dismisses it — a notice that evaporates while the hash stays
    put lands the tab back on the silent default view this fix exists to kill. */
const UNKNOWN_FRAGMENT_NOTICE_MS = 6_000;

const noSubscription = () => () => {};

/* Client-mount gate for everything that reads the browser (#2071, D1). The
   server and the hydration render agree on `false` and draw the boot shell;
   the client re-renders with `true` right after hydrating and mounts the app,
   whose state then starts from the hash and storage instead of from a guess. */
function useMounted(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

/** The storage the first frame reads, or null in private mode. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function Viewer() {
  return useMounted() ? <ViewerApp /> : <BootShell />;
}

function ViewerApp() {
  const { t, locale } = useLocale();
  /* There is no operator credential to claim: same-origin IS the operator (see
     `operatorAuthority`), and no key, secret, cookie or paste exists anywhere in
     this app. This only erases what earlier rounds left on disk — a stored bearer,
     a stale startup fragment. */
  purgeLegacyOperatorCredential();
  /* The one presence publisher for the whole app: it reads the shared view bus
     that the board/scheme/mobile components report into and ships an ephemeral
     per-tab snapshot to the server. Renders nothing. */
  useViewPresence();
  /* This tree only ever renders in the browser (the server draws the boot
     shell), so the first frame already stands on the hash or the stored
     project: no Overview frame before the project, no restore effect. */
  const [project, setProject] = useState<string>(() => initialProjectFromState(location.hash, readStored(PROJECT_KEY)));
  const [pendingHash, setPendingHash] = useState<ConversationHash | null>(() => {
    const initial = readHash();
    return initial.filePath || initial.conversationId ? initial : null;
  });
  const [catalogPin, dispatchCatalogPin] = useReducer(reduceCatalogPin, null);
  const { files: polledFiles, requestScope, projectCatalog: polledProjectCatalog, projectAliases, projectDisplayNames: polledProjectDisplayNames, crownedProjects: serverCrownedProjects, projectCwds, flows: polledFlows, pipelines: polledPipelines, pipelinesError, workflows, tasks, conversationAliases, launchRoutes, workLinks, loaded, cached = false, scopeCertified, catalogFailures, failingSince, lastSuccessAt } = useFiles(null, filesRequestPin(pendingHash, catalogPin?.path ?? null));
  /* A dismissal is drawn the moment a card's Dismiss is clicked: layered over
     the polled rows here, the one place they are read, so the cards, the
     phone's ⚠ count and the queue stop flagging it in the same frame
     (docs/design/needs-attention.md §5). */
  const { files: allFiles, pipelines } = useDismissalOverlay(polledFiles, polledPipelines);
  /* Whether the server answers (#2071 D7): one reading for every surface, from
     the files streak above and the runtime stream; no request of its own. */
  const reach = useDerivedServerReach({ catalogFailures, failingSince, lastSuccessAt });
  /* Crown/create curation (server-durable): the optimistic client seam plus
     the overlay entries for projects created before the next catalog poll. */
  const { crownedProjects, toggleCrown, createProject, createdCatalog } = useProjectCuration(serverCrownedProjects, polledProjectCatalog);
  const projectCatalog = useMemo(
    () => (createdCatalog.length ? [...polledProjectCatalog, ...createdCatalog] : polledProjectCatalog),
    [polledProjectCatalog, createdCatalog],
  );
  const projectDisplayNames = useMemo(() => {
    if (!createdCatalog.length) return polledProjectDisplayNames;
    const merged = { ...polledProjectDisplayNames };
    for (const entry of createdCatalog) {
      if (entry.displayName) merged[entry.project] = entry.displayName;
    }
    return merged;
  }, [polledProjectDisplayNames, createdCatalog]);
  /* A committed account migration keeps the archived predecessor entry in the
     payload (for chain history) but it must never render as a second standalone
     card — every surface below sees only current generations. A no-op (same
     array identity) until something actually migrates.

     One carve-out: a `#c=`/`#f=` deep link can resolve to an archived
     predecessor that is the ONLY generation of its conversation in the payload
     (the successor transcript sits beyond the capped feed). Folding that row
     out left the pinned open with nothing to render — the board had no node
     for the focused path and the link silently opened nothing. Keeping the one
     pinned row cannot duplicate a card, and the moment a current generation
     arrives the pin retargets to it (see the catalog-pin files effect) and the
     predecessor folds away again. */
  const files = useMemo(() => {
    const folded = withoutArchivedPredecessors(allFiles);
    const pinnedPath = catalogPin?.path;
    if (!pinnedPath || folded.some((file) => file.path === pinnedPath)) return folded;
    const pinned = allFiles.find((file) => file.path === pinnedPath);
    if (!pinned || !isArchivedPredecessor(pinned)) return folded;
    const currentGenerationPresent = Boolean(pinned.conversationId)
      && folded.some((file) => file.conversationId === pinned.conversationId);
    return currentGenerationPresent ? folded : [...folded, pinned];
  }, [allFiles, catalogPin]);
  const isMobile = useIsMobile();
  /* The phone's Overview is a board under a stack (#2098): a card opens its
     task, its pipeline or its conversation as a screen over it, and that
     screen is drawn by its own project's dashboard while the Overview stays
     the Viewer's project, so ‹ lands back on the Overview's columns. The
     screen on top names the project (or the one under it does, for a screen
     that names none); a poll that briefly misses it keeps the project it
     named last, for the same stack. */
  const mobileNav = useMobileNavStore();
  const stackedKey = useSyncExternalStore(mobileNav.subscribe, () => overviewStackKey(mobileNav.getState().stack), () => null);
  const liftKey = isMobile && project === OVERVIEW ? stackedKey : null;
  /* Each conversation opened over the Overview, with its project as the open
     knew it, so its screen is drawn before the poll carries its file. */
  const [openedOverOverview, setOpenedOverOverview] = useState<ReadonlyMap<string, string>>(() => new Map());
  const liftFound = overviewLiftProject(overviewStackScreens(liftKey), { tasks, pipelines, files: allFiles, conversationProjects: openedOverOverview });
  const liftFoundProject = liftFound ? canonicalClientProject(liftFound, projectAliases) : null;
  const [liftMemo, setLiftMemo] = useState<{ key: string; project: string } | null>(null);
  if (liftKey && liftFoundProject && (liftMemo?.key !== liftKey || liftMemo.project !== liftFoundProject)) {
    setLiftMemo({ key: liftKey, project: liftFoundProject });
  }
  const liftedProject = liftFoundProject ?? (liftKey && liftMemo?.key === liftKey ? liftMemo.project : null);
  /* The project the dashboard draws: the Viewer's own, or the one a screen
     over the phone's Overview belongs to. */
  const dashboardProject = liftedProject ?? project;
  /* Whether the phone's Overview is up: a conversation that lands there opens
     over it as a screen. Read from listeners, so it is kept in a ref. */
  const overviewPhoneRef = useRef(false);
  useEffect(() => {
    overviewPhoneRef.current = isMobile && project === OVERVIEW;
  }, [isMobile, project]);

  /* On the phone its navigation store owns the history (#2105): every screen
     and every sheet is one entry, standing on its own URL and naming the
     project it was written on. The store asks here, at the moment it writes,
     for the project, the board's URL and a conversation's link and typed
     identity; the values are read through a ref kept current by every render,
     because a screen is often pushed from an effect in the very commit that
     changed the project. */
  const phoneRef = useRef({ mobile: isMobile, project, files: allFiles });
  phoneRef.current = { mobile: isMobile, project, files: allFiles };
  const phoneConfig = useMemo<MobileNavConfig>(() => ({
    project: () => phoneRef.current.project,
    boardUrl: () => (phoneRef.current.project !== OVERVIEW ? "#p=" + encodeURIComponent(phoneRef.current.project) : location.pathname + location.search),
    conversation: (id) => {
      const file = phoneRef.current.files.find((entry) => entry.path === id);
      if (!file) return null;
      return { url: formatConversationHash(file), keys: { [FOCUS_HISTORY_STATE_KEY]: focusEntryFor(file, projectKey(file)) } };
    },
  }), []);
  /* Configured during render, before any screen under this one mounts and
     writes its first entry. */
  mobileNav.configure(isMobile ? phoneConfig : null);
  useEffect(() => {
    if (!isMobile) return;
    /* The Viewer's own records go through the store: a focus types the
       conversation's entry, a project selection is one board entry. */
    return setFocusHistoryOwner({
      focus: (entry, state, url) => mobileNav.mark({ path: entry.path ?? "", keys: state, url }),
      project: (url) => mobileNav.enterProject(parseConversationHash(url.includes("#") ? url.slice(url.indexOf("#")) : "").project ?? OVERVIEW, url),
      retarget: (renamed, state, url) => mobileNav.retargetProject(renamed, state, url),
    });
  }, [isMobile, mobileNav]);
  /* A phone screen's own link opened in a fresh tab (`#task=`, `#pipeline=`)
     can name a task or a lane of another project than the one this browser
     showed last: that project draws it, and its entry says so. A traversal
     restores the project its entry names, so this only ever meets a link. */
  const phoneTopKey = useSyncExternalStore(mobileNav.subscribe, () => screenKey(topScreen(mobileNav.getState())), () => "board");
  useEffect(() => {
    if (!isMobile || project === OVERVIEW) return;
    const [top] = overviewStackScreens(phoneTopKey);
    if (top?.kind !== "task" && top?.kind !== "pipeline") return;
    const owner = overviewScreenProject(top, { tasks, pipelines, files: allFiles });
    if (!owner || owner === project) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- a link names the project, once */
    setProject(owner);
    localStorage.setItem(PROJECT_KEY, owner);
    mobileNav.retargetProject(owner, null, location.href);
  }, [isMobile, project, phoneTopKey, tasks, pipelines, allFiles, mobileNav]);
  const dashboardFilesRef = useRef<{ project: string; files: FileEntry[] } | null>(null);
  const dashboardFiles = useMemo(() => {
    if (dashboardProject === OVERVIEW) return [];
    const selected = files.filter((file) => projectKey(file) === dashboardProject);
    const previous = dashboardFilesRef.current;
    const stable = previous?.project === dashboardProject
      && previous.files.length === selected.length
      && selected.every((file, index) => file === previous.files[index])
      ? previous.files
      : selected;
    dashboardFilesRef.current = { project: dashboardProject, files: stable };
    return stable;
  }, [files, dashboardProject]);
  /* Every certified answer refreshes the names this browser remembers, so
     the next cold start names the project before its first answer (#2071). */
  useEffect(() => {
    if (loaded) rememberProjectNames(polledProjectDisplayNames);
  }, [loaded, polledProjectDisplayNames]);
  useEffect(() => {
    publishConversationAvailability(new Set(allFiles.flatMap((file) => file.conversationId ? [file.conversationId] : [])));
  }, [allFiles]);
  /* This tab's optimistic flow closes apply before anything renders: the X
     on a flow strip clears the reviewer side of the scheme instantly. */
  const flows = useEffectiveFlows(polledFlows);
  /* A stand-in served for a scope still loading (#1432) is not scanned for
     chimes: it is the last certified payload under a new label, and scanning
     it would let the pinned answer's hydrated rows ring instead of seeding. */
  useAgentChimes(files, requestScope, scopeCertified);
  const { archivedProjects, archiveProject, unarchiveProject } = useArchivedProjects(files, projectAliases);
  const catalogProjects = useMemo(() => new Set(projectCatalog.map((entry) => entry.project)), [projectCatalog]);
  /* The setup guide's Project step offers the projects the rail lists, the
     most recently active first, with the folder each one's orchestrator would
     work in; archived ones are left out (#1876 slice 3, #2166 §3.2). */
  const guideProjects = useMemo(() => projectCatalog
    .filter((entry) => !archivedProjects.has(entry.project))
    .sort((a, b) => b.smt - a.smt)
    .map((entry) => ({
      project: entry.project,
      name: projectDisplayName(entry.project, projectDisplayNames[entry.project] ?? entry.displayName),
      cwd: projectCwds[entry.project] ?? entry.projectRoot ?? null,
      conversations: entry.conversations,
    })),
  [projectCatalog, archivedProjects, projectDisplayNames, projectCwds]);
  const catalogConversationCounts = useMemo(
    () => new Map(projectCatalog.map((entry) => [entry.project, entry.conversations])),
    [projectCatalog],
  );
  /* The per-project orchestrator dock (PRD #976 slice A). Its open state is the
     operator's and belongs to the PROJECT (#1149), exactly as the dock's width
     does (#1011): the server render and the first client render agree on
     «closed» (the Overview, which has no dock), and every project that comes
     after answers for itself in the render below. */
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  /* The project the open state above was read for. A switch re-reads during
     render, so the dock the operator closed in one project stays closed there
     and nowhere else, with no frame of the previous project's answer. */
  const [orchestratorOpenProject, setOrchestratorOpenProject] = useState(OVERVIEW);
  /* The kanban face seats the orchestrator above its own columns (#1695 K3);
     the dock stays closed under it so one conversation has one composer. The
     desktop board is the kanban, so the dock waits until the dashboard says a
     project shows something else: the panel mounts once, where it is shown. */
  const [kanbanFace, setKanbanFace] = useState(true);
  if (orchestratorOpenProject !== project) {
    setOrchestratorOpenProject(project);
    setOrchestratorOpen(dockOpenFor(project));
  }
  /* The ONE global message search (issue #1054). It is shell state, not board
     state: the same overlay answers from the overview, from any project and on
     the phone, and it unmounts on close so every open starts on «my messages»
     with an empty query. */
  const [searchOpen, setSearchOpen] = useState(false);
  /* On the phone the palette covers the screen like any sheet, so it is one
     history entry and Back closes it (#2105). */
  const phoneSheet = useSyncExternalStore(mobileNav.subscribe, () => mobileNav.getState().sheet, () => null);
  const openSearch = useCallback(() => {
    if (phoneRef.current.mobile) mobileNav.openSheet("search");
    else setSearchOpen(true);
  }, [mobileNav]);
  const closeSearch = useCallback(() => {
    if (phoneRef.current.mobile) mobileNav.closeSheet();
    else setSearchOpen(false);
  }, [mobileNav]);
  const [toastPath, setToastPath] = useState<string | null>(null);
  const seenQuestionsRef = useRef<Set<string> | null>(null);
  /* Reopening a file whose project is already selected does not change
     `project`, so ProjectDashboard would never remount or re-read prefs.
     Bumping this on every same-project open gives it an explicit signal. */
  const [openNonce, setOpenNonce] = useState(0);
  /* The jump channel into the board: nonce so repeated jumps to the same node
     re-flash (D9); consumed by ProjectDashboard's pendingFocusRef path. */
  const [focusRequest, setFocusRequest] = useState<{ path: string; nonce: number; catalog: boolean } | null>(null);
  /* Monotonic across the whole session, never derived from the previous
     request: a project switch clears the request to null, and a nonce read
     back from `null` restarted at 1 — the value the board's edge gate had
     already consumed for the last focus in the previous project — so the
     first cross-project open after any focus moved nothing (#1432). */
  const focusNonceRef = useRef(0);
  /* Placement without navigation — see `placePath` below. Its own state and its
     own nonce, so a place and a focus can never consume each other's edge. */
  const [placeRequest, setPlaceRequest] = useState<{ path: string; nonce: number } | null>(null);
  /* A Back/Forward replay whose target never resolved (issue #866): the entry
     is stale — deleted, purged, or beyond this machine. Fails visibly, then the
     rest of the history stays usable. */
  const [staleFocusNotice, setStaleFocusNotice] = useState(false);
  /* A pasted URL whose fragment the app cannot interpret (issue #884): name
     the failure instead of quietly showing the default view. */
  const [unknownFragmentNotice, setUnknownFragmentNotice] = useState(() => !recognizedFragment(location.hash, { phone: isMobile }));
  /* Mirrors for the popstate replay path, which must read the latest values
     from stable event listeners without re-registering them per poll. */
  const filesRef = useRef<FileEntry[]>([]);
  const pendingHashRef = useRef<ConversationHash | null>(null);
  const staleTimerRef = useRef<number | null>(null);
  /* One history traversal fires `popstate` first, then `hashchange`. When the
     popstate half already replayed a typed focus entry, the hashchange half of
     that SAME traversal must not re-derive a weaker intent from the bare hash.
     Keyed to the traversal's target hash and self-clearing, so a same-URL
     multi-entry jump (which fires no hashchange) cannot leave a stale arm that
     swallows the next genuine hashchange — see `createTraversalFence`. */
  const traversalFenceRef = useRef(createTraversalFence());
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    pendingHashRef.current = pendingHash;
  }, [pendingHash]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const canonical = canonicalClientProject(project, projectAliases);
    if (canonical === project) return;
    setProject(canonical);
    localStorage.setItem(PROJECT_KEY, canonical);
    /* A rename, not a navigation: a typed focus entry keeps its place in the
       history stack and only re-labels its stored project. */
    retargetRecordedProject(canonical, projectUrl(canonical));
  }, [project, projectAliases]);

  useEffect(() => {
    const onHash = () => {
      /* The popstate half of this same traversal already replayed a typed
         focus entry with its full stored identity; deriving a second, weaker
         intent from the bare hash would drop the project and path support. */
      if (traversalFenceRef.current.swallows(location.hash)) return;
      /* A traversal onto an entry the phone wrote (#2105): its popstate half
         already restored the place and the project the entry names, and a
         screen's own URL never opens anything else. A conversation link on an
         entry whose screen is not that conversation is not the operator's to
         follow — it is how Back from a task's agent once reopened the
         orchestrator. */
      const phone = phoneRef.current.mobile && standsOnOwnUrl(window.history.state, location.href) ? readMobileNavEntry(window.history.state) : null;
      if (phone) {
        setStaleFocusNotice(false);
        if (topScreen(phone).kind !== "chat") {
          setPendingHash(null);
          dispatchCatalogPin({ kind: "release" });
          setFocusRequest(null);
          return;
        }
      }
      /* Navigation is one of the two exits a durable not-found notice has
         (the other is its dismiss button): a new attempt starts clean. */
      setStaleFocusNotice(false);
      const next = readHash();
      if (next.filePath || next.conversationId) {
        dispatchCatalogPin({ kind: "release" });
        setFocusRequest(null);
        setPendingHash(next);
      }
      else {
        /* Navigation moved off the conversation link: the old target must
           stop pinning polls and must not open later out of nowhere. */
        setPendingHash(null);
        dispatchCatalogPin({ kind: "release" });
        setFocusRequest(null);
        if (next.project) setProject(next.project);
        /* Back cleared the hash entirely: that entry was the overview. */
        else if (!location.hash) setProject(OVERVIEW);
      }
      if (!recognizedFragment(location.hash, { phone: phoneRef.current.mobile })) setUnknownFragmentNotice(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* Browser/mouse Back and Forward (issue #866): a typed entry replays through
     the SAME bounded resolver a live deep link uses — pendingHash pins the
     target into the ongoing poll, `resolveConversationTarget` resolves by
     stable conversation id (aliases, migrations, launch routes included), and
     `openPinnedFile` moves the existing camera. No reload, no route remount,
     no board rebuild, no snapshot: this handler only sets the two states the
     hashchange path already sets. Untyped entries fall through to it. */
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      /* On the phone the store reads the entry first (the same reading its
         own listener gets): the place, and the project it was written on,
         which comes back with it — the Overview included (#2098, #2105). */
      const landing = phoneRef.current.mobile ? mobileNav.land(event.state, event) : null;
      /* An entry a ‹ passes through on its way to the screen under the one
         it left: nothing is drawn from it, so nothing of it replays, and its
         own hashchange is skipped. */
      if (landing?.kind === "passing") {
        traversalFenceRef.current.arm(location.hash);
        return;
      }
      const phone = landing?.kind === "phone" ? landing : null;
      const phoneProject = phone?.entry.project ?? null;
      const projectMoved = phoneProject !== null && phoneProject !== phoneRef.current.project;
      if (projectMoved) {
        setProject(phoneProject);
        localStorage.setItem(PROJECT_KEY, phoneProject);
      }
      const entry = parseFocusHistoryState(event.state);
      if (!entry) return;
      /* The browser has already applied this traversal's URL, so the fragment
         read here is exactly the hash whose follow-up hashchange must skip. */
      traversalFenceRef.current.arm(location.hash);
      /* A phone entry replays its conversation only when that conversation is
         what the traversal brought on screen: a sheet closed over it, or a
         pop the store made itself, has nothing to resolve. */
      if (phone && (topScreen(phone.entry).kind !== "chat" || (!phone.topChanged && !projectMoved))) return;
      setStaleFocusNotice(false);
      dispatchCatalogPin({ kind: "release" });
      setFocusRequest(null);
      /* Cross-project entries select the stored project first, then resolve.
         A phone entry already selected the one it was written on. */
      if (!phone) {
        setProject(entry.project);
        localStorage.setItem(PROJECT_KEY, entry.project);
      }
      const intent: ConversationHash = entry.conversationId
        ? { conversationId: entry.conversationId, filePath: null, project: entry.project }
        : { conversationId: null, filePath: entry.path, project: entry.project };
      setPendingHash(intent);
      /* A replay target the polls cannot produce is stale: report it and free
         the stack instead of pinning a dead intent forever. */
      if (staleTimerRef.current !== null) window.clearTimeout(staleTimerRef.current);
      staleTimerRef.current = window.setTimeout(() => {
        staleTimerRef.current = null;
        const pending = pendingHashRef.current;
        if (!pending) return;
        if ((pending.conversationId ?? pending.filePath) !== (intent.conversationId ?? intent.filePath)) return;
        setPendingHash(null);
        dispatchCatalogPin({ kind: "release" });
        setStaleFocusNotice(true);
      }, STALE_FOCUS_REPLAY_MS);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (staleTimerRef.current !== null) window.clearTimeout(staleTimerRef.current);
    };
  }, [mobileNav]);

  useEffect(() => {
    if (!unknownFragmentNotice) return;
    const timer = window.setTimeout(() => setUnknownFragmentNotice(false), UNKNOWN_FRAGMENT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [unknownFragmentNotice]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* The state half of a project selection, shared by routes that write their
     own history entry (a card focus records `#c=`, which already names the
     project) and routes that record a plain project navigation. */
  const applyProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    /* Explicit project navigation replaces the hash without a hashchange
       event, so any unresolved conversation intent is cancelled here — and a
       deliberate navigation retires the durable not-found notice. */
    setStaleFocusNotice(false);
    setPendingHash(null);
    dispatchCatalogPin({ kind: "release" });
    setFocusRequest(null);
    localStorage.setItem(PROJECT_KEY, nextProject);
    /* The phone shell lands on the board with no sheet open (mobile v2 §3.3),
       and an entry written in this same gesture names the project it is now
       drawn in, before the render that takes the new project (#2105). */
    phoneRef.current = { ...phoneRef.current, project: nextProject };
    getMobileNav().home();
  }, []);

  const selectProject = useCallback((nextProject: string) => {
    applyProject(nextProject);
    recordProjectNavigation(projectUrl(nextProject));
  }, [applyProject]);

  /* A phone screen of another project, from a link (#2105): a task or a lane a
     message names. Over the Overview it goes on the stack like any screen, and
     its own project's dashboard draws it. On a project's board that project
     becomes the one drawn, with no entry of its own, and the screen is the one
     entry the link writes: Back returns to the place the operator left, in its
     own project. */
  const openPhoneScreenElsewhere = useCallback((screen: MobileScreen, target: string) => {
    if (phoneRef.current.project !== OVERVIEW) applyProject(target);
    mobileNav.push(screen);
  }, [applyProject, mobileNav]);

  /* Opening or closing the dock is a statement about THIS project (#1149): it
     is remembered under the project's own key, so the projects the operator is
     not looking at keep the dock exactly as they had it. */
  const toggleOrchestrator = useCallback(() => {
    setOrchestratorOpen((open) => {
      const next = !open;
      rememberDockOpen(project, next);
      return next;
    });
  }, [project]);

  /* The setup guide hands the operator to a project's orchestrator draft
     (#1876 slice 3, #2166 §3.3): open the project on its Board with its seat
     expanded. The draft itself takes the prefill and the pending confirm; the
     dashboard takes the Board; the phone's seat card opens its own sheet. */
  useEffect(() => onOrchestratorDraftRequest((request) => {
    selectProject(request.project);
    if (isMobile) return;
    expandKanbanSeat(request.project);
    rememberDockOpen(request.project, true);
    setOrchestratorOpenProject(request.project);
    setOrchestratorOpen(true);
  }), [isMobile, selectProject]);
  /* A confirm the guide asked for belongs to the project it named: moving to
     another one drops it, so a later visit designates nothing by itself. */
  useEffect(() => dropPendingSeatConfirmOutside(project), [project]);

  /* The whole rail goes away behind one control (issue #1819): while a stream
     is watching, no project name, count, limit or account name may be on the
     screen at all. Hidden means UNMOUNTED — the rail's footers stop fetching
     with it — and the choice is this browser's, read on the first client
     frame (the server draws the boot shell, which reads it too). A missing or
     unreadable value means shown. */
  const [railHidden, setRailHidden] = useState(() => readStored(RAIL_HIDDEN_STORAGE_KEY) === "hidden");
  const toggleRail = useCallback(() => {
    setRailHidden((hidden) => {
      const next = !hidden;
      try {
        window.localStorage.setItem(RAIL_HIDDEN_STORAGE_KEY, next ? "hidden" : "shown");
      } catch {
        /* private mode: the choice holds for this page only */
      }
      return next;
    });
  }, []);

  /* The overview board has no project view state to report: presence publishes
     the overview context/slice here, and ProjectDashboard takes over the moment
     a project opens. */
  useEffect(() => {
    /* A screen over the phone's Overview is its project's dashboard, which
       reports itself; the Overview reports again once ‹ brings it back. */
    if (project !== OVERVIEW || liftedProject) return;
    viewBus.reportContext(OVERVIEW_CONTEXT);
    viewBus.reportSlice(OVERVIEW_SLICE);
  }, [project, liftedProject]);

  /* A tapped account badge (issue #229) opens the accounts surface. On the
     phone the limits blocks live on the shell's Accounts & limits screen
     (mobile v2 lane 1), so the request pushes that screen first; its
     per-engine block then claims the retained request on mount. */
  useEffect(() => {
    if (!isMobile) return;
    return onAccountPanelRequest(() => getMobileNav().push({ kind: "accounts" }));
  }, [isMobile]);

  /* A file open (overview card, deep link) becomes a column of its project.
     One deliberate gesture, one typed history entry: the card focus record
     carries the project, so no separate project entry is written. */
  const openFile = useCallback(
    (file: FileEntry) => {
      const key = projectKey(file);
      queueColumnOpen(key, file.path, isChildConversation(file));
      applyProject(key);
      recordFocusNavigation(file, key);
      setOpenNonce((value) => value + 1);
    },
    [applyProject],
  );

  /* A conversation opened over the phone's Overview (#2098): a card's row,
     its sheet's «Open first agent», the ⚠ sheet, an arrival, an in-app link,
     a search result, and a replay of any of those. It is a SCREEN pushed onto
     the stack the operator is on,
     full screen and never inside a card, and its own project's dashboard
     draws it (see `liftedProject`), so ‹ lands on the screen under it and in
     the end on the Overview. The screen's entry carries the conversation's
     link and typed identity (the store writes both, #2105); the focus request
     is what puts the conversation on its project's board for the screen to
     show. */
  const openOverOverview = useCallback((file: FileEntry, { catalog = false }: { catalog?: boolean } = {}) => {
    const nav = mobileNav;
    const onTop = topScreen(nav.getState());
    const fileProject = projectKey(file);
    setOpenedOverOverview((known) => (known.get(file.path) === fileProject ? known : new Map(known).set(file.path, fileProject)));
    recordFocusNavigation(file, fileProject, { restore: true });
    if (onTop.kind !== "chat" || onTop.id !== file.path) nav.push({ kind: "chat", id: file.path });
    setPendingHash(null);
    setStaleFocusNotice(false);
    focusNonceRef.current += 1;
    setFocusRequest({ path: file.path, nonce: focusNonceRef.current, catalog });
  }, [mobileNav]);

  /* Full-catalog list/search rows can sit beyond the scheme window. Their path
     stays pinned for the displayed conversation so recurring polls preserve
     the node after the transient hash intent resolves. */
  const openPinnedFile = useCallback((file: FileEntry, hydrated = false) => {
    /* On the phone's Overview every landing (a replay, a search result, a
       pasted link, a catalog row) opens the conversation as a screen over it
       and keeps the Overview, so ‹ comes back to it (#2098). */
    if (overviewPhoneRef.current) {
      setStaleFocusNotice(false);
      dispatchCatalogPin({ kind: hydrated ? "resolve" : "open", path: file.path, conversationId: file.conversationId });
      openOverOverview(file, { catalog: true });
      return;
    }
    const key = projectKey(file);
    /* A resolution landing is the third exit for the not-found notice: the
       viewer is now showing a conversation, so the failure claim is over. */
    setStaleFocusNotice(false);
    queueColumnOpen(key, file.path, isChildConversation(file));
    dispatchCatalogPin({ kind: hydrated ? "resolve" : "open", path: file.path, conversationId: file.conversationId });
    setProject(key);
    localStorage.setItem(PROJECT_KEY, key);
    setOpenNonce((value) => value + 1);
    focusNonceRef.current += 1;
    setFocusRequest({ path: file.path, nonce: focusNonceRef.current, catalog: true });
    /* A hydrated open is the RESOLVER arriving (deep link, hashchange,
       popstate replay): it re-types the entry the tab is standing on and never
       pushes, so initial restoration adds no duplicate and a replay cannot
       loop. A direct catalog click records the deliberate navigation. On the
       phone the conversation's own screen is its entry, pushed over the place
       the operator is (#2105); one in another project goes over that
       project's board, and the entry the operator left stays under it. */
    if (phoneRef.current.mobile && key !== phoneRef.current.project) getMobileNav().home();
    recordFocusNavigation(file, key, { restore: hydrated });
  }, [openOverOverview]);

  const openCatalogFile = useCallback((file: FileEntry) => {
    openPinnedFile(file);
    const hash = formatConversationHash(file);
    setPendingHash(parseConversationHash(hash));
  }, [openPinnedFile]);

  /* Opening a global-search result (issue #1054). A selection carries only the
     transcript path, so it enters the SAME resolver a deep link uses: the hash
     assignment records the history entry and its hashchange drives resolution.
     But the tab can already be standing on that exact `#f=` while the
     conversation is NOT on screen, because plenty happens here without touching
     the hash — the transcript ages out of the capped feed, the card is closed,
     the board switches to List view. Assigning an unchanged hash fires no
     hashchange, so in that case the intent is set directly; without it the
     palette closed over a selection that never reopened, and "find, open,
     continue" stopped at find. */
  const openSearchResult = useCallback((transcriptPath: string) => {
    const hash = transcriptFocusHash(transcriptPath);
    /* On the phone the conversation's screen writes its own entry over the
       place the palette was opened on (#2105); a hash of its own under that
       screen would be a second entry for one open. */
    if (location.hash !== hash && !phoneRef.current.mobile) {
      location.hash = hash;
      return;
    }
    setStaleFocusNotice(false);
    dispatchCatalogPin({ kind: "release" });
    setFocusRequest(null);
    setPendingHash(parseConversationHash(hash));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingHash || allFiles.length === 0) return;
    /* Resolves against the UNFILTERED payload (finding 6): a legacy `#f=` path
       may point at an archived predecessor, which `withoutArchivedPredecessors`
       has already folded out of `files`. Resolving against `allFiles` keeps that
       predecessor visible long enough to redirect the link to its current
       generation; the canonical `#c=` id resolves the same way. */
    const hit = resolveConversationTarget(allFiles, pendingHash, conversationAliases, launchRoutes);
    /* A miss keeps the request pending: the pinned `path` param asks the
       scanner to include the exact transcript on the next poll, so a fresh
       `#f=` link to a demoted archived predecessor resolves once that poll
       lands instead of being cleared after the first cap-limited payload. */
    if (hit) {
      openPinnedFile(hit, true);
      setPendingHash(null);
    }
  }, [pendingHash, allFiles, conversationAliases, launchRoutes, openPinnedFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* A deep-link intent no payload resolves (the id is absent from the corpus
     and from its own pinned request) must FAIL VISIBLY: sitting silently on the
     default view read as "the page just reloads and nothing opens". Same
     bounded deadline the Back/Forward replay uses; the countdown starts only
     once a payload certified for the pinned request scope exists, and a
     resolution clearing `pendingHash` cancels it. The last-known stand-in
     another scope lends while the pinned fetch is in flight (#1432) carries
     `loaded` and says nothing about the target, so it must not start the
     clock: a pinned fetch slower than the deadline would otherwise be reported
     stale before it could answer. The popstate path arms its own
     identity-checked timer — for a replayed entry both reach the same notice. */
  useEffect(() => {
    if (!pendingHash || !loaded || !scopeCertified) return;
    const timer = window.setTimeout(() => {
      setPendingHash(null);
      dispatchCatalogPin({ kind: "release" });
      setStaleFocusNotice(true);
    }, STALE_FOCUS_REPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingHash, loaded, scopeCertified]);

  const releaseCatalogFile = useCallback((path: string) => {
    dispatchCatalogPin({ kind: "release", path });
    setFocusRequest((current) => current?.path === path ? null : current);
    if (catalogPin?.path === path) recordProjectNavigation(projectUrl(project));
  }, [catalogPin, project]);

  useEffect(() => {
    if (!catalogPin?.hydrated || pendingHash) return;
    /* A scope transition (the pin just moved to a new request URL) is served
       by the previous scope's rows until its own fetch lands (#1432). That
       stand-in is not evidence the transcript disappeared — releasing the
       hydrated pin on it dropped every freshly resolved beyond-cap deep link
       right after it opened. Only a payload certified for THIS scope may
       retire the pin. */
    if (!loaded || !scopeCertified) return;
    const currentPath = catalogPin.conversationId
      ? files.find((file) => file.conversationId === catalogPin.conversationId)?.path
      : undefined;
    dispatchCatalogPin({
      kind: "files",
      paths: new Set(allFiles.map((file) => file.path)),
      pending: false,
      currentPath,
    });
  }, [catalogPin, pendingHash, allFiles, files, loaded, scopeCertified]);

  /* The one queue every counter shows: badge, popover and the tab title all
     read the same list, stalled tail included (D10). The clock advances at the
     nearest expiry of any kind — a stalled entry crossing its 2h TTL, an
     orchestrator's bridge ask crossing its own (#1168): useFiles keeps the
     array identity while the /api/files body is unchanged, and a cached
     projection does not move when a report merely gets old, so without this
     tick an expired item would sit in the badge until an unrelated change. */
  const [clock, setClock] = useState(() => Date.now() / 1000);
  /* A lane closed from the board is gone from its queue from the tap until its
     close is answered (#1671), so the badge stops counting it on the same tap
     that took the row away. */
  const closingPipelines = useClosingPipelines();
  /* The lanes parked on the operator ride in the same list as the
     conversations (#2129): the island's number, its popover and its «Next ›»,
     and the phone's ⚠ badge, all read `needsYou`, so the header counts the
     lanes the cards and the columns already mark, and a lane dismissed on its
     card leaves every count at once. */
  const needsYou = useMemo(() => buildNeedsYouQueue(files, pipelines, clock, closingPipelines), [files, pipelines, clock, closingPipelines]);
  useEffect(() => {
    const expiries = attentionExpiries(files).filter((at) => at > clock);
    if (!expiries.length) return;
    const delay = Math.max(0, (Math.min(...expiries) - Date.now() / 1000) * 1000) + 500;
    const timer = window.setTimeout(() => setClock(Date.now() / 1000), delay);
    return () => window.clearTimeout(timer);
  }, [files, clock]);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement | null>(null);

  /* Crown favorites pinned atop the «Чекають» popover (issue #224): the same
     durable board prefs the dashboard reads, scoped to the current project so
     the section mirrors the pinned scheme row. The overview has no board, so it
     lists nothing. */
  const favoritesBoard = useBoardState(project === OVERVIEW ? null : project);
  const favoriteRows = useMemo(
    () => (project === OVERVIEW ? [] : resolveFavoriteRows(files, favoritesBoard.prefs.favorites).filter((row) => row.project === project)),
    [files, favoritesBoard.prefs.favorites, project],
  );

  useEffect(() => {
    document.title = needsYou.length ? `(${needsYou.length}) ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [needsYou.length]);

  useEffect(() => {
    if (!queueOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!queueRef.current?.contains(event.target as Node)) setQueueOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [queueOpen]);

  /* «Show only needs me» filter: React-only state that auto-disables once no
     conversation waits (below, beside the paths it keeps lit) — a filter
     surviving reload would silently gray the whole board (D6). The popover
     closes when the queue empties. Desktop-only, like the F key: the mobile
     strip and map render without the dimming channel, so the funnel stays
     hidden there and the state clears if the viewport shrinks into the phone
     layout mid-session. */
  const [attentionFilter, setAttentionFilter] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isMobile) setAttentionFilter(false);
  }, [isMobile]);
  useEffect(() => {
    if (needsYou.length) return;
    setQueueOpen(false);
  }, [needsYou.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const cancelPendingIntent = useCallback(() => setPendingHash(null), []);
  const requestFocus = useCallback((path: string) => {
    /* A user-driven focus (N/Shift-N cycle, attention jump) supersedes any
       unresolved deep-link intent; a stale pin must never re-steal focus when
       its target shows up in a later poll. */
    setPendingHash(null);
    /* On the phone a focus opens the conversation's screen over the place the
       operator is (#2105), so Back returns there: an attention jump, an
       accepted handoff and an in-app link each push one entry. */
    /* Every route through here is a deliberate focus (attention jump, crown
       favorite, N-cycle, an accepted handoff's `openPath`): record it. A path
       with no scanned entry still navigates, it just leaves no history. */
    const file = filesRef.current.find((entry) => entry.path === path);
    if (file) recordFocusNavigation(file, projectKey(file));
    focusNonceRef.current += 1;
    setFocusRequest({ path, nonce: focusNonceRef.current, catalog: false });
  }, []);

  /* A focus request outlives the screen it was for; the next dashboard to
     mount over the Overview must not replay it. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the screen that asked is gone */
    if (project === OVERVIEW && !liftedProject) setFocusRequest(null);
  }, [project, liftedProject]);

  /* In-app conversation links (#1432 addendum): «Open conversation» chips on
     MCP call cards, «Open it on the board» in the orchestrator panel, the
     lineage chip on a card, a report row — every one is an `#c=` / `#f=`
     anchor. Left to the browser, the click became a hash navigation and the
     resolver's pinned round trip, which blanked and rebuilt the board. A
     target the tab already knows is opened here instead, in the same tick as
     the click, through the SAME hand-off an accepted `request_attention`
     handoff and an attention jump use: switch the project only when the
     target lives elsewhere, then `requestFocus` — the card materializes on
     the board it is already showing, the camera glides, the ring lands, and
     the typed history entry is PUSHED (the URL still carries the link for
     reload and share). No hash navigation, no pinned refetch, no remount of
     the dashboard or the orchestrator panel. A target the current payload
     cannot name — beyond the capped feed, or not scanned yet — falls through
     to the browser, and the cold resolver path handles it exactly as before. */
  const openLinkedFile = useCallback((file: FileEntry) => {
    /* Over the phone's Overview a link opens its conversation over it (#2098). */
    if (overviewPhoneRef.current) {
      openOverOverview(file);
      return;
    }
    const key = projectKey(file);
    if (key !== project) applyProject(key);
    requestFocus(file.path);
  }, [project, applyProject, requestFocus, openOverOverview]);
  const linkResolveRef = useRef({ allFiles, conversationAliases, launchRoutes });
  useEffect(() => {
    linkResolveRef.current = { allFiles, conversationAliases, launchRoutes };
  }, [allFiles, conversationAliases, launchRoutes]);
  /* On the phone every in-app conversation link opens through the store
     (#2105), whether or not the tab knows its target yet: a known one opens in
     place, and one beyond the payload goes to the resolver as a pinned intent,
     the way a search result does — never through a hash of its own, which
     would be a history entry the store did not write (a sheet closed by the
     same tap would stay under it). */
  const openConversationIntent = useCallback((intent: ConversationHash) => {
    const known = linkResolveRef.current;
    const hit = resolveConversationTarget(known.allFiles, intent, known.conversationAliases, known.launchRoutes);
    if (hit) {
      openLinkedFile(hit);
      return;
    }
    setStaleFocusNotice(false);
    dispatchCatalogPin({ kind: "release" });
    setFocusRequest(null);
    setPendingHash(intent);
  }, [openLinkedFile]);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^#(?:c|f)=./.test(href)) return;
      const windowTarget = anchor.getAttribute("target");
      if (windowTarget && windowTarget !== "_self") return;
      const intent = parseConversationHash(href);
      if (phoneRef.current.mobile && (intent.conversationId || intent.filePath)) {
        event.preventDefault();
        openConversationIntent(intent);
        return;
      }
      const known = linkResolveRef.current;
      const hit = resolveConversationTarget(known.allFiles, intent, known.conversationAliases, known.launchRoutes);
      if (!hit) return;
      event.preventDefault();
      openLinkedFile(hit);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openLinkedFile, openConversationIntent]);
  /* A component that navigates by the app's own fragment (a menu row, a
     banner, a project's archive) asks through `navigateToFragment`; on the
     phone that is served here, so the store writes the one entry (#2105). */
  useEffect(() => {
    if (!isMobile) return;
    return setFragmentNavigator((hash) => {
      const intent = parseConversationHash(hash);
      if (intent.conversationId || intent.filePath) {
        openConversationIntent(intent);
        return true;
      }
      if (intent.project) {
        selectProject(intent.project);
        return true;
      }
      return false;
    });
  }, [isMobile, openConversationIntent, selectProject]);
  /* A notification the operator tapped (#2105): the service worker hands its
     link to the tab (`public/question-push-sw.js`), which opens it as any
     in-app link — one entry over the place the operator was — and says so;
     a tab that does not answer is navigated by the worker instead. */
  useEffect(() => {
    const worker = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== NOTIFICATION_OPEN_MESSAGE || typeof data.url !== "string") return;
      let url: URL;
      try {
        url = new URL(data.url, location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return;
      navigateToFragment(url.hash);
      event.ports[0]?.postMessage("taken");
    };
    worker.addEventListener("message", onMessage);
    /* A listener alone does not open the page's message queue. */
    worker.startMessages();
    return () => worker.removeEventListener("message", onMessage);
  }, []);

  /* Reveal a card without going to it. `requestFocus` above both materializes
     the node and arms the board's glide; a focus handoff wants only the first,
     because it frames its own destination at its own zoom through the board
     controller. Asking through `requestFocus` gave the handoff a competing
     camera move it then had to race. */
  const placeOnBoard = useCallback((path: string) => {
    setPlaceRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* The history-recording half of `requestFocus` without the glide half: an
     `intent: "open"` handoff and a camera-exact Return both frame their own
     destination through the board controller, so what they still owe is the
     card in the layout and the typed history entry — never a second, competing
     camera move (#873 review). */
  const openPathQuiet = useCallback((path: string) => {
    setPendingHash(null);
    const file = filesRef.current.find((entry) => entry.path === path);
    if (file) recordFocusNavigation(file, projectKey(file));
    setPlaceRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* #688: the shell half of a focus handoff. An accepted request opens the
     project it lives in and, when its intent is `open`, the conversation
     itself — the same hand-off an attention jump already uses, so a handoff and
     a tap can never land differently. The board half registers in SchemeBoard. */
  useEffect(() => focusHandoffBus.setShell({
    project: project === OVERVIEW ? null : project,
    openProject: selectProject,
    openPath: requestFocus,
    placePath: placeOnBoard,
    openPathQuiet,
    /* The overview is a project selection like any other here — it just is not
       a project. `selectProject` already speaks the sentinel; the bus should
       not have to. */
    openOverview: () => selectProject(OVERVIEW),
    /* One gesture, one entry: the quiet project half plus the recording focus
       half (`requestFocus` writes the typed entry, which stores the project). */
    openConversation: (targetProject, path) => {
      if (targetProject && targetProject !== project) applyProject(targetProject);
      if (path) requestFocus(path);
    },
    /* The typed entry a VERIFIED attention arrival owes (#866 production
       regression) — record only, no placement and no camera. Identity comes
       from the scanned entry when the poll has it; a path the polls have not
       produced yet still records by bounded path identity, so Back after a
       `show` handoff stays inside the document. The operator was moved, so a
       still-unresolved deep-link intent must not re-steal the camera later —
       the same rule `requestFocus` applies. */
    recordFocusArrival: (path, targetProject) => {
      setPendingHash(null);
      const file = filesRef.current.find((entry) => entry.path === path);
      if (file) recordFocusNavigation(file, projectKey(file));
      else recordFocusNavigation({ path }, targetProject);
    },
  }), [project, selectProject, requestFocus, placeOnBoard, openPathQuiet, applyProject]);

  /* The N-cycle position anchors to an id: an item answered elsewhere drops
     out without moving the pointer's neighbors (D12). */
  const cycleRef = useRef<string | null>(null);

  /* Membership key first, Set second: polls rebuild the queue array, but the
     set identity only moves when membership does, so the memoized node layers
     never re-render for an unchanged filter (D6). */
  const attentionKey = useMemo(
    () => needsYou.flatMap((entry) => (entry.kind === "conversation" ? [entry.item.file.path] : [])).sort().join("\n"),
    [needsYou],
  );
  /* The filter keeps waiting conversations lit, so it exists only while one
     waits: a queue of parked lanes alone (#2129) leaves it nothing to keep,
     and switched on it would dim the whole board. */
  const attentionFilterable = attentionKey !== "";
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!attentionFilterable) setAttentionFilter(false);
  }, [attentionFilterable]);
  const attentionPaths = useMemo<ReadonlySet<string> | null>(
    () => (attentionFilter && attentionFilterable ? new Set(attentionKey.split("\n")) : null),
    [attentionFilter, attentionFilterable, attentionKey],
  );

  /* N never leaves the current project (D4): the same items and order the
     global list holds, conversations and lanes, taken off its memo. */
  const projectEntries = useMemo(
    () => (project === OVERVIEW ? [] : needsYou.filter((entry) => attentionEntryProject(entry) === project)),
    [needsYou, project],
  );

  /* The phone's ONE queue (mobile v2 §4.1, §4.6): the bar's badge counts it,
     the sheet the badge opens lists it, and that sheet's «Next ›» walks it.
     It is SCOPED to the project behind the badge — the board under the bar
     shows one project, so counting every project's rows made the badge promise
     items that screen could not reach. The all-projects screen has no project
     behind the badge, so there the list stays the whole queue, and on the
     phone's Overview the columns pin every project's parked lanes (#2098), so
     the badge is the sum of the tabs' ⚠ marks.

     Pipelines waiting on a decision are queue items like any other (§4.6), and
     they come from the same pure answer the board's Needs-you section renders
     (`needsDecisionPipelineRows`), so the count, the sheet and the rows under
     it cannot disagree. It is a slice of the desktop island's list, so the
     phone and the desktop cannot disagree either (#2129). */
  const shellEntries = project === OVERVIEW ? needsYou : projectEntries;
  const shellQueueCount = shellEntries.length;
  /* An agent's request_attention on the phone (docs/design/needs-attention.md
     §6): a dot on the ⚠ badge and a row in its sheet, never a move. Each row
     names where it points, in the words the board uses for it. */
  const phoneNotices = usePhoneNotices();
  const noticeRows = useMemo<MobileNoticeRow[]>(() => phoneNotices.notices.map((notice) => {
    const target = notice.target;
    const firstLine = (text: string | undefined) => cleanTitle((text ?? "").split(/\r?\n/, 1)[0] ?? "", 90);
    const title = target.kind === "conversation"
      ? cleanTitle(allFiles.find((file) => file.path === target.path)?.title ?? "", 90) || t("notices.target.conversation")
      : target.kind === "pipeline" || target.kind === "stage"
        ? firstLine(pipelines.find((pipeline) => pipeline.id === target.pipelineId)?.task) || t("notices.target.pipeline")
        : target.kind === "task"
          ? firstLine(tasks.find((task) => task.id === target.taskId)?.text) || t("notices.target.task")
          : t("notices.target.board");
    const by = notice.raisedBy?.kind === "manager" ? t("notices.byOrchestrator")
      : notice.raisedBy?.kind === "gateway" ? t("notices.byAssistant")
        : notice.raisedBy?.role ? roleNameById(t, notice.raisedBy.role) : t("notices.byAgent");
    return { notice, target: title, by };
  }), [phoneNotices.notices, allFiles, pipelines, tasks, t]);

  /* Where a desktop queue entry opens, switching the project first when it
     lives in another one: a conversation in its reader, and a lane on the
     card that holds it (#2129), which the board finds by the lane's own key
     as it does for a pipeline link. A lane has no conversation to type the
     history entry after, so a switch writes the project's own entry and Back
     returns to the board the operator left. */
  const openAttentionEntry = useCallback(
    (entry: MobileAttentionEntry) => {
      if (entry.kind === "conversation") {
        if (entry.item.project !== project) applyProject(entry.item.project);
        requestFocus(entry.item.file.path);
        return;
      }
      const lane = entry.row.pipeline;
      setPendingHash(null);
      if (lane.project !== project) selectProject(lane.project);
      focusNonceRef.current += 1;
      setFocusRequest({ path: laneFocusPath(lane.id), nonce: focusNonceRef.current, catalog: false });
    },
    [project, applyProject, selectProject, requestFocus],
  );

  useEffect(() => {
    /* N and F are desktop keys (D4/D6): the phone layout renders without the
       scheme dimming channel, and a hardware keyboard there must never drive
       hidden filter state or focus jumps. */
    if (isMobile) return;
    /* Same guard as useSchemeCamera: hotkeys stay quiet while a composer or
       any form control is focused. */
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const onDown = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n" || event.key === "N") {
        const next = advanceAttentionCycle(cycleRef, projectEntries, event.shiftKey ? -1 : 1);
        if (!next) return;
        event.preventDefault();
        openAttentionEntry(next);
      } else if (event.key === "f" || event.key === "F") {
        if (!attentionFilterable) return;
        event.preventDefault();
        setAttentionFilter((value) => !value);
      } else if (event.key === "b" || event.key === "B") {
        /* B for the rail (issue #1819). Free on both sides: the Viewer binds
           only N, F and / at window level, the kanban board U and /, and the
           browser binds no bare letter. */
        event.preventDefault();
        toggleRail();
      } else if (event.key === "/") {
        /* No Ctrl/Cmd chord: this app has none, and the `typing()` guard above
           already keeps the key quiet inside the search field itself. */
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [isMobile, projectEntries, attentionFilterable, openAttentionEntry, openSearch, toggleRail]);

  /* A popover click is a deliberate act, so unlike the N hotkey it may switch
     the project; the focus hand-off glides the board to the node. */
  const jumpToItem = useCallback(
    (item: AttentionItem) => {
      setQueueOpen(false);
      /* One gesture, one history entry: the focus record below names the
         project, so the switch itself writes nothing. */
      if (item.project !== project) applyProject(item.project);
      cycleRef.current = item.id;
      requestFocus(item.file.path);
    },
    [project, applyProject, requestFocus],
  );

  /* A popover row that names a lane: the same deliberate act as a
     conversation's row, landing on the lane's card. */
  const jumpToEntry = useCallback(
    (entry: MobileAttentionEntry) => {
      if (entry.kind === "conversation") {
        jumpToItem(entry.item);
        return;
      }
      setQueueOpen(false);
      cycleRef.current = entry.id;
      openAttentionEntry(entry);
    },
    [jumpToItem, openAttentionEntry],
  );

  /* The island's visible Next (issue #963): a deliberate act like a popover
     click, so it advances over the GLOBAL queue and may switch the project —
     the same hand-off `jumpToItem` performs. It moves the SAME cycle pointer
     the N/Shift-N keys read (through the one `advanceAttentionCycle` route),
     so the button and the shortcut always continue one sequence. */
  const advanceGlobalAttention = useCallback(
    (dir: 1 | -1) => {
      const next = advanceAttentionCycle(cycleRef, needsYou, dir);
      if (next) openAttentionEntry(next);
    },
    [needsYou, openAttentionEntry],
  );

  /* A crowned row in the popover focuses its conversation, switching project
     first if the favorite lives elsewhere — same hand-off as an attention jump. */
  const openFavorite = useCallback(
    (row: FavoriteRow) => {
      setQueueOpen(false);
      if (row.project !== project) applyProject(row.project);
      requestFocus(row.file.path);
    },
    [project, applyProject, requestFocus],
  );

  useEffect(() => {
    /* Toast fires on hard-blocked signals only — a stalled id must never enter
       this seen-set, so the guard narrows before the shared derivation. */
    const ids = files
      .map((file) => ({
        file,
        id: file.pendingQuestion || file.rateLimit || file.waitingInput ? attentionId(file) : null,
      }))
      .filter((item): item is { file: FileEntry; id: string } => item.id !== null);
    if (seenQuestionsRef.current === null) {
      seenQuestionsRef.current = new Set(ids.map((item) => item.id));
      return;
    }
    const next = ids.find((item) => !seenQuestionsRef.current!.has(item.id));
    for (const item of ids) seenQuestionsRef.current.add(item.id);
    if (next) queueMicrotask(() => setToastPath(next.file.path));
  }, [files]);

  const toastFile = toastPath ? files.find((file) => file.path === toastPath) : null;

  /* Desktop keeps the island in the fixed top-right anchor; the phone embeds
     this same node into the board header row, where it cannot cover the
     header's own buttons. The queue popover then drops as a full-width sheet
     under the header instead of hanging off the pill. The island renders in
     the zero state too — muted and inert — so the corner always answers
     "what needs me?" (issue #963). */
  const attentionBadge = (
    <div ref={queueRef} className="pointer-events-auto relative">
      <AttentionIsland
        count={needsYou.length}
        queueOpen={queueOpen}
        filterActive={attentionFilter}
        onToggleQueue={() => setQueueOpen((value) => !value)}
        onNext={advanceGlobalAttention}
        onToggleFilter={attentionFilterable ? () => setAttentionFilter((value) => !value) : undefined}
      />
      {queueOpen ? (
        <div
          className={`${
            isMobile ? "fixed inset-x-3 top-12" : "absolute right-0 top-[calc(100%+6px)] w-[340px] max-w-[calc(100vw-2rem)]"
          } z-50 max-h-[60vh] overflow-y-auto rounded-[10px] border border-border bg-card p-1.5 shadow-1`}
        >
          {/* Crowned conversations pinned at the top, mirroring the scheme's
              favorites row (issue #224). */}
          {favoriteRows.length ? (
            <div className="mb-1 border-b border-border pb-1">
              <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-1.5 text-label font-semibold text-secondary">
                <Crown className="h-3 w-3 fill-crown text-crown" aria-hidden />
                {t("favorites.sectionTitle")}
              </div>
              {favoriteRows.map((row) => (
                <div key={row.id} className="flex items-center gap-1 rounded-[8px] hover:bg-canvas">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[8px] px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    title={t("favorites.focusTitle", { title: cleanTitle(row.file.title, 60) })}
                    onClick={() => openFavorite(row)}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(row.file.activity)}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">
                      {cleanTitle(row.file.title, 90)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-crown hover:bg-crown-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    aria-label={t("branch.unfavorite")}
                    title={t("branch.unfavorite")}
                    onClick={() => favoritesBoard.setFavorite(row.id, false)}
                  >
                    <Crown className="h-3.5 w-3.5 fill-crown" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="px-2.5 pb-1 pt-1.5 text-label font-semibold text-secondary">
            {t("attention.popoverTitle")}
          </div>
          {needsYou.map((entry) => (entry.kind === "conversation" ? (
            <AttentionQueueRow key={entry.id} item={entry.item} onOpen={() => jumpToEntry(entry)} />
          ) : (
            <AttentionLaneRow key={entry.id} row={entry.row} projectName={projectDisplayNames[entry.row.pipeline.project]} onOpen={() => jumpToEntry(entry)} />
          )))}
        </div>
      ) : null}
    </div>
  );

  /* The phone shell's host (mobile v2 lane 1): the queue count for the bar's
     badge, the arrival for the banner slot (below the runtime states, which
     outrank it, and dropped on the board, where the queue is the first section
     and the badge carries the count), the search palette, and the two sheets
     the Viewer owns — the project switcher the title cell opens (it replaced
     the drawer and the hamburger) and the Needs-you queue the badge opens over
     whichever screen is showing. Memoized because ProjectDashboard is memo'd
     and a fresh object per render would re-render it on every poll. */
  const mobileShell = useMemo<MobileShellHost | null>(() => {
    if (!isMobile) return null;
    /* A notice goes where it points, on the stack the operator is on: nothing
       moved them there, so ‹ comes straight back. */
    const openNotice = (notice: AttentionNotice, close: () => void) => {
      close();
      const target = notice.target;
      if (target.kind === "conversation") {
        const file = allFiles.find((entry) => entry.path === target.path);
        if (file) {
          if (project === OVERVIEW) openOverOverview(file);
          else openFile(file);
        }
      } else if (target.kind === "pipeline" || target.kind === "stage") {
        mobileNav.push({ kind: "pipeline", id: target.pipelineId });
      } else if (target.kind === "task") {
        mobileNav.push({ kind: "task", id: target.taskId });
      }
    };
    return {
      attentionCount: shellQueueCount,
      noticeDot: phoneNotices.unseen,
      arrival: toastFile ? (
        <AttentionToast
          file={toastFile}
          mobile
          onOpen={() => {
            if (project === OVERVIEW) openOverOverview(toastFile);
            else openFile(toastFile);
            setToastPath(null);
          }}
          onDismiss={() => setToastPath(null)}
        />
      ) : null,
      renderSheet: (name, close) => {
        if (name === "projects") {
          return (
            <MobileProjectSheet
              files={files}
              projectCatalog={projectCatalog}
              projectDisplayNames={projectDisplayNames}
              pipelines={pipelines}
              workflows={workflows}
              archivedProjects={archivedProjects}
              crownedProjects={crownedProjects}
              selected={project}
              now={clock}
              loaded={loaded}
              catalogFailures={catalogFailures}
              onSelect={selectProject}
              onCreateProject={createProject}
              onClose={close}
            />
          );
        }
        if (name === "attention") {
          /* The Needs-you sheet (lane 8): the one list above, its rows opening
             through the same hand-off a popover click performs (`jumpToItem`
             moves the shared cycle pointer too, so «Next ›» here and N on a
             desktop continue one sequence). A pipeline row opens the pipeline
             screen (lane 7) on the same stack the board is on, so «Next ›»
             walks both kinds and ‹ leaves the way the operator came in. */
          return (
            <MobileAttentionSheet
              entries={shellEntries}
              now={clock}
              /* Over the Overview a row opens as a screen on its stack, as its
                 cards do (#2098); a project's own board focuses in place. */
              onOpenConversation={project === OVERVIEW ? (item) => {
                close();
                cycleRef.current = item.id;
                openOverOverview(item.file);
              } : (item) => {
                /* The conversation's screen takes the sheet's entry. */
                close();
                jumpToItem(item);
              }}
              onOpenPipeline={(row) => {
                close();
                /* Over the Overview a lane of any project goes on top of the
                   screen the operator is on and its own project's dashboard
                   draws it; ‹ comes back to that screen. */
                mobileNav.push({ kind: "pipeline", id: row.id });
              }}
              onClose={close}
              notices={noticeRows}
              onOpenNotice={(notice) => openNotice(notice, close)}
              onClearNotice={clearNotice}
              onNoticesSeen={markNoticesSeen}
            />
          );
        }
        return null;
      },
    };
  }, [isMobile, shellEntries, toastFile, openFile, openOverOverview, mobileNav, files, allFiles, projectCatalog, projectDisplayNames, pipelines, workflows, archivedProjects, crownedProjects, project, clock, loaded, catalogFailures, selectProject, createProject, jumpToItem, phoneNotices.unseen, noticeRows]);

  const shell = (
    <div className="flex h-full">
      {isMobile || railHidden ? null : (
        <ProjectRail onHide={toggleRail} files={files} projectCatalog={projectCatalog} projectDisplayNames={projectDisplayNames} pipelines={pipelines} workflows={workflows} archivedProjects={archivedProjects} crownedProjects={crownedProjects} selected={project} now={clock} loaded={loaded} catalogFailures={catalogFailures} onSelect={selectProject} onToggleCrown={toggleCrown} onCreateProject={createProject} />
      )}
      {/* Hidden rail (issue #1819): one small control at the top-left edge of
          the main area brings it back, and nothing else of the rail is left on
          screen. It is a flex sibling of its own, ahead of the dock and the
          board, so it can never sit over the board header's first control or
          over the orchestrator dock. */}
      {!isMobile && railHidden ? (
        <div className="flex shrink-0 flex-col items-center px-1 pt-1.5">
          <button
            type="button"
            data-rail-restore=""
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-border bg-card text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={t("rail.show")}
            aria-label={t("rail.show")}
            onClick={toggleRail}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {/* PUSHED INTO the layout, never over it (PRD #976 decision 1): the dock
          is a flex sibling between the rail and the board, so the board keeps
          the rest of the row instead of being covered. Desktop only — the phone
          reaches the same orchestrator through slice C (#979) — and never on
          the Overview, which is not a project and so has no seat. */}
      {!isMobile && orchestratorOpen && !kanbanFace && project !== OVERVIEW ? (
        <OrchestratorDock
          project={project}
          projectName={projectTitle(project, projectDisplayNames[project], cachedProjectName(project)) ?? (loaded ? t("dash.projectUnnamed") : "…")}
          projectCwd={projectCwds[project]}
          files={files}
          onClose={toggleOrchestrator}
        />
      ) : null}
      {/* On the phone a screen enters with a 24 px slide (`starting:translate-x-6`).
          A screen mounted fresh, such as a project's screen opened over the
          Overview (#2098), slides in with no ancestor clipping it, and Chrome's
          mobile layout widened the layout viewport to fit the slide: at 390 × 667
          `innerHeight` read 709 against a 667 px visual viewport, the
          conversation took the difference for an open keyboard, and 42 px of
          empty band stayed under its composer. Clipping the slide here keeps the
          page the phone's width. */}
      <main className={`flex min-w-0 flex-1 flex-col${isMobile ? " overflow-x-clip" : ""}`}>
        {/* Desktop: the corner attention anchor — the badge pill sits where the
            toast appears, so a new toast visually docks into it (D7). On the
            phone the badge lives in the board header and the toast docks in flow
            below (see the mobile banner), so this fixed anchor is desktop-only. */}
        <BarIslandProvider island={isMobile ? null : (
          /* On a project, top-[10px] centres the 28px island in the board's one
             48px header bar (#1801), whose right 236px are reserved for it. The
             Overview keeps its 40px title row above its board bar, so there
             top-12 parks it in that bar's reserve instead, clear of the row.
             On a project the 16px gap drops the toast to y 54, clear of the
             bar's bottom border at 48. On a project the island is portaled into
             the bar's last slot, after ⋯, so Tab reaches it where it is drawn;
             the text size and leading are the page's, which the board's own
             font would otherwise replace there. */
          <div className={`pointer-events-none fixed right-4 ${project === OVERVIEW ? "top-12 gap-2" : "top-[10px] gap-4"} z-50 flex flex-col items-end text-[15px] leading-normal`}>
            {attentionBadge}
            {toastFile ? (
              <AttentionToast
                file={toastFile}
                mobile={false}
                onOpen={() => {
                  openFile(toastFile);
                  setToastPath(null);
                }}
                onDismiss={() => setToastPath(null)}
              />
            ) : null}
          </div>
        )}>
        {project === OVERVIEW && !liftedProject ? (
          <OverviewBoard
            files={files}
            projectCatalog={projectCatalog}
            projectDisplayNames={projectDisplayNames}
            pipelines={pipelines}
            workflows={workflows}
            archivedProjects={archivedProjects}
            /* The Overview draws the kanban board over every project (#1820).
               Its inputs are the ones this component already polls — one
               tasks payload for every project, the resolved flows, the
               pipelines — so the page adds no request and no loop. */
            tasks={tasks}
            flows={flows}
            loaded={loaded}
            cached={cached}
            placesKnown={loaded && scopeCertified && !pendingHash}
            now={clock}
            catalogFailures={catalogFailures}
            onSelectProject={selectProject}
            onOpenSearch={openSearch}
            mobileShell={mobileShell}
            onOpenConversation={openOverOverview}
          />
        ) : (
          <ProjectDashboard
            files={dashboardFiles}
            flows={flows}
            pipelines={pipelines}
            pipelinesError={pipelinesError}
            workflows={workflows}
            tasks={tasks}
            conversationAliases={conversationAliases}
            projectCatalog={projectCatalog}
            projectName={projectDisplayNames[dashboardProject]}
            projectCwd={projectCwds[dashboardProject]}
            project={dashboardProject}
            loaded={loaded}
            cached={cached}
            catalogFailures={catalogFailures}
            openNonce={openNonce}
            focusRequest={focusRequest?.catalog && catalogPin?.path !== focusRequest.path ? null : focusRequest}
            placeRequest={placeRequest}
            attentionPaths={attentionPaths}
            archived={archivedProjects.has(dashboardProject)}
            catalogKnown={catalogProjects.has(dashboardProject)}
            catalogConversationCount={catalogConversationCounts.get(dashboardProject) ?? 0}
            onArchive={archiveProject}
            onUnarchive={unarchiveProject}
            onOpenSearch={openSearch}
            mobileShell={mobileShell}
            orchestratorPanelOpen={orchestratorOpen}
            onToggleOrchestratorPanel={isMobile ? undefined : toggleOrchestrator}
            onKanbanFace={setKanbanFace}
            onUserNavigate={cancelPendingIntent}
            onOpenCatalogFile={openCatalogFile}
            onCloseFile={releaseCatalogFile}
            onOpenElsewhere={isMobile ? openPhoneScreenElsewhere : undefined}
          />
        )}
        </BarIslandProvider>
      </main>
      {/* Runtime connection pill — mounts the tab-wide bus and shows live /
          reconnecting / degraded / offline. Renders nothing while slice-one is
          disabled, so on the landing page it is inert. Docked bottom-left, clear
          of the bottom-right CornerStatus and the top-right attention anchor. */}
      {isMobile ? null : <ConnectionPill />}
      <DeploymentStatusPill />
      {/* #688: polls the attention record for this device and renders the
          root agent's focus handoff when there is one to answer. Renders
          nothing at all the rest of the time. */}
      <AttentionHost mobile={isMobile} />
      {/* #1054: the global "find my messages" palette. Mounted here so one
          surface serves every board and both form factors; it renders nothing
          until the header button or `/` opens it, and a selected row leaves
          through the app's own `#f=` deep link so the conversation opens in the
          standard surface with its composer. */}
      {(isMobile ? phoneSheet === "search" : searchOpen) ? <GlobalSearch mobile={isMobile} onClose={closeSearch} onOpen={openSearchResult} /> : null}
      {/* #875: the ONE document preview surface. Transcript artifact links
          publish to its bus from anywhere in the feed; it renders nothing until
          one opens, and its state is pure same-document React state — no hash,
          no history entry, no snapshot. */}
      <ArtifactPreviewHost mobile={isMobile} />
      {/* #1876: the setup guide. Opens by itself on a first run and from the
          menus' "Setup guide" and "Agent mapping" rows. */}
      <OnboardingHost projects={guideProjects} currentProject={project === OVERVIEW ? null : project} onCreateProject={createProject} />
      {/* #2007: the Update surface, opened from the menus' "Update" row. */}
      <SelfUpdateHost />
      {/* #691: the ONE voice conversation panel, portalled into the card's dock
          slot or the floating PiP window. Mounted here rather than in the card
          because the card unmounts on board navigation while the call keeps
          running. Renders nothing until a call starts. */}
      <VoicePipHost mobile={isMobile} />
      {/* #691 §4: the manager→call report relay, on its own mount because its
          lifetime is the call's, never the floating window's. */}
      <VoiceBridgeRelayHost />
      {/* #691 hoist: the owner of every conversation card's composer machinery.
          Cards publish a place; the composer's lifetimes (dictation, attachment
          object URLs, outbox) live here and survive the card unmounting mid-call. */}
      <VoiceComposerHost files={allFiles} />
      {/* Staging instances (#659) announce themselves on every device; prod
          renders nothing. Top-center, clear of both corner anchors. */}
      <StagingBadge />
      {/* A Back/Forward entry or pasted deep link whose conversation never
          resolves (issues #866, P1 #c= bounce): says so and STAYS — the notice
          survives until a navigation, a successful resolution, or its dismiss
          button, because a self-dismissing notice left the unchanged hash
          sitting silently on the default view. Below the staging badge's
          anchor so the two never overlap. */}
      {staleFocusNotice ? (
        <div className="pointer-events-none fixed left-1/2 top-10 z-40 -translate-x-1/2" role="status" data-stale-focus-notice>
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-warning/45 bg-warning-soft py-1.5 pl-3.5 pr-2 text-[12px] font-semibold text-warning shadow-1 backdrop-blur">
            {t("viewer.staleFocusEntry")}
            <button
              type="button"
              onClick={() => setStaleFocusNotice(false)}
              aria-label={t("viewer.closeNotification")}
              className="rounded-full p-0.5 hover:bg-warning/15"
              data-stale-focus-dismiss
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
      {/* A pasted URL whose fragment the app does not speak (issue #884):
          the silent version of this looked like an undeployed feature. Same
          anchor as the stale notice; the two intents cannot co-occur. */}
      {unknownFragmentNotice ? (
        <div className="pointer-events-none fixed left-1/2 top-10 z-40 -translate-x-1/2" role="status" data-unknown-fragment-notice>
          <div className="rounded-full border border-warning/45 bg-warning-soft px-3.5 py-1.5 text-[12px] font-semibold text-warning shadow-1 backdrop-blur">
            {t("viewer.unknownFragment")}
          </div>
        </div>
      ) : null}
    </div>
  );

  /* The app's ONE screen wake-lock owner (issue #712). It wraps the shell rather
     than living inside it so the mobile header's «Keep screen awake» row — which
     unmounts every time the «⋯» menu closes — reads a controller that outlives
     the menu. `shell` is built above, so a status change re-renders this provider
     and its context consumers only, never the board. */
  return (
    <KeepAwakeProvider>
      <WorkLinksProvider value={workLinks}>
        <ServerReachProvider value={reach}>{shell}</ServerReachProvider>
      </WorkLinksProvider>
    </KeepAwakeProvider>
  );
}
