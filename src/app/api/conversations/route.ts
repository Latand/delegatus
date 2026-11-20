import { requestWorkspaceScope, filterWorkspaceRows, workspaceRoute } from "@/lib/team/workspaceRoute";
import { scopeConversationCatalog, catalogEntryToFileEntry, conversationCatalogEntry, conversationCatalogReady, conversationCatalogSnapshot, ExpiredConversationCatalogCursorError, loadConversationCatalogPage } from "@/lib/scanner/conversationCatalog";
import { projectClaudeDesktopChats } from "@/lib/scanner/claudeDesktop";
import { conversationSearchProjection } from "@/lib/scanner/conversationSearchProjection";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { refreshConversationCatalog } from "@/lib/scanner/discover";
import { refreshFileCatalogMembership } from "@/lib/scanner/scanCache";
import { overlayConversationLineage } from "@/lib/agent/lineageMarkers";
import { deputyConversationRefs } from "@/lib/orchestrator/deputies";
import { overlaySessionProjects, overlaySessionTitles, searchSessionTitleProjector, sessionProjectProjection } from "@/lib/session/titleProjection";
import { cleanTitle } from "@/lib/title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pageLimit(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function workspaceGET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || undefined;
  /* The orchestrator's parallel selves leave nothing in the conversation lists
     (docs/design/ghost-seat.md §5): each is a fork of the seat in the seat's
     own project, so the catalog holds one row per ask. They stay readable by
     id and searchable through search_transcripts. An unreadable deputy file
     hides nothing. */
  const tree = url.searchParams.get("view") === "tree" && !query;
  const project = url.searchParams.get("project")?.trim() || undefined;
  const branchMode = url.searchParams.get("branch");
  const parent = url.searchParams.get("parent");
  if (branchMode !== null && (!tree || !project || (branchMode === "roots" ? parent !== null
    : branchMode !== "children" || !parent || parent.length > 2048))) {
    return Response.json({ error: "invalid chat branch selection" }, { status: 400 });
  }
  const branch = branchMode === null ? undefined : { parent };
  if (!conversationCatalogReady()) await refreshConversationCatalog();
  // Cursor pages keep their frozen ordering. New reads reconcile membership
  // before selecting a page, without paying a full scan for transcript appends.
  if (!url.searchParams.get("cursor")) await refreshFileCatalogMembership();
  const deputies = deputyConversationRefs();
  const hiddenPaths = new Set(deputies?.paths ?? []);
  const hiddenIds = new Set(deputies?.conversationIds ?? []);
  const cursor = url.searchParams.get("cursor");
  const source = cursor ? [] : filterWorkspaceRows(requestWorkspaceScope(request), conversationCatalogSnapshot()).filter((entry) => !hiddenPaths.has(entry.path));
  const hydrateSearchText = (entry: (typeof source)[number]) => {
    const text = searchTextForTranscript(entry.path, entry.size, entry.engine);
    return {
      ...entry,
      title: entry.kind === "session" && text.title ? cleanTitle(text.title, 120) : entry.title,
      firstPrompt: text.firstPrompt ?? "",
    };
  };
  const scope = requestWorkspaceScope(request);
  const options = {
    authorityScope: scope ? JSON.stringify([scope.memberId, scope.projectFilter, tree]) : tree ? "tree" : "",
    tree,
    branch,
    project,
    query,
    cursor,
    limit: pageLimit(url.searchParams.get("limit")),
  };
  try {
    let page;
    if (options.cursor) {
      // The cursor owns its frozen ordering; do not rehydrate the corpus for
      // every page (including search pages). The final page overlay stays live.
      page = await loadConversationCatalogPage([], options, undefined, query ? undefined : hydrateSearchText);
      if (tree) overlaySessionProjects(page.items);
      overlaySessionTitles(page.items);
    } else if (query) {
      // Registry ownership can move a row out of the caller's workspaces; the
      // page total is counted after that, so it never counts rows owned elsewhere.
      const scoped = filterWorkspaceRows(scope, scopeConversationCatalog(source, sessionProjectProjection().projectByPath, options.project));
      const projected = await conversationSearchProjection().search(scoped, query, {
        signal: request.signal,
        projectTitle: searchSessionTitleProjector(),
      });
      // Text stays in SQLite; only matching entries reach the sort and the
      // existing frozen cursor pages.
      page = await loadConversationCatalogPage(projected, { ...options, query: undefined });
      // The bounded final page re-runs the registry overlay: search projection
      // above carried only title/project, so without this the query branch
      // ships conversationId: null for registry-owned rows (#1040 review).
      overlaySessionTitles(page.items);
    } else {
      const projectEntries = source.map(entry => catalogEntryToFileEntry(entry));
      overlaySessionProjects(projectEntries);
      const projectByPath = new Map(projectEntries.map((entry) => [entry.path, entry.project]));
      let projected = filterWorkspaceRows(scope, source.map((entry) => ({ ...entry, project: projectByPath.get(entry.path) ?? entry.project })));
      if (tree) {
        const candidates = projected.filter(entry => !options.project || entry.project === options.project);
        const rows = candidates.map(entry => catalogEntryToFileEntry(entry));
        overlayConversationLineage(rows);
        const byPath = new Map(rows.filter(row => !row.conversationId || !hiddenIds.has(row.conversationId))
          .map(row => [row.path, row]));
        projected = projectClaudeDesktopChats(candidates.flatMap(entry => {
          const row = byPath.get(entry.path);
          if (!row) return [];
          const parent = row.parent && byPath.get(row.parent)?.project === entry.project ? row.parent : undefined;
          return [{ ...entry, parent }];
        }));
      }
      page = await loadConversationCatalogPage(projected, options, undefined, hydrateSearchText);
      overlaySessionTitles(page.items);
    }
    // A superseded round or an archived predecessor says so here as it does in
    // the files response, so a list that continues the board drops it (#1671).
    overlayConversationLineage(page.items, undefined, tree);
    /* A cursor page reads the ordering frozen at its first page, and a row
       can be addressed by another path than the one the record holds: its
       conversation id catches both. */
    const currentScope = requestWorkspaceScope(request);
    let shown = filterWorkspaceRows(currentScope, page.items).filter((item) =>
      (!branch || item.project === project) && !hiddenPaths.has(item.path) && !(item.conversationId && hiddenIds.has(item.conversationId)));
    if (tree && currentScope && !currentScope.owner) {
      const ownership = sessionProjectProjection().projectByPath;
      shown = shown.map(item => {
        if (!item.parent) return item;
        const project = ownership.get(item.parent) ?? conversationCatalogEntry(item.parent)?.project;
        return project === item.project && currentScope.canReadFile(project) && !hiddenPaths.has(item.parent)
          ? item : { ...item, parent: null };
      });
    }
    page = { ...page, items: shown, total: Math.max(0, page.total - (page.items.length - shown.length)) };
    return Response.json(page);
  } catch (error) {
    if (error instanceof ExpiredConversationCatalogCursorError) {
      return Response.json({ error: "conversation catalog cursor expired" }, { status: 409 });
    }
    throw error;
  }
}

export const GET = workspaceRoute("/api/conversations", workspaceGET, true);
