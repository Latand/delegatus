import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Covers SQL fragments as well as complete statements. The execution guard in
// minimumSqlite.test.ts and the minimum-SQLite CI suites cover their semantics.
const newerFunction = /^(?:jsonb(?:_\w+)?|unhex|timediff|concat(?:_ws)?|string_agg|json_error_position|json_pretty|unistr(?:_quote)?)$/i;
const aggregate = /^(?:json_group_array|json_group_object|group_concat|string_agg|sum|avg|count|min|max|total)$/i;
function newerFeatures(sql: string): string[] {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\b\w+\b|[^\s]/g) ?? [];
  const calls: (string | null)[] = [];
  const features: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === "(") calls.push(tokens[index - 1] ?? null);
    else if (token === ")") calls.pop();
    else if (tokens[index + 1] === "(" && newerFunction.test(token)) features.push(token);
    else if (/^'(?:subsec|subsecond)'$/i.test(token)) features.push("subsec");
    else if (/^\d[\d_]*_\d[\d_]*$/.test(token)) features.push("numeric separator");
    else if (/^ORDER$/i.test(token) && /^BY$/i.test(tokens[index + 1] ?? "") && aggregate.test(calls.at(-1) ?? "")) features.push("aggregate ORDER BY");
  }
  return features;
}

test("the SQL audit distinguishes newer aggregate syntax from ordered subqueries", () => {
  for (const sql of ["SELECT jsonb('{}')", "SELECT unixepoch('now','subsec')", "SELECT json_group_array(json(value) ORDER BY key)", "SELECT 1_000", "SELECT timediff(a,b)"]) {
    expect(newerFeatures(sql).length).toBeGreaterThan(0);
  }
  for (const sql of ["SELECT json_group_array(json(value)) FROM (SELECT value FROM x ORDER BY key)", "SELECT json_object('text','ORDER BY')", "SELECT count(*) FILTER (WHERE enabled)"]) {
    expect(newerFeatures(sql)).toEqual([]);
  }
});

test("first-party SQL keeps the 3.39 floor outside the two capability-selected history queries", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const failures: string[] = [];
  function inspect(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") inspect(filename);
        continue;
      }
      if (!entry.name.endsWith(".ts") || /\.(?:test|fixture|seedChild|sqliteChild)\./.test(entry.name)
        || /(?:Fixture|ProbeChild|ConcurrencyChild)\.ts$/.test(entry.name)) continue;
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const source = ts.createSourceFile(relative, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
          const sql = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => `?${span.literal.text}`).join("") : node.text;
          const declaration = node.parent;
          const nativeHistory = relative === "lib/state/historyProjection.ts" && ts.isVariableDeclaration(declaration)
            && ts.isIdentifier(declaration.name) && ["pipelineInputJsonb", "flowSqlJsonb"].includes(declaration.name.text);
          const capabilityProbe = relative === "lib/state/historyProjection.ts" && sql === "SELECT jsonb('{}')";
          const looksLikeSql = /^\s*(?:SELECT|WITH|CREATE|ALTER|INSERT|UPDATE|DELETE|PRAGMA|DROP|BEGIN|FROM|WHERE)\b/i.test(sql)
            || /\b(?:jsonb(?:_\w+)?|json_group_array|json_group_object|group_concat|unixepoch|strftime|timediff|concat(?:_ws)?|string_agg|json_error_position|json_pretty|unhex|unistr(?:_quote)?)\s*\(/i.test(sql);
          if (looksLikeSql && !nativeHistory && !capabilityProbe) {
            const features = newerFeatures(sql);
            if (features.length) failures.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${features.join(", ")}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect(root);
  expect(failures).toEqual([]);
}, 30_000);
