"use client";

import { Layers } from "@/components/icons";
import { Hint } from "@/components/Hint";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

/**
 * The composer's Context toggle (docs/design/composer-context-mode.md §3).
 * A desktop chip sits beside the model pill; on the phone it is a 44 px target
 * holding a 32 px icon, like every other control of the tools row.
 */
export function ContextToggle({ on, auto, disabledReason, onPress }: {
  on: boolean;
  /** Auto is deciding the mode, so the chip says so. */
  auto: boolean;
  /** Why the toggle cannot be used; absent when it can. The button stays
      focusable and pressable so the caller can say the reason as text, since a
      phone has no hover. */
  disabledReason?: string;
  onPress: () => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const disabled = Boolean(disabledReason);
  const hint = disabledReason ?? t(on ? "composer.context.hintOn" : "composer.context.hintOff");
  const tone = on ? "border-info/45 bg-info-soft text-info" : "border-border text-secondary hover:bg-sunken";
  return (
    <Hint label={hint}>
      <button
        type="button"
        data-composer-context-toggle={on ? "on" : "off"}
        aria-pressed={on}
        aria-label={t("composer.context.toggleAria")}
        aria-disabled={disabled || undefined}
        onClick={onPress}
        className={isMobile
          ? "group/context inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 aria-disabled:opacity-40"
          : `inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 aria-disabled:opacity-40 ${tone}`}
      >
        {isMobile ? (
          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-control border transition-[scale] duration-[120ms] ease-out motion-safe:group-enabled/context:group-active/context:scale-[0.96] ${tone}`}>
            <Layers className="h-4 w-4" aria-hidden />
          </span>
        ) : (
          <>
            <Layers className="h-3.5 w-3.5" aria-hidden />
            <span>{t("composer.context.toggle")}</span>
            {auto ? <span className="font-normal text-muted">{t("composer.context.autoBadge")}</span> : null}
          </>
        )}
      </button>
    </Hint>
  );
}
