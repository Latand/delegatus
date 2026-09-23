"use client";

import { effortTierLabel } from "@/components/builderCopy";
import { Select } from "@/components/ui/Select";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { CopilotModelEntry } from "@/lib/agent/copilotModels";

/** Codex speed choice: empty string keeps the user's config.toml default. */
export type SpeedChoice = "" | "fast" | "standard";

/**
 * Reasoning-effort select plus the codex-only speed (fast/standard) select —
 * the shared control strip for every "start a new agent" surface. The tier
 * list follows the selected model; an empty value leaves the CLI on its own default.
 * All three ride the design system's one select recipe (issue #221 §6), and
 * tier/speed labels localize while the submitted values stay the CLI tokens.
 */
export function ReasoningControls({
  engine,
  model,
  effort,
  speed,
  disabled,
  roomy,
  onModel,
  onEffort,
  onSpeed,
  copilotModels,
}: {
  engine: "claude" | "codex" | "copilot";
  model: string;
  effort: string;
  speed: SpeedChoice;
  disabled?: boolean;
  /** Renders the same three selects at the design system's 32px control height,
      for surfaces that give the draft its own column (issue #977). */
  roomy?: boolean;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onSpeed: (value: SpeedChoice) => void;
  copilotModels?: readonly CopilotModelEntry[] | null;
}) {
  const { t } = useLocale();
  const availableModels = engine === "copilot" && copilotModels
    ? copilotModels.map((option) => ({ id: option.id, label: option.name }))
    : ENGINE_MODELS[engine];
  const effortsFor = (value: string) => engine === "copilot"
    ? copilotModels?.find((item) => item.id === value)?.efforts ?? effortScale(engine, value)!
    : effortScale(engine, value)!;
  return (
    <>
      <Select
        value={model}
        disabled={disabled}
        roomy={roomy}
        aria-label={t("draft.modelAria")}
        title={t("draft.modelAria")}
        onChange={(event) => {
          const nextModel = event.target.value;
          onModel(nextModel);
          // An unsupported tier returns to the CLI default; supported choices survive.
          if (effort && !effortsFor(nextModel).includes(effort)) onEffort("");
        }}
      >
        {engine !== "copilot" ? <option value="">{t("draft.modelDefault")}</option> : null}
        {availableModels.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        value={effort}
        disabled={disabled}
        roomy={roomy}
        aria-label={t("draft.reasoningAria")}
        title={t("draft.reasoningAria")}
        onChange={(event) => onEffort(event.target.value)}
      >
        <option value="">{t("draft.effortDefault")}</option>
        {effortsFor(model).map((tier) => (
          <option key={tier} value={tier}>
            {effortTierLabel(t, tier)}
          </option>
        ))}
      </Select>
      {engine === "codex" ? (
        <Select
          value={speed}
          disabled={disabled}
          roomy={roomy}
          aria-label={t("draft.speedAria")}
          title={t("draft.speedTitle")}
          onChange={(event) => onSpeed(event.target.value as SpeedChoice)}
        >
          <option value="">{t("draft.speedDefault")}</option>
          <option value="fast">{t("draft.speedFast")}</option>
          <option value="standard">{t("draft.speedStandard")}</option>
        </Select>
      ) : null}
    </>
  );
}
