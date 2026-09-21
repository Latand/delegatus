import { artifactContentUrl } from "@/components/preview/artifactResource";
import { openArtifactPreview } from "@/components/preview/previewBus";
import { resolveLink } from "@/lib/artifact/linkTarget";

import { Check, Loader2, X } from "../../icons";
import type { ToolStatus } from "../parse";

/** Run/ok/err status shown as an icon so the cmd rows read at a glance. */
export function StatusIcon({ status, className }: { status: ToolStatus; className?: string }) {
  const cls = className ?? "h-3.5 w-3.5";
  if (status === "ok") return <Check className={cls} aria-hidden />;
  if (status === "err") return <X className={cls} aria-hidden />;
  return <Loader2 className={`${cls} animate-spin motion-reduce:animate-none`} aria-hidden />;
}

export function FileRef({ file, line }: { file: string; line?: number }) {
  const label = line ? `${file}:${line}` : file;
  const cls = "inline-block min-w-0 max-w-full truncate rounded-md bg-sunken px-1.5 py-0.5 align-bottom font-mono text-[11.5px]";
  /* The feed's one link resolver decides: a transcript deep-links to its
     conversation, any other absolute path opens the file preview at the line.
     Repo-relative paths in a finding have no base here and stay code chips. */
  const target = resolveLink(label);
  if (target?.kind === "viewer") {
    return (
      <a href={target.hash} className={`${cls} text-accent underline decoration-dotted`} title={label}>
        {label}
      </a>
    );
  }
  if (target?.kind === "file") {
    return (
      <a
        href={artifactContentUrl(target.path)}
        className={`${cls} text-accent underline decoration-dotted`}
        title={label}
        data-file-link
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openArtifactPreview(label);
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <code className={cls} title={label}>
      {label}
    </code>
  );
}
