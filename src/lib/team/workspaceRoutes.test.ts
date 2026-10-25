import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORKSPACE_ROUTES, workspaceRouteDecision } from "./workspaceRoutes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("every served API route has a reviewed gate decision and every project handler owns its gate", () => {
  const served = fs.readdirSync(path.join(root, "src/app/api"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === "route.ts")
    .map(entry => path.join(entry.parentPath, entry.name)).sort();
  const routes = served.map(file => `/${path.relative(path.join(root, "src/app"), file).replaceAll(path.sep, "/").replace(/\/route\.ts$/, "")}`);
  expect(Object.keys(WORKSPACE_ROUTES).sort()).toEqual([...routes].sort());
  for (const file of served) {
    const route = `/${path.relative(path.join(root, "src/app"), file).replaceAll(path.sep, "/").replace(/\/route\.ts$/, "")}`;
    const decision = WORKSPACE_ROUTES[route as keyof typeof WORKSPACE_ROUTES];
    if (decision !== "project" && decision !== "collection") continue;
    const source = fs.readFileSync(file, "utf8");
    expect(source, route).toContain("workspaceRoute(");
    expect(source, route).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\(/);
    for (const match of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|HEAD) = ([^\n]+)/g)) expect(match[2], `${route} ${match[1]}`).toContain("workspaceRoute(");
  }
});

test("dynamic route policies use whole segments, and new routes are owner-only", () => {
  expect(workspaceRouteDecision("/api/tasks/task-foreign/spawn")).toBe("project");
  expect(workspaceRouteDecision("/api/accounts/codex/active")).toBe("owner");
  expect(workspaceRouteDecision("/api/team/workspaces/workspace/members")).toBe("team");
  expect(workspaceRouteDecision("/api/tasks/task/extra-route")).toBe("owner");
  expect(workspaceRouteDecision("/api/new-route")).toBe("owner");
});
