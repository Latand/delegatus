"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SettingSwitch } from "@/components/ProjectSettingRow";
import { ActionsRow, BlockRow, BUTTON, CAUTION, DetailsRow, FIELD, LinkRow, Literal, PRIMARY, RefusalLine, SectionHead, SwitchRow, TextRow, useDensity } from "@/components/settings/settingsRows";
import type { DotTone } from "@/components/settings/StatusDot";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { UncontainedConsent, VoiceToolsView } from "@/lib/voiceTools/contracts";

type Server = VoiceToolsView["servers"][string];
type Body = { action: "dry-run"; name: string; digest: string; confirmUncontained?: UncontainedConsent }
  | { action: "approve" | "reject" | "disable" | "remove"; name: string; digest: string }
  | { action: "configure"; name: string; digest: string; tools?: Server["tools"]; askBeforeActing?: boolean; reapprove?: true }
  | { action: "secrets"; secrets: Record<string, { value?: string; destinations: string[] }> };
type Control = "secrets" | "dry-run" | "approve" | "reject" | "disable" | "remove" | "ask" | "tools";

const DRY_RUN_CODES = ["CONTAINMENT_REQUIRED", "START_FAILED", "PROTOCOL_ERROR", "TIMEOUT", "CATALOG_BOUNDS", "SECRET_ECHO", "SECRET_DESTINATION", "MISSING_SECRET", "ENTRY_CHANGED", "BUSY", "CANCELLED"];
const REFUSALS = ["SECRET_DESTINATION", "STALE_APPROVAL", "DRY_RUN_REQUIRED", "MISSING_SECRET", "ENTRY_CHANGED", "SELECTION_BOUNDS", "CATALOG_BOUNDS", "OPERATOR_REQUIRED", "SERVER_NOT_FOUND", "TIMEOUT", "BUSY"];
/* Waiting servers first: they are what the operator opened this section for. */
const ORDER: Server["state"][] = ["pending", "changed", "enabled", "disabled", "rejected"];

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
 * The Tools of the voice settings (docs/design/voice-extensible-tools.md §3.3,
 * §4.5; slice 1): what each proposed MCP server will run, its secrets by name,
 * its last dry run, the tools the operator lets the voice use, the per-server
 * «ask before acting» switch, and approve, reject, turn off and remove. Approval
 * happens here only, never through an agent. A secret value is sent once and the
 * route never returns it. This hook holds the record both the section's rows and
 * a tool's page read.
 */
export function useVoiceTools() {
  const [view, setView] = useState<VoiceToolsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
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
      if (current === sequence.current) setSignInRequired(response.status === 401 || response.status === 403);
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
  return { view, servers, loading, loadError, signInRequired, writing, refusal, read, write };
}
export type VoiceTools = ReturnType<typeof useVoiceTools>;

const STATE_TONE: Record<Server["state"], DotTone> = { enabled: "ok", pending: "warn", changed: "warn", disabled: "off", rejected: "off" };
/* A long tool list gets a filter. */
const FILTER_ABOVE = 6;

/** One row per server, waiting ones first, and how a tool gets here. */
export function VoiceToolRows({ tools, onOpen }: { tools: VoiceTools; onOpen: (name: string, title: string) => void }) {
  const { t } = useLocale();
  const { view, servers, loading, loadError, signInRequired, read } = tools;
  const status = loading && !view ? t("voiceCompanion.tools.loading") : loadError ? t(signInRequired ? "voiceCompanion.tools.signIn" : "voiceCompanion.tools.error") : view && !servers.length ? t("voiceCompanion.tools.empty") : "";
  return <div data-voice-tools="" data-settings-landing="" tabIndex={-1} role="group" aria-label={t("voiceCompanion.tools.title")} className="outline-none">
    <SectionHead title={t("voiceCompanion.tools.title")} />
    {status ? <TextRow tone="muted" role="status" attrs={{ "data-voice-tools-status": "" }}>{status}</TextRow> : null}
    {loadError ? <BlockRow><button type="button" onClick={() => void read()} className={BUTTON}>{t("voiceCompanion.tools.retry")}</button></BlockRow> : null}
    {servers.length ? <div data-voice-tools-list="">
      {servers.map(([name, server]) => <LinkRow
        key={name}
        attrs={{ "data-voice-tool-server": name, "data-state": server.state }}
        sub={`tool:${name}`}
        label={server.title}
        dot={{ tone: STATE_TONE[server.state], note: t(`voiceCompanion.tools.state.${server.state}` as MessageKey) }}
        value={<span data-voice-tool-state={server.state}>{t(`voiceCompanion.tools.state.${server.state}` as MessageKey)}</span>}
        hint={server.capability}
        onOpen={() => onOpen(name, server.title)}
      />)}
    </div> : null}
    {/* The route has no way to propose a server: asking is the quick path, and only the operator approves here. */}
    <LinkRow attrs={{ "data-voice-tool-add": "" }} label={t("settings.voice.addTool")} hint={t("settings.voice.addToolHint")} />
  </div>;
}

/** A tool's page: what it does and what its dry run means in words, its actions, and the technical record behind «Details». */
export function VoiceToolPage({ name, tools }: { name: string; tools: VoiceTools }) {
  const { locale } = useLocale();
  const server = tools.view?.servers[name];
  if (!server) return null;
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return <ServerPage key={name} name={name} server={server} when={when} busy={tools.writing !== null} writing={tools.writing?.name === name ? tools.writing.control : null}
    refusal={tools.refusal?.name === name ? tools.refusal : null} write={(control, body, optimistic) => tools.write(name, control, body, optimistic)} />;
}

function ServerPage({ name, server, when, busy, writing, refusal, write }: {
  name: string; server: Server; when(iso: string): string; busy: boolean; writing: Control | null;
  refusal: { control: Control; code: string } | null;
  write(control: Control, body: Body, optimistic?: (server: Server) => Server): Promise<boolean>;
}) {
  const { t } = useLocale();
  const ids = { dryRunHint: useId(), uncontained: useId(), tools: useId() };
  const density = useDensity();
  /* Which references hold typed text. The values stay in the fields, as «Keys» keeps them, and are read once on Save. */
  const [typed, setTyped] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const digest = server.digest;
  const reason = (control: Control) => refusal?.control === control
    ? <RefusalLine attrs={{ "data-voice-tools-refused": refusal.code }}>{t(refusalKey(refusal.code, refusal.control))}</RefusalLine> : null;
  const dryRun = server.lastDryRun;
  const needsConfirmation = dryRun?.code === "CONTAINMENT_REQUIRED" && dryRun.runId && dryRun.containmentReason;
  const passed = dryRun?.code === "OK" && server.catalog !== null;
  const blockedBySecrets = server.missingSecrets.length > 0;
  const transport = server.transport;
  /* A literal variable or header shows its value, so what is approved is what runs; a secret one shows its name only. */
  const variables = (list: string[], values: Record<string, string>): ReactNode => !list.length ? t("voiceCompanion.tools.none")
    : <span data-settings-variables="">{list.map((entry, at) => <span key={entry}>{at ? ", " : ""}<Literal text={Object.hasOwn(values, entry) ? `${entry}=${values[entry]}` : t("voiceCompanion.tools.secretValue", { name: entry })} /></span>)}</span>;
  const state = server.state;
  const toolCount = server.catalog?.tools.length ?? 0;
  const label = (key: MessageKey, slot: string) => t(key, { [slot]: "\u0000" }).split("\u0000")[0]!.replace(/[:\s]+$/, "");
  const catalog = server.catalog?.tools ?? [];
  const shownTools = filter.trim() ? catalog.filter(tool => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase())) : catalog;
  const waiting = state === "pending" || state === "changed";
  const dryRunLine = !dryRun ? t("voiceCompanion.tools.dryRun.none")
    : passed ? t("voiceCompanion.tools.dryRun.ok", { time: when(dryRun.at), count: toolCount })
    : t("voiceCompanion.tools.dryRun.failed", { time: when(dryRun.at), reason: t((DRY_RUN_CODES.includes(dryRun.code) ? `voiceCompanion.tools.dryRun.${dryRun.code}` : "voiceCompanion.tools.dryRun.PROTOCOL_ERROR") as MessageKey) });
  return <div data-voice-tool-server={name} data-state={state} className="flex flex-1 flex-col break-words pb-4 pt-2 font-normal settings-sheet:pt-1">
    <TextRow>{server.capability}</TextRow>
    <TextRow tone="muted">
      <span data-voice-tool-state={state}>{t(`voiceCompanion.tools.state.${state}` as MessageKey)}</span>
      {" · "}
      {t(server.proposedBy.kind === "operator" ? "voiceCompanion.tools.proposedYou" : "voiceCompanion.tools.proposedAgent", { date: when(server.proposedBy.at) })}
    </TextRow>
    <SwitchRow
      label={t("voiceCompanion.tools.ask")}
      hint={t("voiceCompanion.tools.askHint")}
      enabled={server.askBeforeActing}
      disabled={busy}
      onToggle={() => { const askBeforeActing = !server.askBeforeActing; void write("ask", { action: "configure", name, digest, askBeforeActing }, current => ({ ...current, askBeforeActing })); }}
      switchAttrs={{ "data-voice-tool-ask": "" }}
    >{reason("ask")}</SwitchRow>

    {server.secretRefs.length ? <div data-voice-tool-references-block="" data-settings-unit="">
      <SectionHead title={t("voiceCompanion.tools.secrets")} />
      <BlockRow><form data-voice-tool-references="" onSubmit={event => {
      event.preventDefault();
      const fields = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input[data-reference]")];
      const form = event.currentTarget;
      const secrets = Object.fromEntries(fields.flatMap(field => {
        const ref = field.dataset.reference!;
        const destinations = [...form.querySelectorAll<HTMLInputElement>("input[data-destinations]")].find(input => input.dataset.destinations === ref)?.value.trim().split(/[\s,]+/).filter(Boolean) ?? [];
        return typed.has(ref) && destinations.length ? [[ref, { ...(field.value ? { value: field.value } : {}), destinations }]] : [];
      }));
      if (!Object.keys(secrets).length) return;
      /* A refused save keeps what was typed beside its reason; a saved one clears the fields. */
      void write("secrets", { action: "secrets", secrets }).then(saved => {
        if (!saved) return;
        for (const field of fields) field.value = "";
        setTyped(new Set());
      });
    }}>
      <div className="flex flex-col gap-3">
        {server.secretRefs.map(ref => {
          const missing = server.missingSecrets.includes(ref);
          return <div key={ref} className="min-w-0" data-voice-tool-reference={ref} data-missing={missing ? "" : undefined}>
            <span className="flex flex-wrap items-baseline gap-x-1.5 text-ui"><Literal text={ref} /><span className={missing ? "font-semibold text-warning" : "text-muted"}>{t(missing ? "voiceCompanion.tools.secretNeeded" : "voiceCompanion.tools.secretSaved")}</span></span>
            <input type="password" aria-label={ref} autoComplete="off" spellCheck={false} minLength={8} maxLength={8192} data-1p-ignore="" data-lpignore="true" disabled={busy}
              placeholder={missing ? "" : t("voiceCompanion.tools.secretReplace")} data-reference={ref}
              onChange={event => { const filled = event.target.value.length > 0; setTyped(current => { const next = new Set(current); if (filled) next.add(ref); else next.delete(ref); return next; }); }} className={`${FIELD} mt-1 font-mono`} />
            <label className="mt-1.5 block text-ui text-muted">{t("voiceCompanion.tools.destinations")}
              <input type="text" data-destinations={ref} defaultValue={server.secretDestinations?.[ref]?.join(", ") ?? ""} maxLength={4096} disabled={busy} required={typed.has(ref)}
                placeholder={server.secretRecipient} className={`${FIELD} mt-1 font-mono`}
                onChange={() => setTyped(current => new Set([...current, ref]))} />
            </label>
            <p data-voice-tool-destinations="" className="mt-1 text-ui leading-snug text-muted">{t("voiceCompanion.tools.destinationsSaved", { hosts: server.secretDestinations?.[ref]?.join(", ") || t("voiceCompanion.tools.none") })}</p>
          </div>;
        })}
      </div>
      <div className="mt-2 flex flex-col items-start gap-1.5">
        <button type="submit" disabled={busy || !typed.size} className={BUTTON}>{t("voiceCompanion.tools.secretsSave")}</button>
        <p className="text-ui leading-snug text-muted">{t("voiceCompanion.tools.secretsNote")}</p>
      </div>
    </form></BlockRow>
    {reason("secrets")}
    </div> : null}

    <TextRow tone={dryRun && !passed ? "warning" : "muted"} role="status" attrs={{ "data-voice-tool-dry-run": dryRun?.code ?? "none" }}>{dryRunLine}</TextRow>
    {state !== "enabled" && transport.type === "stdio" && needsConfirmation ? <div role="alert" data-voice-tool-uncontained="" data-settings-unit="">
      <TextRow tone="warning" attrs={{ "data-voice-tool-platform": "" }}>{t(`voiceCompanion.tools.containment.${needsConfirmation}` as MessageKey)}</TextRow>
      <TextRow attrs={{ id: ids.uncontained }}>{t("voiceCompanion.tools.uncontained.warning")}</TextRow>
      <TextRow tone="muted">{t("voiceCompanion.tools.uncontained.once")}</TextRow>
    </div> : null}
    {dryRun?.confirmation ? <TextRow tone="muted" attrs={{ "data-voice-tool-confirmation": "" }}>{t("voiceCompanion.tools.uncontained.record", { time: when(dryRun.confirmation.at), tool: dryRun.confirmation.tool })}</TextRow> : null}

    {catalog.length ? <div data-voice-tool-tools="" role="group" aria-labelledby={ids.tools}>
      <div id={ids.tools}><SectionHead title={t("voiceCompanion.tools.toolList")} count={catalog.length} /></div>
      {catalog.length > FILTER_ABOVE ? <BlockRow><input type="search" data-voice-tool-filter="" value={filter} aria-label={t("settings.voice.toolFilter")} placeholder={t("settings.voice.toolFilter")} onChange={event => setFilter(event.target.value)} className={FIELD} /></BlockRow> : null}
      {shownTools.length === 0 ? <TextRow tone="muted" attrs={{ "data-voice-tool-filter-none": "" }}>{t("settings.voice.toolFilterNone")}</TextRow> : null}
      {shownTools.map(tool => {
        const choice = server.tools[tool.name] ?? { enabled: false, acts: tool.annotations?.readOnlyHint !== true };
        return <div key={tool.name} data-voice-tool={tool.name} data-settings-unit="" className={`flex items-center gap-3 ${density === "sheet" ? "min-h-11 px-4 py-1.5" : "min-h-10 px-5 py-1.5"}`}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-ui leading-snug">
            <span><Literal text={tool.name} /><span className="text-muted"> · {t(choice.acts ? "voiceCompanion.tools.acts" : "voiceCompanion.tools.reads")}</span></span>
            {tool.description ? <span className="block text-secondary">{tool.description}</span> : null}
          </span>
          <SettingSwitch enabled={choice.enabled} disabled={busy} size={density === "sheet" ? "sheet" : "row"} className={density === "sheet" ? "-mr-1.5" : ""} aria-label={tool.name}
            onClick={() => {
              const tools = { ...server.tools, [tool.name]: { ...choice, enabled: !choice.enabled } };
              void write("tools", { action: "configure", name, digest, tools }, current => ({ ...current, tools }));
            }} />
        </div>;
      })}
    </div> : null}
    {reason("tools")}

    {reason("dry-run")}{reason("approve")}{reason("reject")}{reason("disable")}{reason("remove")}
    <ActionsRow foot attrs={{ "data-voice-tool-actions": "" }} note={state !== "enabled" && !passed ? t("settings.voice.approveAfterDryRun") : undefined}>
      {/* The safe answer is the one filled action; what the page warns about is a secondary in the warning colour. */}
      {state !== "enabled" ? <>
        {waiting ? <button type="button" data-voice-tool-action="reject" disabled={busy} className={passed ? BUTTON : PRIMARY} onClick={() => void write("reject", { action: "reject", name, digest })}>{t("voiceCompanion.tools.action.reject")}</button> : null}
        <button type="button" data-voice-tool-action="approve" disabled={busy || !passed || blockedBySecrets} className={passed ? PRIMARY : BUTTON}
          onClick={() => void write("approve", { action: "approve", name, digest })}>{t("voiceCompanion.tools.action.approve")}</button>
        <button type="button" data-voice-tool-action="dry-run" disabled={busy || blockedBySecrets} aria-busy={writing === "dry-run" || undefined} aria-describedby={transport.type === "stdio" ? ids.dryRunHint : undefined} className={BUTTON}
          onClick={() => void write("dry-run", { action: "dry-run", name, digest })}>{t(writing === "dry-run" ? "voiceCompanion.tools.action.running" : "voiceCompanion.tools.action.dryRun")}</button>
        {transport.type === "stdio" && needsConfirmation ? <button type="button" data-voice-tool-action="confirm-uncontained" disabled={busy || blockedBySecrets} aria-describedby={ids.uncontained} className={CAUTION}
          onClick={() => void write("dry-run", { action: "dry-run", name, digest, confirmUncontained: { reason: needsConfirmation, runId: dryRun!.runId! } })}>{t("voiceCompanion.tools.uncontained.confirm")}</button> : null}
      </> : <button type="button" data-voice-tool-action="disable" disabled={busy} className={BUTTON} onClick={() => void write("disable", { action: "disable", name, digest })}>{t("voiceCompanion.tools.action.disable")}</button>}
      {waiting ? null : <button type="button" data-voice-tool-action="remove" disabled={busy} className={BUTTON} onClick={() => void write("remove", { action: "remove", name, digest })}>{t("voiceCompanion.tools.action.remove")}</button>}
    </ActionsRow>

    <DetailsRow lines={[
      { label: t("settings.voice.toolId"), value: <Literal text={name} /> },
      { label: t(transport.type === "stdio" ? "voiceCompanion.tools.runs" : "voiceCompanion.tools.connects"), attrs: { "data-voice-tool-runs": "" }, value: <span data-settings-command="">{commandWords(server).map((word, at) => <span key={at}>{at ? " " : ""}<Literal text={word} /></span>)}</span> },
      transport.type === "stdio" && transport.cwd ? { label: label("voiceCompanion.tools.folder", "path"), value: <Literal text={transport.cwd} /> } : null,
      transport.type === "stdio"
        ? { label: label("voiceCompanion.tools.env", "names"), attrs: { "data-voice-tool-env": "" }, value: variables(transport.envNames, transport.envValues) }
        : { label: label("voiceCompanion.tools.headers", "names"), attrs: { "data-voice-tool-headers": "" }, value: variables(transport.headerNames, transport.headerValues) },
      server.entryFile ? { label: label("voiceCompanion.tools.entry", "path"), attrs: { "data-voice-tool-entry": "" }, value: <><Literal text={server.entryFile.path} />{" · SHA-256\u00a0"}<Literal text={`${server.entryFile.sha256.slice(0, 12)}…`} /></> } : null,
      state !== "enabled" && transport.type === "stdio" ? { label: t("settings.voice.dryRunDetail"), attrs: { id: ids.dryRunHint, "data-voice-tool-dry-run-hint": "" }, value: t("voiceCompanion.tools.dryRunHint") } : null,
      { label: t("voiceCompanion.tools.title"), value: t("voiceCompanion.tools.intro") },
    ]} />
  </div>;
}
