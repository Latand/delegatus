import ts from "typescript";

const components: Record<string, [string, string]> = {
  "ConnectionPill.tsx": ["ConnectionPill","connectionCommits"],
  "DeploymentStatusPill.tsx": ["DeploymentStatusPill","deploymentCommits"],
  "MobileFocusView.tsx": ["MobileFocusView","mobileFocusCommits"],
  "MobileShell.tsx": ["MobileBannerSlot","mobileBannerCommits"],
  "Viewer.tsx": ["ViewerApp", "viewerCommits"],
  "ProjectDashboard.tsx": ["ProjectDashboardView", "dashboardCommits"],
  "KanbanCard.tsx": ["KanbanCard", "cardCommits"],
  "ConversationComposer.tsx": ["ConversationComposerCore", "editorCommits"],
};

/** Instrument only the replay bundle. The ordinary bundle used for latency contains no probes. */
export function instrumentComposerIsolation(source: string, filename: string): string {
  const filenameOnly = filename.split(/[\\/]/).at(-1);
  if (filenameOnly === "useFiles.ts") {
    return source + "\nglobalThis.__isolationCertifiedSize = path => filesClientCache.read().files.find(row => row.path === path)?.size;\n";
  }
  const probed = ["KanbanSeat.tsx", "runtimeFilesStatus.ts", "catalogOverlay.ts"];
  if (!filenameOnly || (!components[filenameOnly] && !probed.includes(filenameOnly))) return source;
  function insert(marker: string, code: string) {
    if (source.split(marker).length !== 2) throw Error(`isolation instrumentation needs one ${marker} in ${filenameOnly}`);
    source = source.replace(marker, marker + "\n" + code);
  }
  const register = () => '\n;(globalThis.__composerIsolationModules ??= new Set()).add(' + JSON.stringify(filenameOnly) + ');\n';
  const count = (name: string) => `if (window.isolationCounters) window.isolationCounters.${name}++;`;
  if (filenameOnly === "Viewer.tsx") {
    insert("const selected = selectDashboard(files);", `
      if (globalThis.__isolationShown !== selected) {
        if (globalThis.__isolationShown) { ${count("projectArraysPublished")} }
        globalThis.__isolationShown = selected;
      }`);
  }
  /* Every row an array filter reads: all of them on a full read, only the replaced ones otherwise. */
  const filtered = (row: string) => `if (${row}.project === "atlas") { ${count("dashboardFilterVisits")} }`;
  if (filenameOnly === "catalogOverlay.ts") {
    insert("const row = source[position]!;", filtered("row"));
    insert("const answer = select(source);", `for (const row of source) { ${filtered("row")} }
    ${count("dashboardFilterArrays")}`);
  }
  if (components[filenameOnly]) {
    const [name, counter] = components[filenameOnly]!;
    if (filenameOnly === "KanbanCard.tsx") {
      // Sample committed props on eight cards to identify shared inputs which defeat memo.
      insert("memo(function KanbanCard(props: KanbanCardProps) {", `
        const previousCard = __isolationRef();
        __isolationLayout(() => {
          const previous = previousCard.current;
          previousCard.current = props;
          const counters = window.isolationCounters;
          if (!counters || !previous) return;
          const sample = counters.cardPropSample ??= { ids: [], comparisons: 0, equalProps: 0, changes: {} };
          if (!sample.ids.includes(props.card.id)) {
            if (sample.ids.length >= 8) return;
            sample.ids.push(props.card.id);
          }
          sample.comparisons++;
          const changed = Object.keys(props).filter(key => !Object.is(previous[key], props[key]));
          if (!changed.length) sample.equalProps++;
          for (const key of changed) sample.changes[key] = (sample.changes[key] ?? 0) + 1;
        });`);
      source = 'import {useRef as __isolationRef, useLayoutEffect as __isolationLayout} from "react";\n' + source;
    }
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: Array<[number, string]> = [];
    function wrapReturn(node: ts.Node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) {
        edits.push([node.expression.getStart(ast), "__isolationProfile("], [node.expression.end, ")"]);
      } else ts.forEachChild(node, wrapReturn);
    }
    function find(node: ts.Node) {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name && node.body) {
        wrapReturn(node.body);
      } else ts.forEachChild(node, find);
    }
    find(ast);
    if (!edits.length) throw Error("no component returns to profile in " + name);
    for (const [at, text] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,at) + text + source.slice(at);
    // A sibling probe commits with the owner. Draft-only work under the owner's textarea cannot fire its callback.
    return 'import {createElement as __el, Fragment as __Fragment, Profiler as __Profiler} from "react";\n'
      + source + `
function __isolationStamp() { return null; }
function __isolationProfile(children) {
  return __el(__Fragment, null,
    __el(__Profiler, { id: ${JSON.stringify(name)}, onRender() { ${count(counter)} } }, __el(__isolationStamp)),
    children);
}
` + register();
  }
  if (filenameOnly === "runtimeFilesStatus.ts") {
    insert("let revision = 0;", "let __isolationLastFiles;");
    const visit = 'if (file.project === "atlas") { ' + count("projectRowVisits") + ' }';
    if (source.includes("for (const position of indices())")) {
      const marker = "const file = data.files[position]!;";
      if (source.split(marker).length !== 3) throw Error("the indexed row probes are out of date");
      source = source.replaceAll(marker, marker + "\n" + visit);
      source = source.replace("if (files === previous) files = previous.slice();",
        "if (files === previous) { files = previous.slice(); " + count("mappedArrays") + " }");
    } else {
      insert("for (const file of data.files) {", visit);
      insert("data.files.map((file) => {", visit);
      insert("let changed = false;\n    const priorArray = arrays.get(data.files);",
        'if (priorArray?.revision !== revision) { '+count("mappedArrays")+' }');
    }
    insert("projected.set(data, { revision, value: result });", `
      const previous = __isolationLastFiles;
      __isolationLastFiles = result.files;
      if (window.isolationCounters && previous && result.files !== previous) {
        window.isolationCounters.publishedArrays++;
        for (let i=0; i<result.files.length; i++) {
          if (result.files[i] === previous[i]) continue;
          window.isolationCounters.replacedRows++;
          if (result.files[i].project === "atlas") window.isolationCounters.projectReplacedRows++;
        }
      }`);
  }
  if (filenameOnly === "KanbanSeat.tsx") {
    const marker = "const measure = () => {";
    if (source.split(marker).length !== 3) throw Error("seat measure probes are out of date");
    source = source.replaceAll(marker, marker + "\n" + count("seatMeasures"));
  }
  return source + register();
}
