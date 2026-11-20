"use client";

import { CornerUpLeft, GitBranch } from "lucide-react";
import { useId } from "react";

import { useLocale } from "@/lib/i18n";
import type { TaskStatus } from "@/lib/tasks/types";

import { ChevronDown, ChevronRight } from "./kanbanGlyphs";

export interface ChatTaskLink {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface ChatTaskLinks {
  parent: ChatTaskLink | null;
  children: ChatTaskLink[];
}

export function CardChatLinks({ links, open, onToggle, onJump }: {
  links: ChatTaskLinks;
  open: boolean;
  onToggle: () => void;
  onJump: (id: string) => void;
}) {
  const { t } = useLocale();
  const listId = useId();
  const { parent, children } = links;
  const childrenLabel = t("kanban.chatChildren", { count: children.length });
  return (
    <div className="card-chat-links">
      <div className="chat-links-bar">
        {parent ? (
          <button type="button" className="chat-parent" data-chat-parent="" data-no-drag="" title={parent.title}
            aria-label={t("kanban.chatParentAria", { title: parent.title })} onClick={() => onJump(parent.id)}>
            <CornerUpLeft aria-hidden="true" />
            <span className="chat-task-status">{t("kanban.chatParent")}</span>
            <span className="chat-task-title">{parent.title}</span>
          </button>
        ) : null}
        {children.length ? (
          <button type="button" data-chat-children="" data-no-drag="" aria-expanded={open}
            aria-controls={open ? listId : undefined} onClick={onToggle}>
            <GitBranch aria-hidden="true" />
            <span>{childrenLabel}</span>
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : null}
      </div>
      {open && children.length ? (
        <ul id={listId} className="chat-child-list" aria-label={childrenLabel} data-no-drag="">
          {children.map(child => (
            <li key={child.id}>
              <button type="button" data-chat-task={child.id} title={child.title} onClick={() => onJump(child.id)}>
                <span className="chat-task-title">{child.title}</span>
                <span className="chat-task-status">{t(`kanban.status.${child.status}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
