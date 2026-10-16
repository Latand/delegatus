import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { McpToolArgs, McpToolCallContext } from "./server";
import { resolveShortId } from "@/lib/shortIds";

export async function normalizeShortIdArgs(args: McpToolArgs, context: Pick<McpToolCallContext, "signal" | "deadlineAt"> = {}): Promise<McpToolArgs> {
  const fields = (["project", "expectedProject"] as const).flatMap(field => {
    const value = args[field];
    return typeof value === "string" && /^(repo|dir)-[a-f0-9]{7,31}$/i.test(value) ? [{ field, value }] : [];
  });
  if (!fields.length) return args;
  const { namedProjectDirectory, ProjectNameRefusal } = await import("@/lib/projects/nameResolution");
  const directory = await withViewerOperation("mcp.project-prefix", () => waitForStateLock("mcp.project-prefix", () => namedProjectDirectory(), {
    signal: context.signal,
    ...(context.deadlineAt === undefined ? {} : { waitMs: Math.max(0, context.deadlineAt - Date.now()) }),
  }));
  const candidates = [...directory.identities.keys()].filter(key => /^(repo|dir)-[a-f0-9]{32}$/i.test(key));
  let result = args;
  for (const { field, value } of fields) {
    const resolution = resolveShortId(candidates, value);
    if (resolution.kind !== "match") throw new ProjectNameRefusal(resolution.kind === "ambiguous"
      ? "ambiguous project key; pass more characters" : "unknown project key; read the projects again", {
      code: resolution.kind === "ambiguous" ? "ambiguous_project" : "unknown_project", field, retryable: false,
      ...(resolution.kind === "ambiguous" ? { candidates: resolution.candidates } : {}),
    });
    result = { ...result, [field]: field === "expectedProject" ? resolution.value : directory.canonical(resolution.value) };
  }
  return result;
}
