import { directReviewFlows } from "./flows/directReviewGroups";
import { foldClaimedReviewers } from "./flows/flowModel";
import { structurallyEqual } from "./kanban/reuseKanbanModel";
import { launchHistoryFor } from "./launchHistoryModel";
import { buildBranchGroups, schemeAgeHorizonSeconds, withinPlacementHorizon } from "./projectModel";
import { buildSchemeLayout } from "./scheme/layout";
import { boundFlowExpansions, buildTranscriptLookup, pipelineWithinPlacementHorizon } from "./scheme/placementHorizon";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";
import { sameFileExceptSizeAndMtime, taskWorkflowMembershipKey } from "./tasks/taskWorkflowModel";
import { buildTaskBands } from "./scheme/taskBands";
import { excludeCompactPipelineArtifacts } from "./pipelines/pipelineModel";
import { partitionTaskStacks } from "./scheme/taskStacks";

/** One board's band projection, retaining equal bands and their collection. */
export function createProjectBands() {
  let previous: ReturnType<typeof buildTaskBands> = [];
  let previousInputs: unknown[] | undefined;
  return function projectBands(...args: Parameters<typeof buildTaskBands>) {
    // Bands take reference paths from the projection and file payloads from
    // the layout. A metadata-only refresh of a folded worker changes neither.
    const [base, sources] = args;
    const inputs = [base, ...Object.entries(sources).flatMap(([key, value]) => [key, key === "projection" ? taskWorkflowMembershipKey(value) : value])];
    if (previousInputs && inputs.length === previousInputs.length && inputs.every((value, i) => value === previousInputs![i])) return previous;
    const byId = new Map(previous.map(band => [band.id, band]));
    const next = buildTaskBands(...args).map(band => {
      const before = byId.get(band.id);
      return before && structurallyEqual(before, band) ? before : band;
    });
    if (previous.length !== next.length || next.some((band, index) => band !== previous[index])) previous = next;
    previousInputs = inputs;
    return previous;
  };
}

function layoutPayloadPaths(layout: ReturnType<typeof buildSchemeLayout>): Set<string> {
  return new Set([
    ...layout.nodes.flatMap(node => [node.file, ...node.tasks, ...node.under, ...(node.ancestry?.elided ?? [])]),
    ...layout.edges.flatMap(edge => edge.via ?? []),
    ...layout.stacks.flatMap(stack => stack.items.map(item => item.file)),
    ...layout.decks.flatMap(deck => deck.rounds.flatMap(round => round.file ? [round.file] : [])),
  ].map(file => file.path));
}

/** Hidden file metadata cannot change topology. Freshness still chooses among
 * duplicate generations, ranks every represented payload, and dates pipeline
 * admission. The first two force a full layout here; admission is checked by
 * the caller on every pass. Other file edits always take the full path. */
function sameLayoutFiles(before: readonly FileEntry[], files: readonly FileEntry[], payloads: ReadonlySet<string>): boolean {
  if (before === files) return true;
  if (before.length !== files.length) return false;
  const identities = new Set<string>(), duplicates = new Set<string>();
  for (const file of files) {
    const id = conversationIdentity(file);
    if (identities.has(id)) duplicates.add(id);
    identities.add(id);
  }
  return files.every((file, i) => before[i] === file || (!payloads.has(file.path) && !duplicates.has(conversationIdentity(file)) && sameFileExceptSizeAndMtime(before[i], file)));
}

/** Recompute every input, retaining only the last equal answer. Time, file
 * payloads and ownership still pass through the full derivation. An unchanged
 * membership or layout therefore stops invalidating downstream projections.
 * The cache belongs to one mounted project and retires its previous answer. */
function stableResult<Args extends unknown[], Result>(derive: (...args: Args) => Result): (...args: Args) => Result {
  let previous: { value: Result } | undefined;
  return function projectStableResult(...args) {
    const next = derive(...args);
    if (previous && structurallyEqual(previous.value, next)) return previous.value;
    previous = { value: next };
    return next;
  };
}

function createBranchGroups() {
  const derive = stableResult(buildBranchGroups);
  let previous: { files: FileEntry[]; project: string; inputs: unknown[]; value: ReturnType<typeof buildBranchGroups> } | undefined;
  return function projectBranchGroups(files: FileEntry[], project: string, options: Parameters<typeof buildBranchGroups>[2] = {}) {
    const { now = 0, ...placement } = options;
    const horizon = options.ageHorizonSeconds ?? schemeAgeHorizonSeconds();
    // collectPlacement reads these two age predicates and the hydration-zero
    // branch. Check them each tick; crossing either boundary rebuilds groups.
    const inputs = [placement, now === 0, ...files.flatMap(file => [
      withinPlacementHorizon(file, now, horizon),
      file.activity === "recent" || (now > 0 && now - file.mtime <= horizon),
    ])];
    if (previous?.files === files && previous.project === project && structurallyEqual(previous.inputs, inputs)) return previous.value;
    const value = derive(files, project, options);
    previous = { files, project, inputs, value };
    return value;
  };
}

function createFlowExpansions() {
  const derive = stableResult(boundFlowExpansions);
  let previous: { paths: ReadonlySet<string>; input: Parameters<typeof boundFlowExpansions>[1]; value: Set<string>; uniquePaths: boolean } | undefined;
  return (paths: ReadonlySet<string>, input: Parameters<typeof boundFlowExpansions>[1]) => {
    // Reviewer selection/liveness ignores byte count and mtime. The expanded
    // paths' placement predicates are the only remaining clock/freshness input.
    if (previous?.uniquePaths && paths === previous.paths && input.flows === previous.input.flows
      && input.ageHorizonSeconds === previous.input.ageHorizonSeconds && input.files.length === previous.input.files.length
      && input.files.every((file, i) => sameFileExceptSizeAndMtime(previous!.input.files[i], file)
        && (!paths.has(file.path) || withinPlacementHorizon(file, input.now, input.ageHorizonSeconds)
          === withinPlacementHorizon(previous!.input.files[i], previous!.input.now, input.ageHorizonSeconds)))) {
      previous.input = input;
      return previous.value;
    }
    const value = derive(paths, input);
    previous = { paths, input, value, uniquePaths: new Set(input.files.map(file => file.path)).size === input.files.length };
    return value;
  };
}

/** Reviewer ownership and parent rewrites are independent of byte/mtime
 * payloads. Retain that plan, then populate it from the current catalog. */
function createFoldedFiles() {
  let previous: { files: FileEntry[]; flows: Parameters<typeof foldClaimedReviewers>[1]; protectedPaths: ReadonlySet<string>;
    rows: { index: number; parent: FileEntry["parent"] }[]; value: FileEntry[] } | undefined;
  return function projectFoldedFiles(files: FileEntry[], flows: Parameters<typeof foldClaimedReviewers>[1], protectedPaths: ReadonlySet<string>) {
    if (previous && previous.flows === flows && previous.protectedPaths === protectedPaths
      && previous.files.length === files.length && files.every((file, i) => sameFileExceptSizeAndMtime(previous!.files[i], file))) {
      const next = previous.rows.map(({ index, parent }) => files[index].parent === parent ? files[index] : { ...files[index], parent });
      const value = structurallyEqual(previous.value, next) ? previous.value : next;
      previous = { ...previous, files, value };
      return value;
    }
    const value = foldClaimedReviewers(files, flows, protectedPaths);
    const indices = new Map(files.map((file, index) => [file.path, index]));
    previous = indices.size === files.length ? { files, flows, protectedPaths, value,
      rows: value.map(file => ({ index: indices.get(file.path)!, parent: file.parent })) } : undefined;
    return value;
  };
}

export function createProjectDashboardDerivation() {
  const layout = stableResult(buildSchemeLayout);
  let relationshipFiles: FileEntry[] | undefined;
  let lookup: { paths: string[]; uniquePaths: boolean; files: FileEntry[]; fileAt: ReturnType<typeof buildTranscriptLookup> } | undefined;
  let previousLayout: { inputs: unknown[]; files: FileEntry[]; payloads: Set<string>; horizons: boolean[]; value: ReturnType<typeof buildSchemeLayout> } | undefined;
  return {
    /** Path, generation and relationship consumers can share a catalog across
     * byte/mtime refreshes. Payload and deadline consumers use the fresh files. */
    relationshipFiles(files: FileEntry[]) {
      if (!relationshipFiles || relationshipFiles.length !== files.length
        || !files.every((file, i) => sameFileExceptSizeAndMtime(relationshipFiles![i], file))) relationshipFiles = files;
      return relationshipFiles;
    },
    sceneFiles: stableResult((files: FileEntry[], collapsed: ReadonlySet<string>, launches: ReadonlySet<string>, compact: ReadonlySet<string>) =>
      collapsed.size || launches.size || compact.size
        ? excludeCompactPipelineArtifacts(files.filter(file => !collapsed.has(file.path) && !launches.has(file.path)), compact)
        : files),
    directReviews: stableResult(directReviewFlows),
    flowExpansions: createFlowExpansions(),
    pinnedPaths: stableResult((paths: string[]) => new Set(paths)),
    collapsedPaths: stableResult((files: FileEntry[]) => new Set(files.map(file => file.path))),
    keepExpandedPaths: stableResult((files: FileEntry[], collapsed: ReadonlySet<string>) => new Set(files.filter(file => !collapsed.has(file.path)).map(file => file.path))),
    launchHistory: stableResult(launchHistoryFor),
    taskPartition: stableResult(partitionTaskStacks),
    groupFiles: createFoldedFiles(),
    baseGroups: createBranchGroups(),
    groups: createBranchGroups(),
    layout: (...args: Parameters<typeof buildSchemeLayout>) => {
      const placement = args[11] ?? {};
      // The alias/ambiguity index depends only on ordered paths. Its result
      // points into the latest files, so pipeline admission always reads fresh
      // mtime/activity. Duplicate paths keep the full resolver's tie rules.
      if (!lookup || !lookup.uniquePaths || lookup.paths.length !== args[2].length || !args[2].every((file, i) => file.path === lookup!.paths[i])) {
        const files = args[2], resolve = buildTranscriptLookup(files);
        const indices = new Map(files.map((file, index) => [file, index]));
        const entry: NonNullable<typeof lookup> = { paths: files.map(file => file.path), uniquePaths: new Set(files.map(file => file.path)).size === files.length, files,
          fileAt: (path: string) => { const file = resolve(path); return file ? entry.files[indices.get(file)!] : undefined; } };
        lookup = entry;
      } else lookup.files = args[2];
      const { fileAt } = lookup;
      // Layout reads time only through pipelineWithinPlacementHorizon. Evaluate
      // that predicate on every tick, including zero and backwards/resumed time;
      // all other inputs, including represented payloads and placement options, remain
      // part of this key. Expiry therefore takes the full layout path.
      const horizons = [...(args[5] ?? []), ...(args[6] ?? [])].map(pipeline => pipelineWithinPlacementHorizon(pipeline, {
        now: placement.now ?? 0, ageHorizonSeconds: placement.ageHorizonSeconds ?? schemeAgeHorizonSeconds(), fileAt,
      }));
      const inputs = [...args.slice(0, 2), ...args.slice(3, 11), placement.ageHorizonSeconds];
      if (previousLayout && structurallyEqual(previousLayout.inputs, inputs) && structurallyEqual(previousLayout.horizons, horizons)
        && sameLayoutFiles(previousLayout.files, args[2], previousLayout.payloads)) {
        previousLayout.files = args[2];
        return previousLayout.value;
      }
      const value = layout(...args);
      previousLayout = { inputs, files: args[2], payloads: layoutPayloadPaths(value), horizons, value };
      return value;
    },
  };
}
