import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../..");

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

// Next compiles the scanner worker in its Pages Router graph. Dynamic imports
// are compiled too, so delaying a spawn import does not protect this boundary.
function nextServerImports(entry: string): string[] {
  const visited = new Set<string>();
  const violations: string[] = [];
  const visitFile = (file: string, chain: string[]) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings
          && ts.isNamedImports(bindings) && bindings.elements.length > 0
          && bindings.elements.every(element => element.isTypeOnly));
        if (!onlyTypes) specifier = node.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly));
        if (!onlyTypes) specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
      }
      // The existing team HTTP helper uses NextResponse, which Pages Router
      // workers can compile. Any other runtime import, including after added
      // to that helper, must fail this check.
      const teamResponse = normalizePathSeparators(path.relative(root, file)) === "src/lib/team/actor.ts"
        && ts.isImportDeclaration(node) && !node.importClause?.name
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.every(element => (element.propertyName ?? element.name).text === "NextResponse");
      if (specifier === "next/server" && !teamResponse) violations.push([...chain, "next/server"].join(" → "));
      const base = specifier?.startsWith("@/") ? path.join(root, "src", specifier.slice(2))
        : specifier?.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
      if (base) {
        const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
          .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (target && /\.[cm]?[jt]sx?$/.test(target)) visitFile(target, [...chain, path.relative(root, target)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  visitFile(path.join(root, entry), [entry]);
  return violations;
}

test("normalizes Windows paths when identifying the allowed team response helper", () => {
  expect(normalizePathSeparators("src\\lib\\team\\actor.ts")).toBe("src/lib/team/actor.ts");
});

test("the scanner worker's runtime import graph stays outside next/server", () => {
  expect(nextServerImports("src/lib/scanner/index.ts")).toEqual([]);
});

test("Turbo's runtime import graph stays outside next/server when reached by the scanner", () => {
  expect(nextServerImports("src/lib/monitor/turboRuntime.ts")).toEqual([]);
});
