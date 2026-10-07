import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

import { UnixRuntimeHostClient } from "./client";
import {
  RUNTIME_RPC_DEADLINE_MS,
  RUNTIME_SNAPSHOT_DEADLINE_MS,
  RUNTIME_STARTUP_READ_DEADLINE_MS,
  VIEWER_DEPLOYMENT_DEADLINE_MS,
} from "./deadlines";

const SOURCE_ROOT = path.resolve(import.meta.dir, "../..");
const DEADLINES_MODULE = path.join(import.meta.dir, "deadlines.ts");
const CLIENT_MODULE = path.join(import.meta.dir, "client.ts");

/* The methods of `RuntimeHostClient` that take a caller-local deadline. `waitEvents`
   is absent on purpose: its number is the long-poll hold the host is asked for,
   and the client derives the deadline from it. */
const DEADLINE_METHODS = new Set(["snapshot", "snapshotJson", "readSession"]);

function isNumber(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isNumber(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return isNumber(node.operand);
  if (ts.isBinaryExpression(node)) return isNumber(node.left) && isNumber(node.right);
  return false;
}

/** Names this file binds to a number it wrote itself: `const X = 30_000`. */
function localNumbers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isNumber(node.initializer)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function hardCoded(node: ts.Expression, locals: Set<string>): boolean {
  return isNumber(node) || (ts.isIdentifier(node) && locals.has(node.text));
}

/** Every place a file gives a runtime-host RPC a deadline of its own. */
export function hardCodedRuntimeDeadlines(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const locals = localNumbers(source);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) => {
    found.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "UnixRuntimeHostClient"
      && (node.arguments?.length ?? 0) > 1) {
      at(node, "constructs a runtime-host client with its own deadlines");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && DEADLINE_METHODS.has(node.expression.name.text)) {
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue;
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === "timeoutMs"
            && hardCoded(property.initializer, locals)) {
            at(property, `hard-codes the deadline of ${node.expression.name.text}()`);
          }
        }
      }
    }
    /* The shared client itself: a constructor default or a per-method deadline
       handed to `this.call` has to be a name from the deadlines module. */
    if (ts.isClassDeclaration(node) && node.name?.text === "UnixRuntimeHostClient") {
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member)) continue;
        for (const parameter of member.parameters) {
          if (parameter.initializer && hardCoded(parameter.initializer, locals)) at(parameter, "defaults a client deadline to its own number");
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "call"
      && node.arguments[2] && hardCoded(node.arguments[2], locals)) {
      at(node.arguments[2], "hard-codes the deadline of one RPC method");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function productionSources(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Fixtures and helpers drive private hosts with their own patience.
      if (entry.name === "fixtures" || entry.name === "__fixtures__" || entry.name === "test-helpers") continue;
      productionSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|fixture)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("the deadlines are the ones the operator's deployment runs", () => {
  expect(RUNTIME_RPC_DEADLINE_MS).toBe(10_000);
  expect(RUNTIME_SNAPSHOT_DEADLINE_MS).toBe(30_000);
  expect(VIEWER_DEPLOYMENT_DEADLINE_MS).toBe(120_000);
  expect(RUNTIME_STARTUP_READ_DEADLINE_MS).toBe(30_000);
});

test("no route, controller or client under src/ hard-codes a runtime RPC deadline", () => {
  const files = productionSources(SOURCE_ROOT).filter((file) => file !== DEADLINES_MODULE);
  expect(files).toContain(CLIENT_MODULE);
  expect(files.some((file) => file.includes(`${path.sep}app${path.sep}api${path.sep}`))).toBe(true);
  const violations = files.flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    // Cheap pre-filter: a file that never names a deadline cannot set one.
    if (!text.includes("timeoutMs") && !text.includes("UnixRuntimeHostClient")) return [];
    return hardCodedRuntimeDeadlines(path.relative(SOURCE_ROOT, file), text);
  });
  expect(violations).toEqual([]);
});

test("the guard names each way a file can give an RPC its own deadline", () => {
  expect(hardCodedRuntimeDeadlines("app/api/x/route.ts", `
    const client = runtimeHostClient();
    await client.snapshot(request.signal, { timeoutMs: 10_000 });
  `)).toEqual(["app/api/x/route.ts:3 hard-codes the deadline of snapshot()"]);
  expect(hardCodedRuntimeDeadlines("app/api/x/route.ts", `
    const OWN_DEADLINE_MS = 5 * 1_000;
    await client.readSession({ conversationId }, { timeoutMs: OWN_DEADLINE_MS });
  `)).toEqual(["app/api/x/route.ts:3 hard-codes the deadline of readSession()"]);
  expect(hardCodedRuntimeDeadlines("app/api/x/route.ts", `
    const client = new UnixRuntimeHostClient(socket, 10_000, 120_000, 30_000);
  `)).toEqual(["app/api/x/route.ts:2 constructs a runtime-host client with its own deadlines"]);
  expect(hardCodedRuntimeDeadlines("lib/runtime/client.ts", `
    class UnixRuntimeHostClient {
      constructor(private readonly socketPath: string, private readonly timeoutMs = 3_000) {}
      events(after: number) { return this.call("events", { after }, 3_000); }
    }
  `)).toEqual([
    "lib/runtime/client.ts:3 defaults a client deadline to its own number",
    "lib/runtime/client.ts:4 hard-codes the deadline of one RPC method",
  ]);
  // A name from the deadlines module, a passed-through option and the default pass.
  expect(hardCodedRuntimeDeadlines("lib/x.ts", `
    import { RUNTIME_STARTUP_READ_DEADLINE_MS } from "./deadlines";
    await client.snapshot(undefined, { timeoutMs: RUNTIME_STARTUP_READ_DEADLINE_MS });
    await client.snapshot(undefined, { voiceBodiesFor: [], timeoutMs: options.timeoutMs });
    await client.snapshot();
    const client = new UnixRuntimeHostClient(socket);
  `)).toEqual([]);
});

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-deadlines-"));
const servers: net.Server[] = [];
const connections: net.Socket[] = [];

afterAll(async () => {
  for (const socket of connections) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("the shared client arms each kind of call with its deadline from the one module", async () => {
  const socketPath = path.join(SANDBOX, "silent.sock");
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const armed: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
    armed.push(Number(delay));
    // The host never answers; fire the deadline at once so the call settles.
    return realSetTimeout(handler, 1);
  }) as never);
  try {
    const client = new UnixRuntimeHostClient(socketPath);
    await expect(client.events(0)).rejects.toThrow("runtime host request timed out");
    await expect(client.snapshot()).rejects.toThrow("runtime host request timed out");
    await expect(client.readViewerDeployment("deployment")).rejects.toThrow("runtime host request timed out");
    await expect(client.findViewerDeploymentByIdempotencyKey("key")).rejects.toThrow("runtime host request timed out");
  } finally {
    timers.mockRestore();
    log.mockRestore();
  }
  expect(armed).toEqual([RUNTIME_RPC_DEADLINE_MS, RUNTIME_SNAPSHOT_DEADLINE_MS, RUNTIME_RPC_DEADLINE_MS, VIEWER_DEPLOYMENT_DEADLINE_MS]);
});
