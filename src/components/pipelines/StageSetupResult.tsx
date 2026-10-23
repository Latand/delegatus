"use client";

import { useLocale } from "@/lib/i18n";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";

export function StageSetupResult({ setup }: { setup: PipelineStageAttempt["setup"] }) {
  const { t } = useLocale();
  if (!setup) return null;
  return <details data-stage-setup className="min-w-0 shrink-0 rounded-control border border-border bg-canvas p-2 text-ui leading-5 text-primary">
    <summary className="cursor-pointer font-semibold">{t("projectSetup.title")} · {t(`projectSetup.${setup.state}`)}</summary>
    <div className="mt-2 max-h-[324px] min-w-0 space-y-2 overflow-y-auto" tabIndex={0}>
      <p className="break-words">{t("projectSetup.cwd")}: {setup.cwd}</p>
      <pre className="whitespace-pre-wrap break-words">{setup.command.map(arg => JSON.stringify(arg)).join(" ")}</pre>
      <p>{t("projectSetup.exit")}: {setup.code ?? "—"}</p>
      <pre className="whitespace-pre-wrap break-words">{[setup.stdout, setup.stderr].filter(Boolean).join("\n") || t("projectSetup.noOutput")}</pre>
    </div>
  </details>;
}
