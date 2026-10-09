import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "../../..");
const clientI18n = path.join(root, "src/lib/i18n");

test("role-copy functions used by server attention reads remain outside the client boundary", () => {
  const file = path.join(root, "src/components/builderCopy.ts");
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  // Bun leaves these functions callable even when Next turns them into client
  // references. The shared row-text path must be callable in both graphs.
  expect(source.statements.some(statement => ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client")).toBe(false);
});

function importsClientI18n(specifier: string, file: string): boolean {
  const resolved = specifier.startsWith("@/")
    ? path.join(root, "src", specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : "";
  return [clientI18n, `${clientI18n}/index`, `${clientI18n}/index.ts`].includes(resolved);
}

// Bun does not apply Next's client-reference transform. Check the boundary
// itself so a server call cannot silently pass here and throw in production.
test("server modules never import the client i18n entry at runtime", () => {
  const violations: string[] = [];
  for (const file of new Bun.Glob("src/{lib,app}/**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (/\.(?:test|fixture)\.[^.]+$/.test(file) || file.endsWith(".d.ts")) continue;
    const absolute = path.join(root, file);
    const source = ts.createSourceFile(file, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.statements.some((statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client")) continue;

    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings
          && ts.isNamedImports(bindings) && bindings.elements.length > 0
          && bindings.elements.every((entry) => entry.isTypeOnly));
        if (!onlyTypes) specifier = node.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0 && node.exportClause.elements.every((entry) => entry.isTypeOnly));
        if (!onlyTypes) specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
      }
      if (specifier && importsClientI18n(specifier, absolute)) {
        violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
