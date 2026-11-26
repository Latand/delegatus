import ts from "typescript";

const components: Record<string, [string, string]> = {
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
  if (!filenameOnly || (!components[filenameOnly] && filenameOnly !== "KanbanSeat.tsx" && filenameOnly !== "runtimeFilesStatus.ts")) return source;
  function insert(marker: string, code: string) {
    if (source.split(marker).length !== 2) throw Error(`isolation instrumentation needs one ${marker} in ${filenameOnly}`);
    source = source.replace(marker, marker + "\n" + code);
  }
  const register = () => '\n;(globalThis.__composerIsolationModules ??= new Set()).add(' + JSON.stringify(filenameOnly) + ');\n';
  const count = (name: string) => `if (window.isolationCounters) window.isolationCounters.${name}++;`;
  if (filenameOnly === "Viewer.tsx") {
    insert("const selected = files.filter((file) => projectKey(file) === dashboardProject);", `
      if (window.isolationCounters) {
        window.isolationCounters.dashboardFilterVisits += selected.length;
        window.isolationCounters.dashboardFilterArrays++;
      }`);
    insert("dashboardFilesRef.current = { project: dashboardProject, files: stable };",
      'if (stable !== previous?.files) { ' + count("projectArraysPublished") + ' }');
  }
  if (components[filenameOnly]) {
    const [name, counter] = components[filenameOnly]!;
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
    insert("for (const file of data.files) {", visit);
    insert("data.files.map((file) => {", visit);
    insert("let changed = false;\n    const priorArray = arrays.get(data.files);",
      'if (priorArray?.revision !== revision) { '+count("mappedArrays")+' }');
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
