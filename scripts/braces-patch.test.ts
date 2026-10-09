import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Ast = { type: string; value?: string; nodes?: Ast[]; parent?: Ast };
type Options = { maxDepth?: number; escapeInvalid?: boolean };
const braces = require("braces") as {
  parse(pattern: string, options?: Options): Ast;
  compile(input: string | Ast, options?: Options): string;
  expand(input: string | Ast, options?: Options): string[];
  stringify(input: string | Ast, options?: Options): string;
};
const micromatch = require("micromatch") as {
  braces(pattern: string): string[];
  braceExpand(pattern: string): string[];
};
const nested = (depth: number, paren = false) => (paren ? "(" : "{").repeat(depth) + "x" + (paren ? ")" : "}").repeat(depth);
function ast(depth: number): Ast {
  let node: Ast = { type: "text", value: "x" };
  for (let i = 0; i < depth; i++) {
    const parent: Ast = { type: "paren", nodes: [node] };
    node.parent = parent;
    node = parent;
  }
  const root: Ast = { type: "root", nodes: [node] };
  node.parent = root;
  return root;
}

test("the actual installed braces package has the mandatory local security patch", () => {
  expect(require("braces/package.json").version).toBe("3.0.3");
  expect(require("braces/lib/constants").MAX_DEPTH).toBe(100);
  expect(() => braces.parse(nested(2), { maxDepth: 1 })).toThrow(/max depth/);
});

test.each([false, true])("installed braces rejects advisory nesting below its length limit: parentheses=%s", paren => {
  const pattern = nested(4096, paren);
  expect(pattern.length).toBeLessThan(10_000);
  for (const method of ["parse", "compile", "expand", "stringify"] as const) {
    expect(() => braces[method](pattern)).toThrow(/max depth/);
  }
  if (paren) {
    // Micromatch returns patterns without braces directly, without AST walks.
    expect(micromatch.braces(pattern)).toEqual([pattern]);
    expect(micromatch.braceExpand(pattern)).toEqual([pattern]);
  } else {
    expect(() => micromatch.braces(pattern)).toThrow(/max depth/);
    expect(() => micromatch.braceExpand(pattern)).toThrow(/max depth/);
  }
});

test.each(["compile", "expand", "stringify"] as const)("installed %s guards caller-supplied ASTs and caps larger maxDepth", method => {
  expect(() => braces[method](ast(101))).toThrow(/AST depth.*max depth/);
  expect(() => braces[method](ast(101), { maxDepth: 1000 })).toThrow(/max depth/);
  expect(() => braces[method](ast(2), { maxDepth: 1.5 })).toThrow(/max depth/);
  expect(() => braces[method](ast(100))).not.toThrow();
});

test("installed parse honors fractional limits and the maximum boundary", () => {
  expect(() => braces.parse(nested(2), { maxDepth: 1.5 })).toThrow(/max depth/);
  expect(() => braces.parse(nested(101), { maxDepth: 1000 })).toThrow(/max depth/);
  for (const paren of [true, false]) expect(() => braces.parse(nested(100, paren))).not.toThrow();
});

test.each(["self", "multiple"] as const)("installed expand rejects %s parent cycles without hanging the caller", async kind => {
  const child = Bun.spawn([process.execPath, "-e", `
    const braces = require(${JSON.stringify(require.resolve("braces"))});
    const parent = { type: "paren", nodes: [{ type: "text", value: "x" }] };
    parent.parent = ${kind === "self" ? "parent" : '{ type: "paren", parent }'};
    try { braces.expand({ type: "root", nodes: [parent] }); process.exit(1); }
    catch (error) {
      if (!(error instanceof RangeError) || !error.message.includes("parent chain contains a cycle")) process.exit(2);
    }
  `], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  // This PID belongs to this probe; the vulnerable parent walker never yields.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1000);
  try {
    expect(await child.exited).toBe(0);
    expect(timedOut).toBe(false);
  } finally { clearTimeout(timer); }
});

test("ordinary installed braces and micromatch behavior is preserved", () => {
  const pattern = "pkg/{a,b}/{1..3}";
  expect(braces.compile(pattern)).toBe("pkg/(a|b)/([1-3])");
  expect(braces.expand(pattern)).toEqual(["pkg/a/1", "pkg/a/2", "pkg/a/3", "pkg/b/1", "pkg/b/2", "pkg/b/3"]);
  expect(braces.stringify(braces.parse(pattern))).toBe(pattern);
  expect(braces.stringify(braces.parse("a{b}"), { escapeInvalid: true })).toBe("a{b}");
  for (const pattern of ["{{a}}", "{a,{b}}", "{{x}y}", "{a,{b,{c}}", "{}{a}"]) {
    expect(braces.stringify(braces.parse(pattern), { escapeInvalid: true })).toBe(pattern);
  }
  expect(braces.expand("foo/({a,b})")).toEqual(["foo/(a)", "foo/(b)"]);
  expect(micromatch.braceExpand("{a,{b,c}}")).toEqual(["a", "b", "c"]);
  expect(micromatch.braces("{a,b}")).toEqual(["(a|b)"]);
});
