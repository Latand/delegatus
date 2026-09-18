"use client";

import { effortTierLabel } from "@/components/builderCopy";
import { EffortScale } from "@/components/EffortPills";
import { EngineMark } from "@/components/EngineMark";
import { engineBadgeFor } from "@/components/utils";
import { useLocale, type TFunction } from "@/lib/i18n";

import type { StageIdentityView, StageRunValues } from "./stageIdentity";

/*
 * Who runs a stage, drawn (#1743). One unit, four densities, so the same facts
 * read the same on a minimized chip, on a graph node, on a one-line row and in
 * a pane header:
 *
 *   engine → the shared `EngineMark`, in the engine's colour
 *   effort → the shared five-step `EffortScale`, identical everywhere
 *   model  → text, wherever there is room for it
 *
 * The engine word is printed only in the roomy `header` density — the draft
 * pane's own wrapping meta row — because a pane is 340-440 px wide and its
 * title line also carries the role, the state and the pane's controls: spelling
 * out engine AND effort there squeezed the model to nothing. That line takes
 * the tight `line` density, which draws mark, model and ladder only and leaves
 * the words to the row's own tooltip and `aria-label`; the phone's stage rows
 * take the same one, so a stage says who runs it there too.
 *
 * A stage that has not launched draws its configuration muted, and a
 * configuration that has moved on since the launch adds a dashed "next attempt
 * differs" pill rather than quietly replacing what ran. The pill spells the
 * next values out only in the roomy density; everywhere else it is its arrow,
 * because the expanded form is 150 px wide and was cut mid-pill.
 */

/** Human engine name, from the Viewer's one engine label table. */
export const engineWord = (engine: string) => engineBadgeFor(engine).label;

function valuesTitle(t: TFunction, values: StageRunValues): string {
  return values.effort
    ? t("kanban.identity.title", { engine: engineWord(values.engine), model: values.modelLabel, effort: effortTierLabel(t, values.effort) })
    : t("kanban.identity.titleNoEffort", { engine: engineWord(values.engine), model: values.modelLabel });
}

/** The sentence a host adds to its own `aria-label` and `title`. */
export function identityTitle(t: TFunction, identity: StageIdentityView): string {
  return [
    valuesTitle(t, identity),
    identity.source === "configured" ? t("kanban.identity.configured") : null,
    identity.next ? t("kanban.identity.next", { values: valuesTitle(t, identity.next) }) : null,
  ].filter(Boolean).join(" · ");
}

export function StageIdentity({ identity, density, name, showWord = false, words = true, className }: {
  identity: StageIdentityView;
  /** `chip` minimized, `node` on a graph node, `line` on a one-line row that
      has no space for words, `header` on a wrapping meta row that does. */
  density: "chip" | "node" | "line" | "header";
  /** The chip draws the stage name inside the unit, between mark and scale. */
  name?: React.ReactNode;
  /** Print the effort word beside the scale. The node passes this only when the
      layout gave it a wide enough box, so the word never clips. */
  showWord?: boolean;
  /** Draw the words at all. A host that scales the whole graph down (the modal's
      zoom) turns this off below the legible floor: the mark and the ladder, which
      are shapes, survive any scale, and the words move to the hover and the
      expanded stage rather than rendering at 7 px. */
  words?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  const title = identityTitle(t, identity);
  /* A minimized chip has room for the model only when it says something the
     engine mark does not: a model other than the engine's own default. */
  const showModel = words && (density !== "chip" || !identity.modelIsDefault);
  const roomy = words && density === "header";
  return (
    <span className={`pident d-${density}${className ? ` ${className}` : ""}`} data-identity={identity.source} data-engine={identity.engine} title={title}>
      <EngineMark engine={identity.engine} size={12} />
      {roomy ? <span className="iengine">{engineWord(identity.engine)}</span> : null}
      {name}
      {showModel ? <span className="imodel">{identity.modelLabel}</span> : null}
      <EffortScale effort={identity.effort} />
      {words && showWord && identity.effort ? <span className="ieffort">{effortTierLabel(t, identity.effort)}</span> : null}
      {identity.next ? <NextPill next={identity.next} expanded={roomy} /> : null}
    </span>
  );
}

/** The next attempt runs on other values than the one on the node (#1743). The
    pill is dashed, like every other "configured, not yet run" mark here. */
function NextPill({ next, expanded }: { next: StageRunValues; expanded: boolean }) {
  const { t } = useLocale();
  const title = t("kanban.identity.next", { values: valuesTitle(t, next) });
  return (
    <span className={`pnext${expanded ? " wide" : ""}`} data-next-differs="" role="img" aria-label={title} title={title}>
      <span aria-hidden="true">→</span>
      {expanded ? (
        <span className="nvals">
          <EngineMark engine={next.engine} size={12} />
          <span className="imodel">{next.modelLabel}</span>
          <EffortScale effort={next.effort} />
          {next.effort ? <span className="ieffort">{effortTierLabel(t, next.effort)}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The circled number on an arrow, on a loop chip and on a review-loop node: how
 * many times something fired. One vocabulary, so a circled number has exactly
 * one meaning in the Viewer.
 *
 * Fill versus outline carries the verdict without colour: a fail count is
 * filled, a pass count is an outline. An exhausted budget inverts the pill it
 * sits in, which is a luminance cue rather than a hue one.
 */
export function CountCircle({ n, tone, filled, label, className }: {
  n: number | string;
  tone: "pass" | "fail" | "ok" | "open" | "neutral";
  filled?: boolean;
  label?: string;
  className?: string;
}) {
  const aria = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  return (
    <span
      className={`ccircle t-${tone}${filled ? " filled" : ""}${className ? ` ${className}` : ""}`}
      data-count={typeof n === "number" ? n : undefined}
      title={label}
      {...aria}
    >
      {n}
    </span>
  );
}
