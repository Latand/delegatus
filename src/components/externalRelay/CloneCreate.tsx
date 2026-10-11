"use client";

import { ArrowUpRight, Bot, Check, Dices, ImageOff, Plus, RotateCcw, Sparkles, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cloneAvatarPrompt,
  createUrlAllowed,
  deriveCloneUsername,
  randomCloneName,
  validCloneName,
  validCloneUsername,
} from "@/lib/externalRelay/cloneNames";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale, type TFunction } from "@/lib/i18n";

import { alertLine, call, Dot, FOCUS, HEAD, LINK, openBlankWindow, ownerLine, PRIMARY, QUIET } from "./relayUi";

/**
 * «Створити клона» in a paired relay's card (docs/research/celestia-clone-creation.md,
 * variant 1): the form unfolds in the card below the clone rows — name with 🎲,
 * the @username derived from it, a photo (upload, Celestia's generated
 * candidates, or none) — and «Створити в Telegram» opens the relay's
 * `t.me/newbot` link. While Telegram is open a pending row and a note naming
 * the paired account wait; the relay's answer, read every 2.5 s, turns into
 * the new row marked «Новий». Shown only while the relay's descriptor lists
 * `clone_create`.
 */

export const CLONE_POLL_MS = 2_500;
/** Past its expiry the relay is asked once more, then the wait ends here. */
const EXPIRY_GRACE_MS = 30_000;
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export type CloneRequestView = { request_id: string; create_url: string; expires_at: string; name: string; username: string; requestedAt: string };
/** The relay's record of a clone created while its request was open here (store.ts `RelayCloneCreated`). */
export type CloneCreatedView = { request_id: string; target_id: string | null; name: string; username: string; photo_failed: boolean; createdAt: string };
type CloneStatus = { status: "pending" | "created" | "expired" | "failed"; target_id?: string; username?: string; reason?: string };
type Photo =
  | { kind: "none" }
  | { kind: "upload"; data: string; preview: string }
  | { kind: "candidate"; storage_key: string; preview: string };
type Candidate = { storage_key: string; preview: string };
export type ClonePhase =
  | { kind: "idle" }
  | { kind: "form" }
  | { kind: "waiting"; request: CloneRequestView }
  | { kind: "created"; requestId: string; name: string; username: string; targetId: string | null; photoFailed: boolean }
  | { kind: "ended"; status: "expired" | "failed"; reason: string | null };

const FIELD = `h-8 min-w-0 rounded-control border border-border bg-card px-2 text-ui text-primary disabled:opacity-50 max-sm:h-11 max-sm:text-body ${FOCUS}`;
const ICON_BUTTON = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-border bg-card text-secondary hover:text-accent disabled:opacity-50 max-sm:h-11 max-sm:w-11 ${FOCUS}`;
const SELECTED = "ring-2 ring-accent ring-offset-2 ring-offset-canvas";

const telegramLink = (username: string) => `https://t.me/${encodeURIComponent(username)}`;
const createdPhase = (created: CloneCreatedView): ClonePhase => ({
  kind: "created", requestId: created.request_id, name: created.name, username: created.username, targetId: created.target_id, photoFailed: created.photo_failed,
});

async function readAsBase64(file: File): Promise<{ data: string; preview: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const data = btoa(binary);
  return { data, preview: `data:${file.type || "image/jpeg"};base64,${data}` };
}

/** The block's state for one relay: the form's fields, the open request and how it ended. */
export function useCloneCreate({ relayId, stored, created, onChanged }: {
  relayId: string;
  stored: CloneRequestView | null;
  /** A created clone whose setup is not done yet: a page that missed the relay's answer picks it up here. */
  created: CloneCreatedView | null;
  onChanged: () => Promise<void>;
}) {
  const { locale } = useLocale();
  const base = `/api/external-relay/relays/${encodeURIComponent(relayId)}`;
  const [phase, setPhase] = useState<ClonePhase>(() => created ? createdPhase(created) : stored ? { kind: "waiting", request: stored } : { kind: "idle" });
  const [name, setNameValue] = useState("");
  const [username, setUsernameValue] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [photo, setPhoto] = useState<Photo>({ kind: "none" });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Requests this page has seen end: a stale relay read that still lists one does not resume its wait. */
  const ended = useRef(new Set<string>());

  const storedId = stored?.request_id ?? null;
  useEffect(() => {
    if (!stored || ended.current.has(stored.request_id)) return;
    setPhase((current) => current.kind === "idle" ? { kind: "waiting", request: stored } : current);
  // The stored request is read again only when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedId]);
  const createdId = created?.request_id ?? null;
  useEffect(() => {
    if (!created || ended.current.has(created.request_id)) return;
    ended.current.add(created.request_id);
    // An open form or an ended request gives way too: no other clone starts until this one is set up.
    setPhase((current) => current.kind === "created" || (current.kind === "waiting" && current.request.request_id !== created.request_id) ? current : createdPhase(created));
  // The created record is read again only when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdId]);

  const setName = (value: string) => {
    setNameValue(value);
    if (!usernameTouched) setUsernameValue(deriveCloneUsername(value));
  };
  const setUsername = (value: string) => { setUsernameValue(value.trim().replace(/^@/, "")); setUsernameTouched(true); };
  const roll = () => {
    const next = randomCloneName(locale === "uk" ? "uk" : "en", name);
    setNameValue(next); setUsernameValue(deriveCloneUsername(next)); setUsernameTouched(false);
  };
  const open = () => {
    setError(null);
    if (!name) roll();
    setPhase({ kind: "form" });
  };
  const close = () => { setError(null); setPhase({ kind: "idle" }); };

  const upload = async (file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > UPLOAD_MAX_BYTES) { setError("photo_too_large"); return; }
    try {
      const read = await readAsBase64(file);
      setPhoto({ kind: "upload", ...read });
    } catch { setError("photo_unreadable"); }
  };
  const generate = async () => {
    if (!validCloneName(name)) return;
    setGenerating(true); setError(null);
    const result = await call<{ candidates: Candidate[] }>(`${base}/clone-avatars`, "POST", { prompt: cloneAvatarPrompt(name) });
    setGenerating(false);
    if (!result.ok) { setError(result.error); return; }
    const list = Array.isArray(result.value.candidates) ? result.value.candidates.slice(0, 4) : [];
    setCandidates(list);
    if (list[0]) setPhoto({ kind: "candidate", ...list[0] });
  };

  const valid = validCloneName(name) && validCloneUsername(username);
  const submit = async (t: TFunction) => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const win = openBlankWindow(t("externalRelay.clone.opening"));
    const wire = photo.kind === "upload" ? { kind: "upload", data: photo.data } : photo.kind === "candidate" ? { kind: "candidate", storage_key: photo.storage_key } : null;
    const result = await call<{ request: CloneRequestView }>(`${base}/clone-requests`, "POST", { name: name.trim(), username, photo: wire });
    setBusy(false);
    if (!result.ok) {
      win?.close(); setError(result.error);
      // Another page created a clone whose setup is not done: the read brings its record, which takes the card.
      if (result.error === "clone_setup_pending") await onChanged();
      return;
    }
    const request = result.value.request;
    if (win && createUrlAllowed(request.create_url)) {
      try { win.location.href = request.create_url; } catch { win.close(); }
    } else win?.close();
    setPhase({ kind: "waiting", request });
  };

  const finish = useCallback(async (request: CloneRequestView, status: CloneStatus) => {
    ended.current.add(request.request_id);
    if (status.status === "created") {
      setPhase({ kind: "created", requestId: request.request_id, name: request.name, username: status.username || request.username, targetId: status.target_id ?? null, photoFailed: status.reason === "photo_failed" });
      // The next clone starts from a new name and no photo.
      setNameValue(""); setUsernameValue(""); setUsernameTouched(false); setPhoto({ kind: "none" }); setCandidates([]);
    } else setPhase({ kind: "ended", status: status.status === "expired" ? "expired" : "failed", reason: status.reason ?? null });
    await onChanged();
  }, [onChanged]);

  const waitingId = phase.kind === "waiting" ? phase.request.request_id : null;
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const request = phase.request;
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      const result = await call<{ request: CloneStatus }>(`${base}/clone-requests/${encodeURIComponent(request.request_id)}`, "GET");
      reading = false;
      if (!active) return;
      if (result.ok && result.value.request?.status && result.value.request.status !== "pending") {
        active = false;
        await finish(request, result.value.request);
        return;
      }
      if (!result.ok && result.error === "not_found") {
        active = false;
        await finish(request, { status: "failed" });
        return;
      }
      setError(result.ok ? null : result.error);
      if (Date.now() > Date.parse(request.expires_at) + EXPIRY_GRACE_MS) {
        active = false;
        await call(`${base}/clone-requests/${encodeURIComponent(request.request_id)}`, "DELETE");
        await finish(request, { status: "expired" });
      }
    };
    const timer = window.setInterval(() => void read(), CLONE_POLL_MS);
    void read();
    return () => { active = false; window.clearInterval(timer); };
  // The poll restarts only for another request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingId, base, finish]);

  const cancel = async () => {
    if (phase.kind !== "waiting") return;
    setBusy(true); setError(null);
    const result = await call(`${base}/clone-requests/${encodeURIComponent(phase.request.request_id)}`, "DELETE");
    setBusy(false);
    if (!result.ok && result.error !== "not_found") { setError(result.error); return; }
    ended.current.add(phase.request.request_id);
    setPhase({ kind: "form" });
    await onChanged();
  };

  return {
    phase, name, username, photo, candidates, generating, busy, error, valid,
    setName, setUsername, roll, open, close, upload, generate, submit, cancel,
    chooseNone: () => setPhoto({ kind: "none" }),
    chooseCandidate: (candidate: Candidate) => setPhoto({ kind: "candidate", ...candidate }),
    again: () => { setError(null); setPhase({ kind: "form" }); },
  };
}
export type CloneCreateState = ReturnType<typeof useCloneCreate>;

/** One automatic retry after a failed setup step, then the card says so and offers «Повторити». */
const SETUP_TRIES = 2;
const SETUP_RETRY_MS = 3_000;
type SetupTarget = { id: string; engine: string | null; answered_by: "install" | "service" };

/**
 * Sets a created clone up to be answered here: the default engine with its
 * default model while it has none, then the route to this install while the
 * relay routes it elsewhere. Each step runs only while it is still needed, so
 * a retry after a partial success repeats only what failed. When both are
 * done the relay's created record is forgotten; until then a reopened card
 * runs the setup again, and `settled` stays false so the card offers no new
 * clone (the server refuses one too) that could take the record's place.
 */
export function useCloneSetup({ relayId, phase, recorded, target, engine, onChanged }: {
  relayId: string;
  phase: ClonePhase;
  /** The request id of the relay's created record, while the settings read lists one. */
  recorded: string | null;
  /** The created clone's row, once the relay lists it. */
  target: SetupTarget | null;
  engine: "claude" | "codex" | null;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/external-relay/relays/${encodeURIComponent(relayId)}`;
  const requestId = phase.kind === "created" ? phase.requestId : null;
  const [state, setState] = useState<{ requestId: string; status: "running" | "failed" | "done"; error: string | null } | null>(null);
  const latest = useRef({ recorded, target, engine, onChanged });
  useEffect(() => { latest.current = { recorded, target, engine, onChanged }; });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = useCallback(async (id: string) => {
    for (let attempt = 1; ; attempt++) {
      setState({ requestId: id, status: "running", error: null });
      const { target: current, engine: chosen } = latest.current;
      let error: string | null = current && chosen ? null : "not_found";
      if (current && chosen && current.engine === null) {
        const set = await call(base, "PATCH", { target: { id: current.id, engine: chosen, model: defaultModelFor(chosen) } });
        if (!set.ok) error = set.error;
      }
      if (!error && current && current.answered_by !== "install") {
        const routed = await call(`${base}/targets/${encodeURIComponent(current.id)}`, "PATCH", { answered_by: "install" });
        if (!routed.ok) error = routed.error;
      }
      if (!error && latest.current.recorded === id) {
        const forgot = await call(`${base}/clone-requests/${encodeURIComponent(id)}`, "DELETE");
        if (!forgot.ok && forgot.error !== "not_found") error = forgot.error;
      }
      if (!alive.current) return;
      if (!error) {
        setState({ requestId: id, status: "done", error: null });
        await latest.current.onChanged();
        return;
      }
      // The next try starts from the relay's current row, so a step that went through is not repeated.
      await latest.current.onChanged();
      if (!alive.current) return;
      if (attempt >= SETUP_TRIES) { setState({ requestId: id, status: "failed", error }); return; }
      await new Promise((resolve) => window.setTimeout(resolve, SETUP_RETRY_MS));
      if (!alive.current) return;
    }
  }, [base]);

  const ready = target !== null && engine !== null;
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!requestId || !ready || started.current === requestId) return;
    started.current = requestId;
    void run(requestId);
  }, [requestId, ready, run]);

  const current = state && state.requestId === requestId ? state : null;
  return {
    /** No created clone waits for its setup here; a clone the relay named no target for has nothing to set up. */
    settled: phase.kind !== "created" || phase.targetId === null || current?.status === "done",
    failed: current?.status === "failed" ? current.error ?? "unavailable" : null,
    retry: () => { if (requestId && current?.status !== "running") void run(requestId); },
  };
}
export type CloneSetupState = ReturnType<typeof useCloneSetup>;

/** With no clones yet: one dashed block with the primary button, where «no targets» stood. */
export function CloneEmpty({ relayName, clone }: { relayName: string; clone: CloneCreateState }) {
  const { t } = useLocale();
  return (
    <div data-clone-empty="" className="flex min-w-0 flex-col gap-2.5 rounded-control border border-dashed border-strong px-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-dashed border-strong bg-sunken text-muted"><Bot className="h-3.5 w-3.5" /></span>
        <p className="min-w-0 text-ui leading-4 text-secondary">{t("externalRelay.clone.emptyLead", { name: relayName })}</p>
      </div>
      <button type="button" data-clone-open="" onClick={clone.open} className={`${PRIMARY} self-start max-sm:w-full`}><Plus className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.create")}</button>
    </div>
  );
}

/** Below the clone rows: the list's own row, in the accent. */
export function CloneCreateRow({ clone }: { clone: CloneCreateState }) {
  const { t } = useLocale();
  return (
    <button type="button" data-clone-open="" onClick={clone.open}
      className={`flex min-h-9 min-w-0 items-center gap-2 border-t border-border px-1 text-left text-ui font-semibold text-accent hover:bg-sunken max-sm:min-h-11 ${FOCUS}`}>
      <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />{t("externalRelay.clone.create")}
    </button>
  );
}

function Portrait({ src, size = 36, selected = false }: { src: string; size?: number; selected?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} className={`shrink-0 rounded-full bg-sunken object-cover ${selected ? SELECTED : ""}`} style={{ width: size, height: size }} />
  );
}

/** Upload, Generate and No photo as quiet actions, then the chosen upload or the generated candidates. */
function PhotoChooser({ clone }: { clone: CloneCreateState }) {
  const { t } = useLocale();
  const file = useRef<HTMLInputElement>(null);
  const { photo, candidates } = clone;
  return (
    <div data-clone-photo={photo.kind} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-caption font-semibold text-secondary">{t("externalRelay.clone.photo")}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0">
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden data-clone-upload-input=""
          onChange={(event) => { void clone.upload(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" data-clone-upload="" disabled={clone.busy} onClick={() => file.current?.click()} className={QUIET}><Upload className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.upload")}</button>
        <button type="button" data-clone-generate="" disabled={clone.busy || clone.generating || !validCloneName(clone.name)} onClick={() => void clone.generate()} className={QUIET}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden />{t(clone.generating ? "externalRelay.clone.generating" : "externalRelay.clone.generate")}
        </button>
        <button type="button" data-clone-no-photo="" aria-pressed={photo.kind === "none"} disabled={clone.busy} onClick={clone.chooseNone} className={`${QUIET} aria-pressed:text-accent`}><ImageOff className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.noPhoto")}</button>
      </div>
      {photo.kind === "upload" || candidates.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 pt-0.5">
          {photo.kind === "upload" ? (
            <span data-clone-uploaded="" className="grid shrink-0 place-items-center max-sm:min-h-11 max-sm:min-w-11" title={t("externalRelay.clone.uploaded")}><Portrait src={photo.preview} selected /></span>
          ) : null}
          {candidates.map((candidate, index) => {
            const chosen = photo.kind === "candidate" && photo.storage_key === candidate.storage_key;
            return (
              <button key={candidate.storage_key} type="button" data-clone-candidate={index} aria-pressed={chosen} aria-label={t("externalRelay.clone.candidate", { number: index + 1 })}
                disabled={clone.busy} onClick={() => clone.chooseCandidate(candidate)} className={`grid shrink-0 place-items-center rounded-full max-sm:min-h-11 max-sm:min-w-11 ${FOCUS}`}>
                <Portrait src={candidate.preview} selected={chosen} />
              </button>
            );
          })}
        </div>
      ) : null}
      {candidates.length ? <p className="text-caption leading-4 text-muted">{t("externalRelay.clone.generated")}</p> : null}
    </div>
  );
}

/** The form, in place in the card: name with 🎲, the @username, the photo, then «Створити в Telegram». */
export function CloneForm({ clone, errorText, bare = false }: { clone: CloneCreateState; errorText: (code: string) => string; bare?: boolean }) {
  const { t } = useLocale();
  const usernameBad = clone.username !== "" && !validCloneUsername(clone.username);
  return (
    <form data-clone-form="" className={`flex min-w-0 flex-col gap-3 px-1 pb-1 ${bare ? "" : "border-t border-border pt-3"}`}
      onSubmit={(event) => { event.preventDefault(); void clone.submit(t); }}>
      <p className={HEAD}>{t("externalRelay.clone.create")}</p>
      <div className="flex min-w-0 flex-col gap-2.5">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-semibold text-secondary">{t("externalRelay.clone.name")}</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <input data-clone-name="" value={clone.name} maxLength={64} disabled={clone.busy} onChange={(event) => clone.setName(event.target.value)} className={`${FIELD} flex-1`} />
            <button type="button" data-clone-random="" aria-label={t("externalRelay.clone.random")} title={t("externalRelay.clone.random")} disabled={clone.busy} onClick={clone.roll} className={ICON_BUTTON}><Dices className="h-4 w-4" aria-hidden /></button>
          </span>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-semibold text-secondary">{t("externalRelay.clone.username")}</span>
          <span className="flex min-w-0 items-center">
            <span aria-hidden className="inline-flex h-8 items-center rounded-l-control border border-r-0 border-border bg-sunken px-2 text-ui text-muted max-sm:h-11 max-sm:text-body">@</span>
            <input data-clone-username="" value={clone.username} maxLength={32} disabled={clone.busy} aria-invalid={usernameBad || undefined} spellCheck={false} autoCapitalize="none"
              onChange={(event) => clone.setUsername(event.target.value)} className={`${FIELD} flex-1 rounded-l-none`} />
          </span>
          <span data-clone-username-hint="" className={`text-caption leading-4 ${usernameBad ? "text-danger" : "text-muted"}`}>{t(usernameBad ? "externalRelay.clone.usernameInvalid" : "externalRelay.clone.usernameHint")}</span>
        </label>
      </div>
      <PhotoChooser clone={clone} />
      {clone.error ? alertLine(errorText(clone.error)) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <button type="submit" data-clone-submit="" disabled={!clone.valid || clone.busy || clone.generating} className={PRIMARY}><ArrowUpRight className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.toTelegram")}</button>
        <button type="button" data-clone-close="" disabled={clone.busy} onClick={clone.close} className={`${QUIET} max-sm:justify-center`}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}

/** The row the clone will take, held at rest while Telegram creates it. */
export function ClonePendingRow({ clone }: { clone: CloneCreateState }) {
  const { t } = useLocale();
  if (clone.phase.kind !== "waiting") return null;
  const preview = clone.photo.kind === "none" ? null : clone.photo.preview;
  return (
    <div data-clone-pending-row="" className="flex min-h-9 min-w-0 items-center gap-2 border-t border-border px-1 first:border-t-0 max-sm:min-h-11">
      {preview ? <Portrait src={preview} size={14} /> : <Dot tone="warn" className="mx-1" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-semibold leading-4 text-secondary">{clone.phase.request.name}</span>
        <span className="truncate text-caption text-muted">{t("externalRelay.clone.creatingRow")}</span>
      </span>
    </div>
  );
}

/** Below the card's list: waiting for Telegram, created, or how the request ended. */
export function CloneStatus({ clone, setup, owner, here, name, errorText }: {
  clone: CloneCreateState;
  setup: CloneSetupState;
  owner: { display_name: string; handle: string | null };
  /** Whether the new clone's row is answered by this install, with an engine to answer it. */
  here: boolean;
  /** The new row's name as Telegram confirmed it; the requested name stands in until the relay lists it. */
  name: string | null;
  errorText: (code: string) => string;
}) {
  const { t } = useLocale();
  const { phase } = clone;
  if (phase.kind === "waiting") {
    const link = createUrlAllowed(phase.request.create_url) ? phase.request.create_url : null;
    return (
      <div data-clone-waiting={phase.request.request_id} className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border bg-card px-3 py-2.5">
        <p role="status" className="flex items-start gap-1.5 text-ui font-semibold text-primary"><Dot tone="warn" className="mt-[5px]" />{t("externalRelay.clone.waiting")}</p>
        <p data-clone-owner="" className="pl-3 text-caption leading-4 text-muted">{t("externalRelay.clone.waitingLead", { owner: ownerLine(owner) })}</p>
        {clone.error ? <div className="pl-3">{alertLine(errorText(clone.error))}</div> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-3">
          {link ? <a href={link} target="_blank" rel="noopener noreferrer" data-clone-open-again="" className={`${LINK} text-ui max-sm:min-h-11`}>{t("externalRelay.clone.openAgain")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></a> : null}
          <button type="button" data-clone-cancel="" disabled={clone.busy} onClick={() => void clone.cancel()} className={QUIET}>{t("common.cancel")}</button>
        </div>
      </div>
    );
  }
  if (phase.kind === "created") {
    return (
      <div data-clone-created={phase.targetId ?? ""} className="flex min-w-0 flex-col gap-1">
        <p role="status" className="flex items-start gap-1.5 text-ui text-primary"><Check className="mt-px h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          <span className="min-w-0 break-words">{t(here ? "externalRelay.clone.created" : "externalRelay.clone.createdByService", { name: name || phase.name, username: phase.username })}</span>
        </p>
        {setup.failed ? (
          <div data-clone-setup-failed={setup.failed} className="flex min-w-0 flex-col gap-1 pl-5">
            {alertLine(t("externalRelay.clone.setupFailed", { error: errorText(setup.failed) }))}
            <button type="button" data-clone-setup-retry="" onClick={setup.retry} className={`${QUIET} self-start`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.setupRetry")}</button>
          </div>
        ) : null}
        {phase.photoFailed ? <p data-clone-photo-failed="" className="pl-5 text-caption leading-4 text-warning">{t("externalRelay.clone.photoFailed")}</p> : null}
        <a href={telegramLink(phase.username)} target="_blank" rel="noopener noreferrer" data-clone-open-bot="" className={`${LINK} self-start pl-5 text-ui max-sm:min-h-11`}>{t("externalRelay.clone.openBot")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></a>
      </div>
    );
  }
  if (phase.kind === "ended") {
    const endedReason = phase.reason === "bot_username_taken" ? t("externalRelay.clone.reason.bot_username_taken") : null;
    return (
      <div data-clone-ended={phase.status} className="flex min-w-0 flex-col gap-1.5">
        <p role="status" className="flex items-start gap-1.5 text-ui text-primary"><Dot tone={phase.status === "failed" ? "danger" : "muted"} className="mt-[5px]" />{t(phase.status === "failed" ? "externalRelay.clone.failed" : "externalRelay.clone.expired")}</p>
        {endedReason ? <p data-clone-ended-reason="" className="pl-3 text-caption leading-4 text-muted">{endedReason}</p> : null}
        <button type="button" data-clone-again="" onClick={clone.again} className={`${QUIET} self-start`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.clone.again")}</button>
      </div>
    );
  }
  return null;
}
