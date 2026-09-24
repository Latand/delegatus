"use client";

import { useEffect, useState } from "react";

import { MarkdownDocument } from "@/components/feed/markdownDocument";
import { directoryOf } from "@/lib/artifact/linkTarget";
import { useLocale } from "@/lib/i18n";

import {
  artifactContentUrl,
  failureFromStatus,
  formatBytes,
  type ArtifactFailure,
  type ArtifactMeta,
} from "./artifactResource";
import { TextPane } from "./TextPane";

/** A rendered document is read whole up to this bound; past it the rendered
    view shows the head and the source view pages through the rest. */
export const MARKDOWN_RENDER_BYTES = 2 * 1024 * 1024;

/** The sandbox the report frame runs in. Scripts yes, the viewer's origin no:
    without `allow-same-origin` the page gets an opaque origin, so it cannot
    read the viewer's DOM, storage or cookies, and its API calls arrive
    cross-origin and are refused. The frame route sends the same sandbox as a
    CSP, so the page stays origin-less when opened in its own tab. */
export const FRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals";

export type DocumentMode = "rendered" | "source";

export function ModeToggle({ mode, onMode, mobile }: { mode: DocumentMode; onMode: (mode: DocumentMode) => void; mobile: boolean }) {
  const { t } = useLocale();
  const item = (value: DocumentMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      data-preview-mode={value}
      onClick={() => onMode(value)}
      className={`${mobile ? "h-11 px-4" : "h-7 px-2.5"} text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        mode === value ? "bg-accent/15 text-accent" : "bg-canvas text-muted hover:text-primary"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("preview.viewMode")} className="inline-flex shrink-0 overflow-hidden rounded-[8px] border border-border">
      {item("rendered", t("preview.rendered"))}
      <span aria-hidden className="w-px bg-border" />
      {item("source", t("preview.source"))}
    </div>
  );
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">{children}</div>;
}

export function MarkdownPane({
  path,
  meta,
  anchor,
  line,
  mobile,
  onFailure,
}: {
  path: string;
  meta: ArtifactMeta;
  anchor: string | null;
  line: number | null;
  mobile: boolean;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  /* A `:line` names a line of the source, so that is where such a link lands. */
  const [mode, setMode] = useState<DocumentMode>(line ? "source" : "rendered");
  const [text, setText] = useState<string | null>(null);
  const truncated = meta.size > MARKDOWN_RENDER_BYTES;

  useEffect(() => {
    if (mode !== "rendered" || text !== null) return;
    const controller = new AbortController();
    const headers: Record<string, string> = { "if-match": meta.etag };
    if (meta.size > 0) headers.range = `bytes=0-${Math.min(meta.size, MARKDOWN_RENDER_BYTES) - 1}`;
    void fetch(artifactContentUrl(path), { signal: controller.signal, headers })
      .then(async (response) => {
        if (!response.ok) {
          onFailure(failureFromStatus(response.status));
          return;
        }
        setText(new TextDecoder("utf-8", { fatal: false }).decode(await response.arrayBuffer()));
      })
      .catch(() => {
        if (!controller.signal.aborted) onFailure("error");
      });
    return () => controller.abort();
  }, [mode, text, path, meta, onFailure]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <ModeToggle mode={mode} onMode={setMode} mobile={mobile} />
      </Toolbar>
      {mode === "source" ? (
        <TextPane path={path} meta={meta} mobile={mobile} line={line} onFailure={onFailure} />
      ) : text === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted" role="status">
          {t("preview.loading")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-md-scroll>
          <div className={`mx-auto max-w-[860px] ${mobile ? "px-3.5 py-3" : "px-6 py-4"}`}>
            {truncated ? (
              <p className="mb-3 rounded-[8px] border border-border bg-sunken px-3 py-2 text-[12px] text-muted">
                {t("preview.renderedPrefix", { size: formatBytes(MARKDOWN_RENDER_BYTES) })}
              </p>
            ) : null}
            <MarkdownDocument text={text} baseDir={directoryOf(path)} anchor={anchor} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The report frame's URL with the in-file anchor the link carried. */
export function frameSource(frame: string, anchor: string | null): string {
  return anchor ? `${frame}#${encodeURIComponent(anchor)}` : frame;
}

export function HtmlPane({
  path,
  meta,
  anchor,
  line,
  mobile,
  onFailure,
}: {
  path: string;
  meta: ArtifactMeta & { frame: string };
  anchor: string | null;
  line: number | null;
  mobile: boolean;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<DocumentMode>(line ? "source" : "rendered");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <ModeToggle mode={mode} onMode={setMode} mobile={mobile} />
      </Toolbar>
      {mode === "source" ? (
        <TextPane path={path} meta={meta} mobile={mobile} line={line} onFailure={onFailure} />
      ) : (
        /* White like a browser tab: reports are written for a light page. */
        <iframe
          key={anchor ?? ""}
          src={frameSource(meta.frame, anchor)}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          title={t("preview.frameTitle", { name: meta.name })}
          data-preview-frame
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
