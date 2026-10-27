"use client";

import { effortTierLabel } from "@/components/builderCopy";
import type { UltraRow } from "@/components/codexTierOffer";
import { Select } from "@/components/ui/Select";
import { effortScale } from "@/lib/agent/efforts";
import { listedModels } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { CopilotModelEntry } from "@/lib/agent/copilotModels";

/** Codex speed choice: empty string keeps the user's config.toml default. */
export type SpeedChoice = "" | "fast" | "standard" | "ultrafast";

/** The launch body fields a speed choice sends, for every surface that starts an
    agent: ultrafast is a named tier `fast` cannot carry, and no choice sends nothing. */
export function speedBody(engine: string, speed: SpeedChoice): { fast?: boolean; serviceTier?: string } {
  if (engine !== "codex" || !speed) return {};
  return speed === "ultrafast" ? { serviceTier: "ultrafast" } : { fast: speed === "fast" };
}

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
  ultra = null,
  inheritSpeed = false,
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
  /** The ultrafast option, offered as the launch account's catalog says; absent, the select has none. */
  ultra?: UltraRow | null;
  /** A rotation: no choice continues the incumbent's own tier, which the server resolves, so the empty option says so. */
  inheritSpeed?: boolean;
}) {
  const { t } = useLocale();
  const availableModels = engine === "copilot" && copilotModels
    ? copilotModels.map((option) => ({ id: option.id, label: option.name }))
    : listedModels(engine, model);
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
          <option value="">{t(inheritSpeed ? "draft.speedInherited" : "draft.speedDefault")}</option>
          <option value="fast">{t("draft.speedFast")}</option>
          <option value="standard">{t("draft.speedStandard")}</option>
          {/* A native option shows no tooltip, so the reason rides its own text. */}
          {ultra ? (
            <option value="ultrafast" disabled={!ultra.enabled}>
              {ultra.reason ? `${t("draft.speedUltra")} — ${ultra.reason}` : t("draft.speedUltra")}
            </option>
          ) : null}
        </Select>
      ) : null}
    </>
  );
}
