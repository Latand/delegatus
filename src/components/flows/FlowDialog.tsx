"use client";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { PipelineTemplatePicker } from "@/components/pipelines/PipelineTemplatePicker";
import { createDraftPipeline } from "@/components/pipelines/pipelineModel";

/** Compatibility entry for old mounted shells; new work is a run-stage draft. */
export function FlowDialog({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  const { t } = useLocale();
  return <div data-retired-flow-entry>
    <p className="p-2 text-sm">{t("reviewHistory.usePipeline")}</p>
    <PipelineTemplatePicker repoDir={file.projectRoot?.trim() || file.cwd?.trim() || ""}
      onClose={onClose}
      onCreate={(template, repoDir) => createDraftPipeline(file.project, repoDir, template ?? undefined)}
      onCreated={onClose} />
  </div>;
}
