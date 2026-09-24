"use client";

import { Download, ExternalLink, FileWarning, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { classifyArtifact, type ArtifactKind } from "@/lib/artifact/classify";
import { parseArtifactFragment } from "@/lib/artifact/fragment";
import { parseFileSpelling, resolveLink, type FileLinkTarget } from "@/lib/artifact/linkTarget";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useModalLayer } from "../modalLayer";
import { leftShellInset, useLeftShellInset } from "../shellLayout";
import {
  artifactBasename,
  artifactContentUrl,
  artifactMetaUrl,
  failureFromStatus,
  formatBytes,
  type ArtifactFailure,
  type ArtifactMeta,
} from "./artifactResource";
import { frameSource, HtmlPane, MarkdownPane } from "./DocumentPanes";
import { ImagePane } from "./ImagePane";
import { onArtifactPreview } from "./previewBus";
import { TextPane } from "./TextPane";
import { Z } from "@/components/layers";

/* pdf.js is megabytes; its chunk must not exist on the network until the first
   PDF preview actually opens. */
const PdfPane = lazy(() => import("./PdfPane"));

const WIDTH_KEY = "llvPreviewWidth";
const MIN_WIDTH = 380;
/** Keep at least this much conversation visible beside the desktop sheet. */
const MIN_CONVERSATION = 320;

/**
 * The sheet is fixed to the right edge, so it covers whatever the shell puts
 * under it — including surfaces pushed into the row from the LEFT, which its
 * own `100vw` clamp cannot see. `leftShellInset` is the rail plus the
 * orchestrator dock when that dock is open (PRD #976 decision 1), and the
 * remembered width yields to it: a document opened at 560px on a 1440px screen
 * used to bury the board down to 192px. The sheet gives way rather than the
 * dock because it is opened on demand while the dock is a surface the operator
 * sized on purpose — and the sheet still keeps its own {@link MIN_WIDTH}.
 */
export function roomForSheet(viewportWidth: number, inset: number): number {
  return Math.max(MIN_WIDTH, viewportWidth - MIN_CONVERSATION - Math.max(0, inset));
}

interface OpenRequest {
  path: string;
  /** The file the link names: resolved where the link was rendered, or read
      from `path` for the `#a=` entry. */
  target: FileLinkTarget;
  /** Bumps on every open so re-opening the same path restarts its load. */
  nonce: number;
  /** The open came from the `#a=` URL fragment (issue #884), not a clicked
      link: hash navigation away closes it, and a user close strips the
      fragment so a reload does not resurrect the sheet. */
  fromFragment?: boolean;
}

/** The file a request names, read by the one link resolver: whatever shape
    the link had, the preview gets a clean path plus its line and anchor. */
export function previewTarget(spelled: string): FileLinkTarget {
  const resolved = resolveLink(spelled, { viewerHosts: typeof window === "undefined" ? [] : [window.location.host] });
  return resolved?.kind === "file" ? resolved : parseFileSpelling(spelled);
}

type DocumentKind = "markdown" | "html" | null;

function documentKind(path: string): DocumentKind {
  if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
  if (/\.html?$/i.test(path)) return "html";
  return null;
}

function kindLabel(t: TFunction, kind: ArtifactKind | null, doc: DocumentKind): string {
  if (doc === "markdown") return t("preview.kindMarkdown");
  if (doc === "html") return t("preview.kindHtml");
  if (kind === "pdf") return t("preview.kindPdf");
  if (kind === "image") return t("preview.kindImage");
  if (kind === "text") return t("preview.kindText");
  return t("preview.kindUnknown");
}

function failureCopy(t: TFunction, failure: ArtifactFailure): string {
  if (failure === "missing") return t("preview.missing");
  if (failure === "denied") return t("preview.denied");
  if (failure === "unsupported") return t("preview.unsupported");
  if (failure === "oversized") return t("preview.oversized");
  if (failure === "changed") return t("preview.changed");
  if (failure === "aborted") return t("preview.aborted");
  return t("preview.error");
}

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const value = Number(raw);
    if (Number.isFinite(value) && value >= MIN_WIDTH) return value;
  } catch {
    /* private mode */
  }
  return 560;
}

/**
 * The ONE in-app document preview surface (issue #875). Mounted once in the
 * Viewer shell; any rendered artifact link opens it through the preview bus.
 * A click-open is pure same-document React state: opening, switching and
 * closing write nothing to the URL, history, board or transcript, and trigger
 * no snapshot or scan — the only network the surface owns is /api/artifact.
 *
 * The `#a=` fragment (issue #884) is the surface's second entry point: a
 * pasted or bookmarked URL naming an artifact opens the same sheet on load,
 * through the same classifier and the same /api/artifact authorization —
 * unsupported, out-of-root and missing paths land on the explicit failure
 * states exactly as a click would. Only that entry touches the URL: hash
 * navigation away closes a fragment-opened sheet, and a user close strips the
 * fragment in place (replaceState, never push) so Back keeps the browser's
 * semantics and a reload does not resurrect the preview.
 */
export function ArtifactPreviewHost({ mobile }: { mobile: boolean }) {
  const [open, setOpen] = useState<OpenRequest | null>(null);
  useEffect(
    () =>
      onArtifactPreview((request) => {
        setOpen((previous) => ({
          path: request.path,
          target: request.target ?? previewTarget(request.path),
          nonce: (previous?.nonce ?? 0) + 1,
        }));
      }),
    [],
  );
  /* The initial `#a=` read IS this entry point's load: the fragment is
     invisible to the server render, so it applies exactly once on mount and
     then tracks hash navigation. */
  useEffect(() => {
    const applyFragment = () => {
      const path = parseArtifactFragment(window.location.hash);
      setOpen((previous) => {
        if (path !== null) return { path, target: previewTarget(path), nonce: (previous?.nonce ?? 0) + 1, fromFragment: true };
        /* The hash moved elsewhere (Back included): a preview the fragment
           opened follows it closed; a click-opened one is URL-independent
           state and stays. */
        return previous?.fromFragment ? null : previous;
      });
    };
    applyFragment();
    window.addEventListener("hashchange", applyFragment);
    return () => window.removeEventListener("hashchange", applyFragment);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    /* A URL still naming the artifact would resurrect it on reload. Replace
       in place — never push — so history length and Back stay untouched. */
    if (parseArtifactFragment(window.location.hash) !== null) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);
  if (!open) return null;
  return <PreviewSheet key="sheet" open={open} mobile={mobile} onClose={close} onReload={setOpen} />;
}

function PreviewSheet({
  open,
  mobile,
  onClose,
  onReload,
}: {
  open: OpenRequest;
  mobile: boolean;
  onClose: () => void;
  onReload: (next: OpenRequest) => void;
}) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  /* What the metadata read answered, tagged with the request it answered.
     A newer open renders before its own read has even started, so anything
     loaded for an earlier request is never shown with the new path — a pane
     mounted with the previous file's ETag would ask for the new file with the
     wrong If-Match and fail as "changed". */
  const [loaded, setLoaded] = useState<{ request: OpenRequest; meta: ArtifactMeta | null; failure: ArtifactFailure | null } | null>(null);
  const current = loaded?.request === open ? loaded : null;
  const meta = current?.meta ?? null;
  const failure = current?.failure ?? null;
  const [width, setWidth] = useState(storedWidth);
  const inset = useLeftShellInset();
  useModalLayer({ containerRef, onClose });

  /* The meta round-trip is the load this surface exists for, keyed to the
     open request; an aborted (superseded) read settles nothing. */
  useEffect(() => {
    const controller = new AbortController();
    const settle = (meta: ArtifactMeta | null, failure: ArtifactFailure | null) => {
      if (!controller.signal.aborted) setLoaded({ request: open, meta, failure });
    };
    void fetch(artifactMetaUrl(open.target.path), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          settle(null, failureFromStatus(response.status));
          return;
        }
        settle((await response.json()) as ArtifactMeta, null);
      })
      .catch(() => settle(null, "error"));
    return () => controller.abort();
  }, [open]);

  /* Desktop resize: pointer-drag on the left edge, clamped so the conversation
     stays visible; persisted so the next preview opens at the same width. */
  const resizeFrom = useCallback(
    (down: PointerEvent | { clientX: number }) => {
      const move = (event: PointerEvent) => {
        const next = Math.min(
          Math.max(MIN_WIDTH, window.innerWidth - event.clientX),
          roomForSheet(window.innerWidth, leftShellInset()),
        );
        setWidth(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setWidth((value) => {
          try {
            window.localStorage.setItem(WIDTH_KEY, String(value));
          } catch {
            /* private mode */
          }
          return value;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      void down;
    },
    [],
  );

  const target = open.target;
  const doc = documentKind(target.path);
  const name = meta?.name ?? artifactBasename(target.path);
  const kind = meta?.kind ?? classifyArtifact(target.path)?.kind ?? null;
  const state = failure ?? (meta ? "ready" : "loading");
  const reload = useCallback(
    () => onReload({ ...open, nonce: open.nonce + 1 }),
    [onReload, open],
  );
  /* A pane's failure belongs to the request that mounted it. */
  const onPaneFailure = useCallback(
    (code: ArtifactFailure) =>
      setLoaded((previous) => (previous && previous.request === open ? { ...previous, failure: code } : previous)),
    [open],
  );

  const body = failure ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <FileWarning className="h-8 w-8 text-warning" aria-hidden />
      <div className="max-w-[340px] text-[13px] font-semibold text-primary">{failureCopy(t, failure)}</div>
      {/* The path the link named, so a wrong or stale link is visible for what it is. */}
      <code data-preview-failure-path className="max-w-full break-all rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] text-muted">
        {target.path}
      </code>
      {meta ? <div className="text-[12px] text-muted">{formatBytes(meta.size)}</div> : null}
      {failure === "changed" || failure === "error" || failure === "aborted" ? (
        <button
          type="button"
          className="rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={reload}
        >
          {t("preview.reload")}
        </button>
      ) : null}
    </div>
  ) : !meta ? (
    <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted" role="status">
      {t("preview.loading")}
    </div>
  ) : meta.kind === "text" && doc === "markdown" ? (
    <MarkdownPane key={`${open.nonce}`} path={target.path} meta={meta} anchor={target.anchor} line={target.line} mobile={mobile} onFailure={onPaneFailure} />
  ) : meta.kind === "text" && doc === "html" && meta.frame ? (
    <HtmlPane key={`${open.nonce}`} path={target.path} meta={{ ...meta, frame: meta.frame }} anchor={target.anchor} line={target.line} mobile={mobile} onFailure={onPaneFailure} />
  ) : meta.kind === "text" ? (
    <TextPane key={`${open.nonce}`} path={target.path} meta={meta} line={target.line} mobile={mobile} onFailure={onPaneFailure} />
  ) : meta.kind === "image" ? (
    <ImagePane key={`${open.nonce}`} path={target.path} meta={meta} mobile={mobile} onFailure={onPaneFailure} />
  ) : (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted" role="status">
          {t("preview.loading")}
        </div>
      }
    >
      <PdfPane key={`${open.nonce}`} path={target.path} etag={meta.etag} mobile={mobile} onFailure={onPaneFailure} />
    </Suspense>
  );

  /* Portal to <body>: feed rows live under transformed board panes, and the
     sheet must anchor to the viewport, not a pane. */
  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t("preview.dialogTitle", { name })}
      data-artifact-preview
      data-artifact-state={state}
      data-artifact-kind={kind ?? ""}
      className={`fixed ${Z.sheet} flex flex-col border-border bg-card shadow-1 focus-visible:outline-none ${
        mobile ? "inset-0" : "inset-y-0 right-0 border-l"
      }`}
      data-artifact-preview-inset={mobile ? undefined : inset}
      /* `max()/min()` in CSS so the viewport term stays live without a resize
         listener; the inset term re-renders with the dock beside it. */
      style={mobile ? undefined : { width: `max(${MIN_WIDTH}px, min(${width}px, calc(100vw - ${MIN_CONVERSATION + inset}px)))` }}
    >
      {mobile ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("preview.resize")}
          title={t("preview.resize")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-accent/30"
          onPointerDown={(event) => {
            event.preventDefault();
            resizeFrom(event.nativeEvent);
          }}
        />
      )}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold text-primary" title={name}>
            {name}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span>{kindLabel(t, kind, doc)}</span>
            {meta ? <span aria-hidden>·</span> : null}
            {meta ? <span>{formatBytes(meta.size)}</span> : null}
          </div>
        </div>
        <a
          href={artifactContentUrl(target.path, { download: true })}
          download={name}
          aria-label={t("preview.download")}
          title={t("preview.download")}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <Download className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />
        </a>
        <a
          /* An HTML report opens as a page (in its sandbox), not as source text. */
          href={meta?.frame ? frameSource(meta.frame, target.anchor) : artifactContentUrl(target.path)}
          data-preview-open-external
          target="_blank"
          rel="noreferrer"
          aria-label={t("preview.openExternal")}
          title={t("preview.openExternal")}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <ExternalLink className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />
        </a>
        <button
          type="button"
          aria-label={t("preview.close")}
          title={t("preview.close")}
          onClick={onClose}
          className={`flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-7 w-7"}`}
        >
          <X className={mobile ? "h-5 w-5" : "h-4 w-4"} aria-hidden />
        </button>
      </div>
      {body}
    </div>,
    document.body,
  );
}
