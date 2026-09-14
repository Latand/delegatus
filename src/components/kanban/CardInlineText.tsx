"use client";

import { useLayoutEffect, useRef } from "react";

import { useLocale } from "@/lib/i18n";

/**
 * A kanban card's title or description, edited in place (#1695 K4b, prototype
 * `renderEditor`). The field takes the place of the text it edits: `Enter`
 * saves a title, ⌘/Ctrl+Enter a description, `Esc` cancels and leaving the
 * field saves. The draft belongs to the board, so it survives the card moving
 * or re-rendering; this component only reports what the operator typed.
 */
export function CardInlineText({ field, draft, onDraft, onCommit, onCancel }: {
  field: "title" | "description";
  draft: string;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const isTitle = field === "title";

  const grow = () => {
    const element = ref.current;
    if (!element || isTitle) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(220, element.scrollHeight + 2)}px`;
  };
  /* The field opens focused with the caret at the end of the text. */
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    grow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (isTitle || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onCommit();
    }
  };
  /* Leaving the field saves, unless focus only moved to the editor's own Save
     or Cancel, which act on their own. */
  const onBlur = () => {
    setTimeout(() => {
      const element = ref.current;
      if (!element?.isConnected) return;
      if (wrap.current?.contains(document.activeElement)) return;
      onCommit();
    }, 0);
  };

  const common = {
    ref,
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onDraft(event.target.value);
      grow();
    },
    onKeyDown,
    onBlur,
    "data-card-editor": field,
  };
  return (
    <div ref={wrap} className={`editor ${field}`}>
      {isTitle ? (
        <input {...common} type="text" className="edit title-edit" aria-label={t("kanban.editTitleAria")} maxLength={200} placeholder={t("kanban.editTitlePlaceholder")} />
      ) : (
        <textarea {...common} className="edit desc-edit" rows={2} aria-label={t("kanban.editDescriptionAria")} maxLength={6000} placeholder={t("kanban.editDescriptionPlaceholder")} />
      )}
      <div className="edit-hint">
        <span>{isTitle ? t("kanban.editTitleHint") : t("kanban.editDescriptionHint")}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCommit}>{t("kanban.editSave")}</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>{t("kanban.editCancel")}</button>
      </div>
    </div>
  );
}
