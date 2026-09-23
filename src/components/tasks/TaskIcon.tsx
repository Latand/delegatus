"use client";

import { CircleDashed, Icon } from "lucide-react";
import { memo } from "react";

import { DEFAULT_TASK_ICON, displayTaskIcon, type TaskIconSource } from "@/lib/tasks/taskIconSuggest";

import { useTaskIconNode } from "./taskIconLoader";

/**
 * One lucide icon by name, drawn once its drawing has loaded
 * (`taskIconLoader`). Until then, and for a name lucide has no icon for, the
 * box it would fill is held empty, so nothing beside it moves; `TaskIcon`
 * falls back before a stored name reaches it. The quiet default is bundled
 * and never waits.
 */
export function TaskIconGlyph({ name, size = 16, strokeWidth = 1.75, className }: { name: string; size?: number; strokeWidth?: number; className?: string }) {
  const node = useTaskIconNode(name === DEFAULT_TASK_ICON ? null : name);
  if (name === DEFAULT_TASK_ICON) return <CircleDashed size={size} strokeWidth={strokeWidth} className={className} aria-hidden />;
  if (!node) return <span aria-hidden className={className} style={{ display: "inline-block", width: size, height: size }} />;
  return <Icon iconNode={node} size={size} strokeWidth={strokeWidth} className={className} aria-hidden />;
}

export interface TaskIconProps {
  /** The task's stored icon; absent or null draws the title's suggestion. */
  icon?: string | null;
  /** The task's title, which the suggestion is read from. */
  title: string;
  size?: number;
  className?: string;
}

/**
 * A task's icon (#2102), the one component every task surface draws it with:
 * the stored lucide icon; else the icon the title suggests
 * (`suggestTaskIcon`), which is never stored; else a quiet dashed circle. A
 * stored name lucide cannot draw falls back the same way. Suggested and
 * default icons are muted, so a chosen icon reads as chosen.
 *
 * Decorative: the title beside it says what the task is, so the icon is
 * hidden from assistive technology; a control that changes it carries its own
 * label. `data-task-icon` and `data-icon-source` name what is drawn.
 */
export const TaskIcon = memo(function TaskIcon({ icon, title, size = 16, className }: TaskIconProps) {
  const primary = displayTaskIcon(icon, title);
  const node = useTaskIconNode(primary.source === "stored" ? primary.icon : null);
  const shown: { icon: string; source: TaskIconSource } = primary.source === "stored" && node === null ? displayTaskIcon(null, title) : primary;
  const tone = shown.source === "stored" ? "text-secondary" : "text-muted";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${tone}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      data-task-icon={shown.icon}
      data-icon-source={shown.source}
      aria-hidden
    >
      <TaskIconGlyph name={shown.icon} size={size} />
    </span>
  );
});
