"use client";

import { Check, KeyRound, Link2, MoreHorizontal, Send, Smartphone, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AccessQrImage, AccessQrLink } from "@/components/AccessQrButton";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import { MEMBER_COLOR_HEX, MEMBER_COLORS, type MemberColor, type TeamView } from "@/lib/team/contract";

import { MemberAvatar } from "./MemberAvatar";
import { errorText } from "./SignInCard";
import { refreshTeamView } from "./teamClient";
import { BUTTON, Field, INPUT, loopbackLink, relativeTime, TeamDialog, teamRequest } from "./ui";

type TeamMember = TeamView["members"][number];

interface OpenInvite { id: string; invitedName: string | null; expiresAt: string }
interface JoinRequest { id: string; firstName: string | null; username: string | null; requestedAt: string }

export function surfaceName(t: TFunction, surface: string | null): string {
  return t(`team.surface.${surface === "desktop" || surface === "phone" || surface === "tablet" ? surface : "other"}`);
}

/** "on a phone" / "на телефоні": the place a sign-in happened, with its preposition, so no sentence quotes a generic noun. */
export function surfaceOn(t: TFunction, surface: string | null): string {
  return t(`team.surfaceOn.${surface === "desktop" || surface === "phone" || surface === "tablet" ? surface : "other"}`);
}

function presence(t: TFunction, member: TeamMember, locale: "en" | "uk"): string {
  if (!member.lastSeenAt) return t("team.presence.never");
  if (member.online) return t("team.presence.online", { surface: surfaceName(t, member.lastSurface) });
  return t("team.presence.seen", { age: relativeTime(member.lastSeenAt, locale) });
}

export function MembersTab({ view }: { view: TeamView }) {
  const { t, locale } = useLocale();
  const owner = view.me?.role === "owner";
  const [invites, setInvites] = useState<OpenInvite[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [dialog, setDialog] = useState<"invite" | "approve" | { member: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    if (!owner) return;
    const answer = await teamRequest<{ invites: OpenInvite[]; requests: JoinRequest[] }>("/api/team/invites");
    if (answer.ok) {
      setInvites(answer.body.invites);
      setRequests(answer.body.requests);
    }
  }, [owner]);

  useEffect(() => {
    void loadInvites();
    if (!owner) return;
    /* A join request arrives from Telegram while the page is open. */
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadInvites(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadInvites, owner]);

  const answerRequest = async (id: string, approve: boolean) => {
    setError(null);
    const answer = await teamRequest(`/api/team/join-requests/${id}`, { body: { approve } });
    if (!answer.ok) setError(errorText(t, answer));
    await Promise.all([loadInvites(), refreshTeamView()]);
  };

  const withdraw = async (id: string) => {
    await teamRequest(`/api/team/invites/${id}`, { method: "DELETE" });
    await loadInvites();
  };

  const active = view.members.filter((member) => member.status === "active");
  const revoked = view.members.filter((member) => member.status === "revoked");
  const selected = dialog && typeof dialog === "object" ? view.members.find((member) => member.id === dialog.member) ?? null : null;

  return (
    <div className="flex flex-col gap-4" data-team-members="">
      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:grid max-sm:grid-cols-2">
        <button type="button" className={BUTTON.small} onClick={() => setDialog("approve")} data-team-approve-open="">
          <Smartphone className="h-3.5 w-3.5" aria-hidden />{t("team.approveDevice")}
        </button>
        {owner ? (
          <button type="button" className={BUTTON.smallPrimary} onClick={() => setDialog("invite")} data-team-invite-open="">
            <UserPlus className="h-3.5 w-3.5" aria-hidden />{t("team.invite")}
          </button>
        ) : null}
      </div>

      {requests.map((request) => (
        <div key={request.id} data-team-join-request={request.id} className="flex flex-wrap items-center gap-3 rounded-surface border border-accent/30 bg-accent-soft px-4 py-3">
          <Send className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 text-ui text-primary">
            {t("team.request.asked", {
              name: [request.firstName, request.username ? `@${request.username}` : null].filter(Boolean).join(" ") || "Telegram",
              age: relativeTime(request.requestedAt, locale),
            })}
          </span>
          <span className="flex gap-2">
            <button type="button" className={BUTTON.smallPrimary} onClick={() => void answerRequest(request.id, true)}>{t("team.request.approve")}</button>
            <button type="button" className={BUTTON.small} onClick={() => void answerRequest(request.id, false)}>{t("team.request.deny")}</button>
          </span>
        </div>
      ))}

      <ul className="overflow-hidden rounded-surface border border-border bg-card" aria-label={t("team.tabs.members")}>
        {active.map((member) => (
          <MemberRow key={member.id} member={member} me={view.me?.id ?? null} canEdit={owner || member.id === view.me?.id} onOpen={() => setDialog({ member: member.id })} locale={locale} t={t} />
        ))}
        {revoked.map((member) => (
          <MemberRow key={member.id} member={member} me={view.me?.id ?? null} canEdit={owner} onOpen={() => setDialog({ member: member.id })} locale={locale} t={t} />
        ))}
      </ul>

      {owner && invites.length ? (
        <section aria-label={t("team.invite.open")}>
          <h2 className="mb-1.5 px-1 text-label font-semibold text-secondary">{t("team.invite.open")}</h2>
          <ul className="overflow-hidden rounded-surface border border-border bg-card">
            {invites.map((invite) => (
              <li key={invite.id} data-team-invite={invite.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ui text-primary">
                  {invite.invitedName ?? t("team.invite.unnamed")}
                  <span className="text-muted"> · {t("team.invite.expires", { time: relativeTime(invite.expiresAt, locale) })}</span>
                </span>
                <button type="button" className={BUTTON.text} onClick={() => void withdraw(invite.id)}>{t("team.invite.withdraw")}</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-ui text-danger">{error}</p> : null}

      {dialog === "invite" ? <InviteDialog onClose={() => { setDialog(null); void loadInvites(); }} /> : null}
      {dialog === "approve" ? <ApproveDeviceDialog onClose={() => setDialog(null)} /> : null}
      {selected ? <MemberDialog member={selected} view={view} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function MemberRow({ member, me, canEdit, onOpen, locale, t }: {
  member: TeamMember;
  me: string | null;
  canEdit: boolean;
  onOpen: () => void;
  locale: "en" | "uk";
  t: TFunction;
}) {
  const revoked = member.status === "revoked";
  const online = !revoked && member.online;
  return (
    <li data-team-member={member.id} className={`flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 max-sm:px-3 ${revoked ? "opacity-60" : ""}`}>
      <span className="relative">
        <MemberAvatar name={member.name} initials={member.initials} color={member.color} size={32} />
        {online ? <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-success" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-body font-semibold text-primary" data-team-member-name="">{member.name}</span>
          {member.id === me ? <span className="shrink-0 text-label text-muted">{t("team.you")}</span> : null}
          <span className={`shrink-0 rounded-full px-1.5 py-px text-caption font-semibold ${member.role === "owner" ? "bg-accent-soft text-accent" : revoked ? "bg-sunken text-muted" : "bg-sunken text-secondary"}`}>
            {revoked ? t("team.role.revoked") : t(`team.role.${member.role}`)}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-label text-muted">
          {/* The pill already says "revoked"; the line says when. */}
          {revoked ? (
            member.revokedAt ? <span>{t("team.member.revokedAt", { age: relativeTime(member.revokedAt, locale) })}</span> : null
          ) : (
            <span className={online ? "text-success" : undefined}>{presence(t, member, locale)}</span>
          )}
          {member.telegram ? (
            <span className="inline-flex items-center gap-1"><Send className="h-3 w-3" aria-hidden />{member.telegram.username ? `@${member.telegram.username}` : member.telegram.firstName ?? "Telegram"}</span>
          ) : null}
          {member.passkeys ? (
            <span className="inline-flex items-center gap-1"><KeyRound className="h-3 w-3" aria-hidden />{t("team.passkey.count", { count: member.passkeys })}</span>
          ) : null}
        </div>
      </div>
      {canEdit ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("team.member.edit", { name: member.name })}
          data-team-member-open={member.id}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

/** Invite someone (§6.3): a name, optional, and a link that works once for
    seven days. The link is shown here once and never again. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = useLocale();
  const [name, setName] = useState("");
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    const answer = await teamRequest<{ url: string; expiresAt: string }>("/api/team/invites", { body: { name } });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    setLink(answer.body);
  };
  return (
    <TeamDialog title={t("team.invite.title")} onClose={onClose} closeLabel={t("common.close")} testId="invite">
      {link ? (
        <div className="flex flex-col gap-3" data-team-invite-link="">
          <div className="flex justify-center rounded-control border border-border bg-card p-2">
            <AccessQrImage url={link.url} size={196} />
          </div>
          <AccessQrLink url={link.url} copyLabel={t("common.copy")} />
          {loopbackLink(link.url) ? <p className="rounded-control bg-warning-soft px-3 py-2 text-label leading-snug text-warning" data-team-invite-loopback="">{t("team.invite.loopback")}</p> : null}
          <p className="text-label leading-snug text-muted">{t("team.invite.note", { time: relativeTime(link.expiresAt, locale, Date.now(), "long") })}</p>
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("team.done")}</button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Field label={t("team.invite.name")}>
            <input className={INPUT} value={name} maxLength={60} autoFocus onChange={(event) => setName(event.target.value)} data-team-invite-name="" />
          </Field>
          <button type="submit" disabled={busy} className={BUTTON.primary} data-team-invite-create="">{t("team.invite.create")}</button>
          {error ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
        </form>
      )}
    </TeamDialog>
  );
}

/** Approve a device (§5.2): the code the new device shows, then which device
    asked, then yes. The new device becomes this member. */
function ApproveDeviceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const [code, setCode] = useState("");
  const [request, setRequest] = useState<{ id: string; surface: string; browser: string } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lookup = async () => {
    setBusy(true);
    setError(null);
    const answer = await teamRequest<{ id: string; surface: string; browser: string }>("/api/team/session/approve", { body: { code } });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    setRequest(answer.body);
  };
  const confirm = async (approve: boolean) => {
    if (!request) return;
    setBusy(true);
    const answer = await teamRequest("/api/team/session/approve", { body: { id: request.id, approve } });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    if (approve) setDone(true);
    else onClose();
  };
  const browserName = request ? t(`team.browser.${["chrome", "safari", "firefox", "edge"].includes(request.browser) ? request.browser : "other"}` as MessageKey) : "";
  return (
    <TeamDialog title={t("team.approve.title")} onClose={onClose} closeLabel={t("common.close")} testId="approve">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-soft text-success"><Check className="h-5 w-5" aria-hidden /></span>
          <p className="text-body text-primary">{t("team.approve.done")}</p>
          <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("team.done")}</button>
        </div>
      ) : request ? (
        <div className="flex flex-col gap-4">
          <p className="text-body text-primary" data-team-approve-question="">{t("team.approve.confirm", { surfaceOn: surfaceOn(t, request.surface), browser: browserName })}</p>
          <div className="flex gap-2 max-sm:flex-col">
            <button type="button" disabled={busy} className={`${BUTTON.primary} sm:flex-1`} onClick={() => void confirm(true)} data-team-approve-yes="">{t("team.approve.yes")}</button>
            <button type="button" disabled={busy} className={`${BUTTON.secondary} sm:flex-1`} onClick={() => void confirm(false)}>{t("team.approve.no")}</button>
          </div>
          {error ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
          <Field label={t("team.approve.code")} hint={t("team.approve.hint")}>
            <input
              className={`${INPUT} font-mono text-[18px] uppercase tracking-[0.2em]`}
              value={code}
              maxLength={8}
              autoFocus
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="KJ7-4MP"
              onChange={(event) => setCode(event.target.value)}
              data-team-approve-code=""
            />
          </Field>
          <button type="submit" disabled={busy || code.replace(/[^A-Za-z0-9]/g, "").length !== 6} className={BUTTON.primary} data-team-approve-lookup="">{t("team.approve.next")}</button>
          {error ? <p role="alert" className="text-ui text-danger">{error}</p> : null}
        </form>
      )}
    </TeamDialog>
  );
}

interface PasskeyRow { id: string; label: string; rpId: string; here: boolean; createdAt: string; lastUsedAt: string | null }

/** A member's settings (§6.9): name and colour for oneself or, by the owner,
    anyone; one's own Telegram link and passkeys; the owner's revoke. */
function MemberDialog({ member, view, onClose }: { member: TeamMember; view: TeamView; onClose: () => void }) {
  const { t, locale } = useLocale();
  const self = member.id === view.me?.id;
  const owner = view.me?.role === "owner";
  const [name, setName] = useState(member.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [passkeys, setPasskeys] = useState<{ available: boolean; passkeys: PasskeyRow[] } | null>(null);
  const [telegram, setTelegram] = useState<{ id: string; proof: string; url: string } | null>(null);

  const loadPasskeys = useCallback(async () => {
    if (!self) return;
    const answer = await teamRequest<{ available: boolean; passkeys: PasskeyRow[] }>("/api/team/passkeys");
    if (answer.ok) setPasskeys(answer.body);
  }, [self]);
  useEffect(() => { void loadPasskeys(); }, [loadPasskeys]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const answer = await teamRequest(`/api/team/members/${member.id}`, { method: "PATCH", body });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(t, answer));
      return false;
    }
    await refreshTeamView();
    return true;
  };

  /* Linking Telegram: open the bot, press Start, and this dialog hears it. */
  useEffect(() => {
    if (!telegram) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const answer = await teamRequest<{ state: string }>(`/api/team/session/telegram/${telegram.id}`, { body: { proof: telegram.proof } });
      if (!alive) return;
      if (answer.ok && answer.body.state !== "waiting") {
        setTelegram(null);
        if (answer.body.state === "taken") setError(t("team.error.telegramTaken"));
        await refreshTeamView();
        return;
      }
      timer = window.setTimeout(poll, 3_000);
    };
    timer = window.setTimeout(poll, 3_000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [telegram, t]);

  const linkTelegram = async () => {
    setError(null);
    const answer = await teamRequest<{ id: string; proof: string; url: string }>("/api/team/session/telegram", { body: { purpose: "link" } });
    if (!answer.ok) return setError(answer.code === "telegram_unavailable" ? t("team.telegram.unavailable") : errorText(t, answer));
    setTelegram(answer.body);
    window.open(answer.body.url, "_blank", "noopener");
  };

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await teamRequest<{ id: string; options: unknown }>("/api/team/passkeys", { body: { step: "options" } });
      if (!options.ok) return setError(errorText(t, options));
      const { startRegistration } = await import("@simplewebauthn/browser");
      let response;
      try {
        response = await startRegistration({ optionsJSON: options.body.options as never });
      } catch {
        return;
      }
      const saved = await teamRequest("/api/team/passkeys", { body: { step: "verify", id: options.body.id, response } });
      if (!saved.ok) return setError(errorText(t, saved));
      await Promise.all([loadPasskeys(), refreshTeamView()]);
    } finally {
      setBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    await teamRequest("/api/team/passkeys", { method: "DELETE", body: { id } });
    await Promise.all([loadPasskeys(), refreshTeamView()]);
  };

  const section = "flex flex-col gap-2 border-t border-border pt-4";
  return (
    <TeamDialog title={member.name} onClose={onClose} closeLabel={t("common.close")} testId="member">
      <div className="flex flex-col gap-4">
        {member.status === "active" ? (
          <>
            <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void patch({ name }); }}>
              <div className="min-w-0 flex-1">
                <Field label={t("team.member.name")}>
                  <input className={INPUT} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} data-team-member-rename="" />
                </Field>
              </div>
              <button type="submit" disabled={busy || !name.trim() || name.trim() === member.name} className={BUTTON.secondary}>{t("team.member.save")}</button>
            </form>
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-semibold text-secondary">{t("team.member.color")}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("team.member.color")}>
                {MEMBER_COLORS.map((color: MemberColor) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={member.color === color}
                    aria-label={t(`kanban.color.${color}`)}
                    onClick={() => void patch({ color })}
                    className={`flex h-8 w-8 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-11 ${member.color === color ? "ring-2 ring-primary ring-offset-2 ring-offset-card" : ""}`}
                  >
                    <span className="h-6 w-6 rounded-full" style={{ backgroundColor: MEMBER_COLOR_HEX[color] }} />
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {self ? (
          <div className={section}>
            <span className="text-label font-semibold text-secondary">Telegram</span>
            {member.telegram ? (
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ui text-primary">{member.telegram.username ? `@${member.telegram.username}` : member.telegram.firstName}</span>
                <button type="button" className={BUTTON.text} onClick={() => void teamRequest("/api/team/telegram", { method: "DELETE" }).then(() => refreshTeamView())}>{t("team.telegram.unlink")}</button>
              </div>
            ) : telegram ? (
              <p className="flex items-center gap-2 text-ui text-secondary" aria-live="polite">
                <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />{t("team.telegram.waiting")}
              </p>
            ) : (
              <button type="button" className={`${BUTTON.small} self-start`} onClick={() => void linkTelegram()} data-team-link-telegram="">
                <Send className="h-3.5 w-3.5" aria-hidden />{t("team.telegram.link")}
              </button>
            )}
          </div>
        ) : null}

        {self && passkeys ? (
          <div className={section}>
            <span className="text-label font-semibold text-secondary">{t("team.passkey.title")}</span>
            {passkeys.passkeys.map((passkey) => (
              <div key={passkey.id} className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ui text-primary">
                  {passkey.label}<span className="text-muted"> · {passkey.rpId}</span>
                </span>
                <button type="button" className={BUTTON.text} onClick={() => void removePasskey(passkey.id)}>{t("team.passkey.remove")}</button>
              </div>
            ))}
            {passkeys.available ? (
              <button type="button" disabled={busy} className={`${BUTTON.small} self-start`} onClick={() => void addPasskey()} data-team-add-passkey="">
                <KeyRound className="h-3.5 w-3.5" aria-hidden />{t("team.passkey.add")}
              </button>
            ) : (
              <p className="text-label leading-snug text-muted">{t("team.passkey.unavailable")}</p>
            )}
          </div>
        ) : null}

        {owner && !self ? (
          <div className={section}>
            {member.status === "revoked" ? (
              <button type="button" disabled={busy} className={`${BUTTON.small} self-start`} onClick={() => void patch({ status: "active" })}>{t("team.member.restore")}</button>
            ) : confirmRevoke ? (
              <>
                <p className="text-ui leading-relaxed text-secondary">{t("team.member.revokeConfirm", { name: member.name })}</p>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} className={BUTTON.danger} onClick={() => void patch({ status: "revoked" }).then((ok) => { if (ok) onClose(); })} data-team-revoke-confirm="">{t("team.member.revoke")}</button>
                  <button type="button" className={BUTTON.text} onClick={() => setConfirmRevoke(false)}>{t("common.cancel")}</button>
                </div>
              </>
            ) : (
              <button type="button" className={`${BUTTON.danger} self-start`} onClick={() => setConfirmRevoke(true)} data-team-revoke="">{t("team.member.revoke")}</button>
            )}
          </div>
        ) : null}

        {member.status === "active" && member.createdAt ? (
          <p className="text-label text-muted">{t("team.member.since", { age: relativeTime(member.createdAt, locale) })}</p>
        ) : null}
        {error ? <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-ui text-danger">{error}</p> : null}
      </div>
    </TeamDialog>
  );
}
