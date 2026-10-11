"use client";

/*
 * Prototype only (docs/design/role-avatars.md): the `role-avatars` case of the
 * conversation fixture, copied into the export by render-frames.ts. It renders
 * the production FeedItem rows, patched to draw RoleAvatar, in three places:
 *
 *   - a size sheet: every registry role and the neutral agent at 32/26/20/16 px;
 *   - the orchestrator seat's feed, where each of the other eleven roles
 *     arrives as an internal message, so all twelve show in one message list;
 *   - a builder's own conversation, where the avatar marks the agent's answers.
 *
 * `?avatar=1|2|3` picks the variant. Frame chrome uses `rax-` class names and
 * inline styles only, so it cannot collide with product classes.
 */

import type { ReactNode } from "react";

import { FeedItem } from "@/components/feed/FeedItem";
import type { Item } from "@/components/feed/parse";
import { roleNameById } from "@/components/builderCopy";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import { AVATAR_ROLES, type AvatarRole } from "./roleAvatarCostumes";
import { RoleAvatar, RoleAvatarScope, type AvatarVariant } from "./roleAvatarProto";

const NAMES: Record<AvatarVariant, string> = {
  1: "Делегатус у костюмі ролі",
  2: "Делегатус + значок ролі",
  3: "Плитка-гліф ролі",
};

const at = (minute: number) => `2026-10-11T11:${String(minute).padStart(2, "0")}:00.000Z`;
const prose = (minute: number, text: string): Item => ({ kind: "prose", ts: at(minute), text, engine: "claude" });
const fromRole = (minute: number, role: AvatarRole, text: string): Item => ({ kind: "tmsg", ts: at(minute), dir: "in", peer: role, summary: "", text, internal: true });

const SEAT: Item[] = [
  { kind: "user", ts: at(8), text: "Що з лейном аватарів ролей? Коротко по всіх стадіях." },
  prose(9, "Збираю звіти стадій. Нижче те, що кожна роль повідомила за останню годину."),
  fromRole(10, "architect", "Дизайн-нотатка готова: три напрями, рекомендую костюми із запасним малюнком на 16 px."),
  fromRole(14, "builder", "Аватар ролі в стрічці й у вікні агента готовий, тести компонентів зелені. PR відкрито."),
  fromRole(17, "reviewer", "Раунд 1: два зауваження P2 — контраст капелюха на темній темі й порожній alt."),
  fromRole(19, "visual-critic", "Кадри 390 і 1280 переглянуто: нічого не обрізано, аватар 20 px читається."),
  fromRole(22, "verifier", "Перевірив на зібраній гілці: кожна з 12 ролей має свій аватар, нейтральний агент без костюма."),
  fromRole(24, "cleaner", "Прибрав другий набір гліфів ролей із графа пайплайна: тепер одне джерело."),
  fromRole(27, "merger", "PR злито пакетом разом із двома іншими."),
  fromRole(31, "deployer", "Розгорнуто на цій машині, Viewer перезапущено, перевірка здоров'я відповідає 200."),
  fromRole(36, "prod-auditor", "Прод чистий: помилок рендеру аватарів у журналі за 30 хвилин немає."),
  fromRole(38, "maintainer", "Дошку прибрано: картку перенесено в «Готово», дублікати закрито."),
  fromRole(40, "issue-reporter", "Завів задачу: на телефоні у вікні агента роль названо двічі."),
  prose(41, "Усі стадії звітували. Лейн можна закривати після вашого підтвердження."),
];

const BUILDER: Item[] = [
  fromRole(11, "orchestrator", "Додай аватари ролей у стрічку повідомлень за обраним варіантом."),
  prose(12, "Почав з FeedItem: аватар ролі стає на місце кружка рушія, а назва рушія переходить у рядок заголовка."),
  prose(14, "Готово. RoleAvatar малює SVG, на 16 px — спрощений малюнок. Тести компонентів зелені."),
];

function Pane({ role, title, variant, phone, children }: { role: AvatarRole; title: string; variant: AvatarVariant; phone: boolean; children: ReactNode }) {
  return (
    <section className="rax-pane flex min-w-0 flex-1 flex-col overflow-hidden rounded-surface border border-border bg-canvas" data-rax-pane={role}>
      <header className="flex items-center gap-2.5 border-b border-border bg-card px-3 py-2">
        <RoleAvatar variant={variant} role={role} size={phone ? 26 : 32} />
        <div className="min-w-0">
          <div className="truncate text-title font-semibold text-primary">{title}</div>
          <div className="truncate text-label text-muted">Claude · Opus</div>
        </div>
      </header>
      <div className={phone ? "px-3 pb-3" : "px-4 pb-4"}>
        <RoleAvatarScope.Provider value={{ variant, role }}>
          {children}
        </RoleAvatarScope.Provider>
      </div>
    </section>
  );
}

export function RoleAvatarsEvidence({ variant }: { variant: AvatarVariant }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const roles = [...AVATAR_ROLES, "neutral"] as const;
  const name = (role: AvatarRole) => role === "neutral" ? t("roleFrame.neutral") : roleNameById(t, role);
  const sizes = phone ? [26, 20, 16] : [32, 26, 20, 16];
  return (
    <div data-evidence-case="role-avatars" data-rax-variant={variant} className="min-h-dvh bg-canvas text-primary" style={{ padding: phone ? 12 : 24 }}>
      <div className="rax-band" style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <span style={{ font: "700 28px/1 system-ui", color: "var(--color-accent)" }}>{variant}</span>
        <span style={{ font: "600 17px/1.2 system-ui" }}>{NAMES[variant]}</span>
      </div>
      <div className="rax-sheet rounded-surface border border-border bg-card" style={{ display: "grid", gridTemplateColumns: phone ? "repeat(4, 1fr)" : "repeat(7, 1fr)", gap: phone ? "10px 4px" : "14px 8px", padding: phone ? 10 : 14, marginBottom: phone ? 12 : 16 }}>
        {roles.map((role) => (
          <div key={role} data-rax-role={role} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: phone ? 5 : 6 }}>
              {sizes.map((size) => <RoleAvatar key={size} variant={variant} role={role} size={size} />)}
            </div>
            <span className="text-caption text-secondary" style={{ textAlign: "center", lineHeight: 1.2, overflowWrap: "anywhere" }}>{name(role)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: phone ? "column" : "row", gap: phone ? 12 : 16, alignItems: "flex-start" }}>
        <div style={{ flex: phone ? "none" : 1.45, minWidth: 0, width: phone ? "100%" : undefined }}>
          <Pane role="orchestrator" title={`${name("orchestrator")} · Delegatus`} variant={variant} phone={phone}>
            {SEAT.map((item, index) => <FeedItem key={index} item={item} />)}
          </Pane>
        </div>
        <div style={{ flex: phone ? "none" : 1, minWidth: 0, width: phone ? "100%" : undefined }}>
          <Pane role="builder" title={`${name("builder")} · аватари ролей`} variant={variant} phone={phone}>
            {BUILDER.map((item, index) => <FeedItem key={index} item={item} />)}
          </Pane>
        </div>
      </div>
    </div>
  );
}
