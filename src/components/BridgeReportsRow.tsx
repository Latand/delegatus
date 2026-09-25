"use client";

import { useLocale } from "@/lib/i18n";

import { useBridgeReportsSetting } from "./orchestrator/reportLog/bridgeReportsSetting";
import { ProjectSettingRow } from "./ProjectSettingRow";

/*
 * "Bridge reports" (#2146): whether the project's orchestrator files bridge
 * reports and the voice relay delivers them. On by default. It sits beside
 * "Merge when the review passes" in the board's ⋯ menu and the phone's ⋯
 * sheet, and the report log draws it on its off line.
 */
export function BridgeReportsRow({ project, variant, initial }: {
  project: string;
  variant: "menu" | "sheet" | "inline";
  /** A known answer, drawn without a read (the evidence drivers pass one). */
  initial?: boolean;
}) {
  const { t } = useLocale();
  const setting = useBridgeReportsSetting(project, initial);
  const enabled = setting.enabled === true;
  const hint = setting.failed
    ? t("projectSettings.bridgeReports.failed")
    : t(enabled ? "projectSettings.bridgeReports.on" : "projectSettings.bridgeReports.off");
  return (
    <ProjectSettingRow
      label={t("projectSettings.bridgeReports")}
      hint={hint}
      enabled={enabled}
      disabled={setting.enabled === null || setting.saving}
      failed={setting.failed}
      variant={variant}
      rowProps={{ "data-bridge-reports": setting.enabled === null ? undefined : enabled ? "on" : "off" }}
      switchProps={{ "data-bridge-reports-switch": "", onClick: setting.toggle }}
    />
  );
}
