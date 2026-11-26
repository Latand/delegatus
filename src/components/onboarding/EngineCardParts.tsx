"use client";

import { Fragment } from "react";
import { RefreshCw } from "lucide-react";

import { CopyButton } from "@/components/feed/CopyButton";
import { useLocale } from "@/lib/i18n";

/** The command row of a card whose tool is missing: a line that says where to paste it, then the command and its copy control. */
export function InstallCommand({ engine, install }: { engine: string; install: { command: string; segments: readonly string[] } }) {
  const { t } = useLocale();
  const { command, segments } = install;
  return (
    <div data-onboarding-install={engine} className="flex min-w-0 flex-col gap-1.5">
      <p className="text-ui text-secondary">{t("onboarding.engines.pasteCommand")}</p>
      <div className="flex min-w-0 items-center gap-1">
        {/* Breaks only after the flags and after the slashes; the copied text is the whole command. */}
        <code data-onboarding-install-command="" className="min-w-0 rounded-[6px] bg-sunken px-2 py-1 font-mono text-ui text-primary">
          {segments.map((segment, index) => (
            <Fragment key={segment}>
              {index > 0 ? <wbr /> : null}
              <span className="whitespace-nowrap">{segment}</span>
            </Fragment>
          ))}
        </code>
        <CopyButton text={command} label={t("tools.copyCommand")} />
      </div>
    </div>
  );
}

export function RecheckButton({ onClick }: { onClick: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" data-onboarding-recheck="" onClick={onClick} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
      <RefreshCw className="h-3 w-3" aria-hidden />
      {t("onboarding.engines.recheck")}
    </button>
  );
}
