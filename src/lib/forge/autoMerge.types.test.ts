import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

test("auto merge runner has no focused semantic TypeScript diagnostics", () => {
  const root = process.cwd(), file = path.join(root, "src/lib/forge/autoMerge.ts");
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([file, ...parsed.fileNames.filter(name => name.endsWith(".d.ts"))],
    { ...parsed.options, noEmit: true, incremental: false });
  const source = program.getSourceFile(file)!;
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  console.info(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getNewLine: () => "\n", getCanonicalFileName: name => name,
  }));
  console.info("auto merge semantic selection", JSON.stringify({ file: path.relative(root, file), diagnostics: diagnostics.length, fullProject: false }));
  expect(diagnostics).toHaveLength(0);
}, 60_000);
