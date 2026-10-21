"use client";
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { VoiceToolsView } from "@/lib/voiceTools/contracts";

type Server = VoiceToolsView["servers"][string];
type Body = { action: "dry-run" | "approve" | "reject" | "disable" | "remove"; name: string; digest: string }
  | { action: "configure"; name: string; digest: string; tools?: Server["tools"]; askBeforeActing?: boolean; reapprove?: true }
  | { action: "secrets"; secrets: Record<string, string> };
type Control = "secrets" | "dry-run" | "approve" | "reject" | "disable" | "remove" | "ask" | "tools";

const DRY_RUN_CODES = ["START_FAILED", "PROTOCOL_ERROR", "TIMEOUT", "CATALOG_BOUNDS", "SECRET_ECHO", "MISSING_SECRET", "ENTRY_CHANGED", "BUSY", "CANCELLED"];
const REFUSALS = ["STALE_APPROVAL", "DRY_RUN_REQUIRED", "MISSING_SECRET", "ENTRY_CHANGED", "SELECTION_BOUNDS", "CATALOG_BOUNDS", "OPERATOR_REQUIRED", "SERVER_NOT_FOUND", "TIMEOUT", "BUSY"];
/* Waiting servers first: they are what the operator opened this section for. */
const ORDER: Server["state"][] = ["pending", "changed", "enabled", "disabled", "rejected"];
const BUTTON = "min-h-9 rounded-[8px] border border-border px-3 text-[13px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 max-sm:min-h-11";
const PRIMARY = "min-h-9 rounded-[8px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 max-sm:min-h-11";
const FIELD = "min-h-9 w-full min-w-0 rounded-[8px] border border-border bg-well px-2.5 font-mono text-[13px] text-primary placeholder:text-muted placeholder:font-sans focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-55 max-sm:min-h-11";

function refusalKey(code: string, control: Control): MessageKey {
  /* Under Run dry run, BUSY is the hub's limit of eight dry runs and CATALOG_BOUNDS a tool list the store
     refused to save; the file lock answers VOICE_TOOLS_BUSY. */
  if (control === "dry-run" && (code === "BUSY" || code === "CATALOG_BOUNDS")) return `voiceCompanion.tools.refused.dryRun.${code}`;
  const known = code === "VOICE_TOOLS_BUSY" ? "BUSY" : code;
  return (REFUSALS.includes(known) ? `voiceCompanion.tools.refused.${known}` : "voiceCompanion.tools.refused.other") as MessageKey;
}
/** What will run, one shell word per part: a short word never breaks inside, so `--notes` never reads as `--` and `notes`. */
function commandWords(server: Server): string[] {
  if (server.transport.type !== "stdio") return [server.transport.url];
  return [server.transport.command, ...server.transport.args].map(part => /^[\w@%+=:,./-]+$/u.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`);
}

/**
 * The Tools section of the voice settings (docs/design/voice-extensible-tools.md
 * §3.3, §4.5; slice 1): what each proposed MCP server will run, its secrets by
 * name, its last dry run, the tools the operator lets the voice use, the per-server
 * «ask before acting» switch, and approve, reject, turn off and remove. Approval
 * happens here only, never through an agent. A secret value is sent once and the
 * route never returns it.
 */
export function VoiceToolsSetting() {
  const { t, locale } = useLocale();
  const [view, setView] = useState<VoiceToolsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [writing, setWriting] = useState<{ name: string; control: Control } | null>(null);
  const [refusal, setRefusal] = useState<{ name: string; control: Control; code: string } | null>(null);
  const sequence = useRef(0);
  /* Held from the press, before React redraws the controls disabled: a second press in the same frame is dropped. */
  const inFlight = useRef(false);
  const read = useCallback(async () => {
    const current = ++sequence.current;
    setLoadError(false);
    try {
      const response = await fetch("/api/voice-tools", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const next = await response.json() as VoiceToolsView;
      if (current === sequence.current) setView(next);
    } catch { if (current === sequence.current) setLoadError(true); }
    finally { if (current === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const answers = sequence;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void read(); });
    return () => { disposed = true; answers.current++; };
  }, [read]);

  /* One write at a time: every write carries the digest the operator was shown, so a second
     press on an older digest would only meet STALE_APPROVAL. */
  const post = async (body: Body): Promise<{ view: VoiceToolsView } | { code: string }> => {
    try {
      const response = await fetch("/api/voice-tools", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = await response.json().catch(() => ({})) as VoiceToolsView & { code?: string };
      if (!response.ok) return { code: typeof answer.code === "string" ? answer.code : "VOICE_TOOLS_UNAVAILABLE" };
      return { view: answer };
    } catch { return { code: "VOICE_TOOLS_UNAVAILABLE" }; }
  };
  /** Whether the route took the write. */
  const write = async (name: string, control: Control, body: Body, optimistic?: (server: Server) => Server): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const before = view;
    ++sequence.current;
    setRefusal(null);
    setWriting({ name, control });
    if (optimistic && before && Object.hasOwn(before.servers, name)) setView({ ...before, servers: { ...before.servers, [name]: optimistic(before.servers[name]) } });
    try {
      /* A change of the operator's own choices on an approved server keeps it approved: the route
         changes it and approves the moved digest in one write, and a refusal changes nothing. */
      const wasEnabled = before !== null && Object.hasOwn(before.servers, name) && before.servers[name].state === "enabled";
      const answer = await post(body.action === "configure" && wasEnabled ? { ...body, reapprove: true } : body);
      if ("view" in answer) { setView(answer.view); return true; }
      setRefusal({ name, control, code: answer.code });
      if (optimistic) setView(before);
      /* What the refusal judged may have moved on the server: show the current record beside the reason. */
      if (["STALE_APPROVAL", "SERVER_NOT_FOUND", "TIMEOUT", "ENTRY_CHANGED", "MISSING_SECRET"].includes(answer.code)) void read();
      return false;
    } finally { inFlight.current = false; setWriting(null); }
  };

  const servers = view ? Object.entries(view.servers).sort(([a, x], [b, y]) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state) || (a < b ? -1 : a > b ? 1 : 0)) : [];
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return <section data-voice-tools="" aria-labelledby="voice-tools-title" className="mt-4 min-w-0 border-t border-border pt-3 text-[13px] [overflow-wrap:anywhere]">
    <h3 id="voice-tools-title" className="flex min-h-11 items-center font-semibold">{t("voiceCompanion.tools.title")}</h3>
    <p className="text-muted">{t("voiceCompanion.tools.intro")}</p>
    <div role="status" data-voice-tools-status="" className="mt-2 min-h-5 text-muted empty:hidden">{loading && !view ? t("voiceCompanion.tools.loading") : loadError ? t("voiceCompanion.tools.error") : view && !servers.length ? t("voiceCompanion.tools.empty") : ""}</div>
    {loadError ? <button type="button" onClick={() => void read()} className="min-h-11 underline">{t("voiceCompanion.tools.retry")}</button> : null}
    {servers.length ? <ul className="mt-2 space-y-3" data-voice-tools-list="">
      {servers.map(([name, server]) => <ServerRow key={name} name={name} server={server} when={when} busy={writing !== null} writing={writing?.name === name ? writing.control : null}
        refusal={refusal?.name === name ? refusal : null} write={(control, body, optimistic) => write(name, control, body, optimistic)} />)}
    </ul> : null}
  </section>;
}

function ServerRow({ name, server, when, busy, writing, refusal, write }: {
  name: string; server: Server; when(iso: string): string; busy: boolean; writing: Control | null;
  refusal: { control: Control; code: string } | null;
  write(control: Control, body: Body, optimistic?: (server: Server) => Server): Promise<boolean>;
}) {
  const { t } = useLocale();
  const ids = { ask: useId(), askHint: useId(), dryRunHint: useId(), tools: useId() };
  /* Which references hold typed text. The values stay in the fields, as «Keys» keeps them, and are read once on Save. */
  const [typed, setTyped] = useState<ReadonlySet<string>>(new Set());
  const digest = server.digest;
  const reason = (control: Control) => refusal?.control === control
    ? <p role="alert" data-voice-tools-refused={refusal.code} className="mt-1.5 text-[13px] text-danger">{t(refusalKey(refusal.code, refusal.control))}</p> : null;
  const dryRun = server.lastDryRun;
  const passed = dryRun?.code === "OK" && server.catalog !== null;
  const blockedBySecrets = server.missingSecrets.length > 0;
  const transport = server.transport;
  const names = (list: string[]) => list.length ? list.join(", ") : t("voiceCompanion.tools.none");
  const state = server.state;
  const tone = state === "enabled" ? "text-success" : state === "pending" || state === "changed" ? "text-warning" : "text-muted";
  const toolCount = server.catalog?.tools.length ?? 0;
  return <li data-voice-tool-server={name} data-state={state} className="min-w-0 rounded-lg border border-border bg-card p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <p className="min-w-0 font-semibold text-primary">{server.title} <span className="font-mono text-[12px] font-normal text-muted">{name}</span></p>
      <p data-voice-tool-state={state} className={`text-[12px] font-semibold ${tone}`}>{t(`voiceCompanion.tools.state.${state}` as MessageKey)}</p>
    </div>
    <p className="mt-0.5 text-secondary">{server.capability}</p>
    <p className="mt-0.5 text-[12px] text-muted">{t(server.proposedBy.kind === "operator" ? "voiceCompanion.tools.proposedYou" : "voiceCompanion.tools.proposedAgent", { date: when(server.proposedBy.at) })}</p>

    <div className="mt-2" data-voice-tool-runs="">
      <p className="text-[12px] font-semibold text-muted">{t(transport.type === "stdio" ? "voiceCompanion.tools.runs" : "voiceCompanion.tools.connects")}</p>
      <code className="mt-0.5 block rounded-[6px] bg-well px-2 py-1 font-mono text-[12px] leading-snug text-primary [overflow-wrap:anywhere]">{commandWords(server).map((word, at) => <Fragment key={at}>{at ? " " : ""}<span className={word.length <= 32 ? "whitespace-nowrap" : undefined}>{word}</span></Fragment>)}</code>
      <div className="mt-1 space-y-0.5 text-[12px] leading-snug text-muted">
        {transport.type === "stdio" && transport.cwd ? <p>{t("voiceCompanion.tools.folder", { path: transport.cwd })}</p> : null}
        {transport.type === "stdio" ? <p data-voice-tool-env="">{t("voiceCompanion.tools.env", { names: names(transport.envNames) })}</p>
          : <p data-voice-tool-headers="">{t("voiceCompanion.tools.headers", { names: names(transport.headerNames) })}</p>}
        {server.entryFile ? <p data-voice-tool-entry="">{t("voiceCompanion.tools.entry", { path: server.entryFile.path, hash: `${server.entryFile.sha256.slice(0, 12)}…` })}</p> : null}
      </div>
    </div>

    {server.secretRefs.length ? <form className="mt-2" data-voice-tool-references="" onSubmit={event => {
      event.preventDefault();
      const fields = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input[data-reference]")];
      const secrets = Object.fromEntries(fields.flatMap(field => field.value && server.secretRefs.includes(field.dataset.reference!) ? [[field.dataset.reference!, field.value]] : []));
      if (!Object.keys(secrets).length) return;
      /* A refused save keeps what was typed beside its reason; a saved one clears the fields. */
      void write("secrets", { action: "secrets", secrets }).then(saved => {
        if (!saved) return;
        for (const field of fields) field.value = "";
        setTyped(new Set());
      });
    }}>
      <p className="text-[12px] font-semibold text-muted">{t("voiceCompanion.tools.secrets")}</p>
      <div className="mt-1 space-y-1.5">
        {server.secretRefs.map(ref => {
          const missing = server.missingSecrets.includes(ref);
          return <label key={ref} className="block min-w-0" data-voice-tool-reference={ref} data-missing={missing ? "" : undefined}>
            <span className="flex flex-wrap gap-x-1.5 text-[12px]"><span className="font-mono text-primary">{ref}</span><span className={missing ? "font-semibold text-warning" : "text-muted"}>{t(missing ? "voiceCompanion.tools.secretNeeded" : "voiceCompanion.tools.secretSaved")}</span></span>
            <input type="password" autoComplete="off" spellCheck={false} maxLength={8192} data-1p-ignore="" data-lpignore="true" disabled={busy}
              placeholder={missing ? "" : t("voiceCompanion.tools.secretReplace")} data-reference={ref}
              onChange={event => { const filled = event.target.value.length > 0; setTyped(current => { const next = new Set(current); if (filled) next.add(ref); else next.delete(ref); return next; }); }} className={`${FIELD} mt-0.5`} />
          </label>;
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="submit" disabled={busy || !typed.size} className={BUTTON}>{t("voiceCompanion.tools.secretsSave")}</button>
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-muted">{t("voiceCompanion.tools.secretsNote")}</p>
      </div>
      {reason("secrets")}
    </form> : null}

    <p role="status" data-voice-tool-dry-run={dryRun?.code ?? "none"} className={`mt-2 text-[12px] leading-snug ${dryRun && !passed ? "text-danger" : "text-muted"}`}>
      {!dryRun ? t("voiceCompanion.tools.dryRun.none")
        : passed ? t("voiceCompanion.tools.dryRun.ok", { time: when(dryRun.at), count: toolCount })
        : t("voiceCompanion.tools.dryRun.failed", { time: when(dryRun.at), reason: t((DRY_RUN_CODES.includes(dryRun.code) ? `voiceCompanion.tools.dryRun.${dryRun.code}` : "voiceCompanion.tools.dryRun.PROTOCOL_ERROR") as MessageKey) })}
    </p>

    {server.catalog && server.catalog.tools.length ? <fieldset className="mt-2 min-w-0" data-voice-tool-tools="">
      <legend id={ids.tools} className="text-[12px] font-semibold text-muted">{t("voiceCompanion.tools.toolList")}</legend>
      <ul aria-labelledby={ids.tools} tabIndex={server.catalog.tools.length > 6 ? 0 : undefined} className="mt-1 max-h-[36dvh] space-y-1 overflow-y-auto overscroll-contain">
        {server.catalog.tools.map(tool => {
          const choice = server.tools[tool.name] ?? { enabled: false, acts: tool.annotations?.readOnlyHint !== true };
          return <li key={tool.name} data-voice-tool={tool.name}>
            <label className="flex min-h-9 cursor-pointer items-start gap-2.5 py-1 max-sm:min-h-11">
              <input type="checkbox" checked={choice.enabled} disabled={busy} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)] max-sm:h-5 max-sm:w-5"
                onChange={event => {
                  const tools = { ...server.tools, [tool.name]: { ...choice, enabled: event.target.checked } };
                  void write("tools", { action: "configure", name, digest, tools }, current => ({ ...current, tools }));
                }} />
              <span className="min-w-0">
                <span className="font-mono text-[12px] text-primary">{tool.name}</span>
                <span className="text-[12px] text-muted"> · {t(choice.acts ? "voiceCompanion.tools.acts" : "voiceCompanion.tools.reads")}</span>
                {tool.description ? <span className="block text-[12px] leading-snug text-secondary">{tool.description}</span> : null}
              </span>
            </label>
          </li>;
        })}
      </ul>
    </fieldset> : null}
    {reason("tools")}

    <label className="mt-2 flex min-h-11 items-center justify-between gap-4 font-semibold">
      <span id={ids.ask}>{t("voiceCompanion.tools.ask")}</span>
      <input type="checkbox" role="switch" data-voice-tool-ask="" aria-labelledby={ids.ask} aria-describedby={ids.askHint} checked={server.askBeforeActing} disabled={busy}
        onChange={event => {
          const askBeforeActing = event.target.checked;
          void write("ask", { action: "configure", name, digest, askBeforeActing }, current => ({ ...current, askBeforeActing }));
        }} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
    </label>
    <p id={ids.askHint} className="text-[12px] leading-snug text-muted">{t("voiceCompanion.tools.askHint")}</p>
    {reason("ask")}

    <div className="mt-3 flex flex-wrap gap-2" data-voice-tool-actions="">
      {state !== "enabled" ? <>
        <button type="button" data-voice-tool-action="dry-run" disabled={busy || blockedBySecrets} aria-busy={writing === "dry-run" || undefined} aria-describedby={transport.type === "stdio" ? ids.dryRunHint : undefined} className={BUTTON}
          onClick={() => void write("dry-run", { action: "dry-run", name, digest })}>{t(writing === "dry-run" ? "voiceCompanion.tools.action.running" : "voiceCompanion.tools.action.dryRun")}</button>
        <button type="button" data-voice-tool-action="approve" disabled={busy || !passed || blockedBySecrets} className={PRIMARY}
          onClick={() => void write("approve", { action: "approve", name, digest })}>{t("voiceCompanion.tools.action.approve")}</button>
      </> : <button type="button" data-voice-tool-action="disable" disabled={busy} className={BUTTON} onClick={() => void write("disable", { action: "disable", name, digest })}>{t("voiceCompanion.tools.action.disable")}</button>}
      {state === "pending" || state === "changed"
        ? <button type="button" data-voice-tool-action="reject" disabled={busy} className={BUTTON} onClick={() => void write("reject", { action: "reject", name, digest })}>{t("voiceCompanion.tools.action.reject")}</button>
        : <button type="button" data-voice-tool-action="remove" disabled={busy} className={BUTTON} onClick={() => void write("remove", { action: "remove", name, digest })}>{t("voiceCompanion.tools.action.remove")}</button>}
    </div>
    {state !== "enabled" && transport.type === "stdio" ? <p id={ids.dryRunHint} data-voice-tool-dry-run-hint="" className="mt-1.5 text-[12px] leading-snug text-muted">{t("voiceCompanion.tools.dryRunHint")}</p> : null}
    {reason("dry-run")}{reason("approve")}{reason("reject")}{reason("disable")}{reason("remove")}
  </li>;
}
