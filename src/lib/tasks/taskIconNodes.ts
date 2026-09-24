import type { IconNode } from "lucide-react";

import { canonicalTaskIcon } from "./taskIcon";

/** One lucide icon's drawing: the SVG children lucide renders into a 24×24 box. */
export type TaskIconNode = IconNode;

/** Most names one request may ask for; the rest of a longer list answers null. */
export const TASK_ICON_BATCH_LIMIT = 100;

/**
 * The drawing of one lucide icon, read from lucide-react's own module for it
 * (#2102), or null when the name is no lucide icon.
 *
 * This is the server half of the task icon loader. A page asks
 * `/api/task-icons` for the icons it is drawing and nothing else, so the
 * browser never carries lucide's name → chunk table of about 1,700 entries,
 * which its dynamic loader would put into every page's webpack runtime. The
 * modules are bundled into the route itself (`eager`), so the server build
 * emits no chunk per icon either. A name is checked against lucide's list
 * before it becomes part of a module path.
 */
export async function taskIconNode(name: string): Promise<TaskIconNode | null> {
  const icon = canonicalTaskIcon(name);
  if (!icon) return null;
  try {
    const module = (await import(/* webpackMode: "eager" */ `lucide-react/dist/esm/icons/${icon}.mjs`)) as { __iconNode?: unknown };
    return Array.isArray(module.__iconNode) ? (module.__iconNode as TaskIconNode) : null;
  } catch {
    return null;
  }
}

/** The drawings of `names`, keyed by the name as asked. */
export async function taskIconNodes(names: readonly string[]): Promise<Record<string, TaskIconNode | null>> {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const entries = await Promise.all(unique.map(async (name, index) => [name, index < TASK_ICON_BATCH_LIMIT ? await taskIconNode(name) : null] as const));
  return Object.fromEntries(entries);
}
