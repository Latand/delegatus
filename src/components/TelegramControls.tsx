"use client";

import { useState } from "react";

import { useLocale } from "@/lib/i18n";

/* The Telegram panel's two button shapes, shared by the personal-account
   section and the Bot section. */

export function ActionButton({ label, onClick, disabled, tone = "neutral" }: { label: string; onClick: () => void; disabled?: boolean; tone?: "neutral" | "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border px-2.5 py-0.5 text-[11px] font-semibold disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px] ${
        tone === "danger" ? "bg-canvas text-danger hover:bg-danger-soft" : "bg-canvas hover:bg-sunken"
      }`}
    >
      {label}
    </button>
  );
}

/** Inline destructive confirmation, the AccountRow removal pattern: arm on the
    first press, execute only on an explicit confirm. */
export function ConfirmingAction({ label, prompt, onConfirm, disabled, icon }: { label: string; prompt: string; onConfirm: () => void; disabled?: boolean; icon?: React.ReactNode }) {
  const { t } = useLocale();
  const [arming, setArming] = useState(false);
  if (!arming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArming(true)}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {icon}
        {label}
      </button>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
      <span className="min-w-0 flex-1 text-right text-[10.5px] font-semibold leading-snug text-danger">{prompt}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setArming(false);
          onConfirm();
        }}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] bg-danger px-2 py-0.5 text-[10.5px] font-semibold text-white hover:opacity-90 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {t("telegram.confirmCta")}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArming(false)}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] px-2 py-0.5 text-[10.5px] font-semibold text-secondary hover:bg-canvas disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {t("telegram.confirmCancel")}
      </button>
    </span>
  );
}
