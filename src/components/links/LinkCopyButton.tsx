"use client";

import { useEffect, useRef, useState } from "react";

import { copyText } from "@/components/feed/CopyButton";
import { useLocale } from "@/lib/i18n";

/** A labelled copy button for the two values a person types on the other
    machine. It says "Copy" and flips to "Copied", and its aria-label names the
    value. */
export function LinkCopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      aria-label={label}
      data-linked-copy=""
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="min-h-11 shrink-0 rounded-[8px] border border-border px-3 text-ui font-semibold text-primary hover:bg-sunken"
    >
      {copied ? t("links.copied") : t("links.copy")}
    </button>
  );
}
