import { en } from "@/lib/i18n/en";
import { translate, getLocale, type MessageKey } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { effortTint, effortTitle } from "./utils";

/**
 * The reasoning-effort ladder, as one geometry for the whole Viewer (#1743):
 * five bottom-aligned bars of rising height, filled up to the tier. The scale
 * is ABSOLUTE — low 1 … max 5 — not the engine's own slot count, because a
 * mixed-engine stage strip drew "high" as 3 of 5 beside 3 of 4 and the two
 * stages then read as different reasoning levels. Tiers outside the five clamp
 * (`minimal`/`off` to 1, `ultra` to 5) and keep their exact word in the tooltip.
 *
 * Height carries the level, so hue is never the only signal: the filled bars
 * take `currentColor` (the host sets the engine mark token, or `--color-muted`
 * for a stage that has not launched) and the empty ones stay `--color-border`.
 *
 * Layout contract (issue #270): the meter is a plain in-flow flex item — it
 * occupies exactly the space flexbox reserves for it and never paints outside
 * that box. The old `scale(var(--inv-z))` counter-zoom grew the bars visually
 * while their flex slot stayed 11px, so on the scheme board they stacked over
 * the neighboring model/effort cluster; far-zoom identity is FarLabel's job
 * (LABEL_Z takeover), so the meter renders at its natural size everywhere and
 * wraps/scrolls/truncates with its host row like any sibling chip. The
 * `reasoning-slot` class lets width-capped hosts that declare the
 * `reasoning-host` container (globals.css) collapse the meter below their
 * threshold instead of crowding it.
 */

/** The five drawn steps, lowest first. */
const STEPS = ["low", "medium", "high", "xhigh", "max"] as const;
const BAR_HEIGHT = [4, 6, 8, 10, 12] as const;

/** Where a recorded tier sits on the absolute five-step ladder; 0 hides it. */
export function effortStep(effort: string | null | undefined): number {
  const tier = (effort ?? "").trim().toLowerCase();
  if (!tier) return 0;
  const exact = STEPS.indexOf(tier as (typeof STEPS)[number]);
  if (exact >= 0) return exact + 1;
  if (tier === "minimal" || tier === "off") return 1;
  if (tier === "ultra") return 5;
  return 0;
}

/** The five-step ladder itself, for any surface that holds a raw tier token. */
export function EffortScale({ effort, className, color, title }: {
  effort: string | null | undefined;
  className?: string;
  /** Fill for the lit bars; defaults to the host's `currentColor`. */
  color?: string;
  /** Overrides the shared "reasoning: <tier>" tooltip. */
  title?: string;
}) {
  const level = effortStep(effort);
  if (!level) return null;
  /* The tier is a CLI token; the ladder's label says it in the reader's own
     language, and an unknown tier keeps its token (#1743). */
  const locale = getLocale();
  const tier = (effort ?? "").trim().toLowerCase();
  const tierKey = `effortTier.${tier}`;
  const word = tierKey in en ? translate(locale, tierKey as MessageKey) : (effort ?? "");
  const label = title ?? translate(locale, "util.effortTitle", { effort: word });
  return (
    <span
      data-effort-pills
      data-effort-step={level}
      className={`reasoning-slot inline-flex h-[12px] shrink-0 items-end gap-px${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {BAR_HEIGHT.map((height, i) => (
        <span
          key={i}
          aria-hidden
          className="shrink-0 rounded-full"
          style={{
            width: "3px",
            height: `${height}px`,
            backgroundColor: i < level ? color ?? "currentColor" : "var(--color-border)",
          }}
        />
      ))}
    </span>
  );
}

/** The conversation-card meter: the same ladder, in the entry's effort-shifted
    model tint, so the chip and its bars keep reading as one identity unit. */
export function EffortPills({ file }: { file: FileEntry }) {
  return <EffortScale effort={file.effort} color={effortTint(file).color} title={effortTitle(file)} />;
}
