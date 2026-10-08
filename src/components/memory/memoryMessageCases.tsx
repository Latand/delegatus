import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { FeedItem } from "@/components/feed/FeedItem";
import { MessageProvenanceProvider, provenanceLookupFor } from "@/components/feed/messageProvenance";
import { createFeedSession, type Item } from "@/components/feed/parse";
import { ArtifactPreviewHost } from "@/components/preview/ArtifactPreviewHost";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale } from "@/lib/i18n";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

/*
 * The message-side cases of the memory evidence fixture: one operator turn
 * and the agent's answer, drawn by the feed's own row, for each thing shared
 * memory can have done with that turn.
 *
 *   ?message=three | one | none | empty   what memory did with the turn
 *   &engine=codex                         the turn is a parsed Codex record
 *   &team=1                               the turn carries a sender caption
 *   &live=1                               memory arrives on `fixture:memory-confirmed`
 *
 * Every title, path and message here is invented.
 */

const COPY = {
  en: {
    ask: "Push the branch and open the pull request once the privacy gate passes from the merge base.",
    answer: "Running the privacy gate from the merge base now, then the touched tests by path.",
    titles: [
      "Privacy gate flags a line that starts with a prompt key, so move the key off the start of the line",
      "A browser driver started from a stage needs a short Chrome temp directory, or the socket path is too long",
      "Never use the forge's update-branch button: re-merge in a temporary worktree instead",
    ],
  },
  uk: {
    ask: "Запуш гілку й відкрий пул-реквест, щойно перевірка приватності пройде від бази злиття.",
    answer: "Запускаю перевірку приватності від бази злиття, далі зачеплені тести за шляхами.",
    titles: [
      "Перевірка приватності спрацьовує на рядок, що починається з ключа prompt, тому ключ переносимо з початку рядка",
      "Драйвер браузера, запущений з етапу, потребує короткої тимчасової теки Chrome, інакше шлях сокета задовгий",
      "Ніколи не тиснути кнопку update-branch у форджі: злиття робимо заново в тимчасовому робочому дереві",
    ],
  },
} as const;
const PATHS = [
  "~/.claude/projects/fixture-project/memory/privacy-gate-prompt-key.md",
  "~/.claude/projects/fixture-project/memory/short-chrome-tmpdir.md",
  "~/.claude/projects/fixture-project/memory/no-update-branch.md",
];
const SENDER = { memberId: "member-fixture", name: "Fixture Member", color: "violet", initials: "FM" } as const;

type Outcome = "three" | "one" | "none" | "empty";

function MemoryMessageCase({ outcome, codex, team, live }: { outcome: Outcome; codex: boolean; team: boolean; live: boolean }) {
  const mobile = useIsMobile();
  const copy = COPY[getLocale()];
  const [confirmed, setConfirmed] = useState(!live);
  useEffect(() => {
    const confirm = () => setConfirmed(true);
    window.addEventListener("fixture:memory-confirmed", confirm);
    return () => window.removeEventListener("fixture:memory-confirmed", confirm);
  }, []);
  const { turn, key } = useMemo(() => {
    if (!codex) {
      const item: Item = { kind: "user", ts: "2026-10-01T12:00:00Z", text: copy.ask, structuredUserRef: "fixture-memory-case" };
      return { turn: item, key: "fixture-memory-case" };
    }
    const line = JSON.stringify({ timestamp: "2026-10-01T12:00:00Z", type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: copy.ask }] } });
    const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    return { turn: session.feed([line], 0, false).items.map(entry => entry.item).find(item => item.kind === "user")!, key: `native:${messageTextDigest(line)}` };
  }, [codex, copy]);
  const answer: Item = { kind: "prose", ts: "2026-10-01T12:00:05Z", text: copy.answer, engine: codex ? "codex" : "claude" };
  const count = outcome === "three" ? 3 : outcome === "one" ? 1 : 0;
  const lookup = useMemo(() => {
    const base = provenanceLookupFor(confirmed ? {
      memoryOffers: count ? { [key]: copy.titles.slice(0, count) } : {},
      memoryPaths: count ? { [key]: PATHS.slice(0, count) } : {},
      memoryNone: outcome === "none" ? [key] : [],
    } : {}, [turn]);
    return team ? { ...base, senderFor: () => SENDER } : base;
  }, [confirmed, count, copy, key, outcome, team, turn]);
  return (
    <main data-memory-case={outcome} className="mx-auto w-full max-w-3xl p-4 text-primary">
      <MessageProvenanceProvider value={lookup}>
        <FeedItem item={turn} />
        <FeedItem item={answer} />
      </MessageProvenanceProvider>
      <ArtifactPreviewHost mobile={mobile} />
    </main>
  );
}

/** Draws the case the URL asks for in a pane of its own and hides the page's
    settings fixture; without `?message=` it does nothing. */
export function renderMemoryMessageCase(): void {
  const query = new URLSearchParams(location.search), outcome = query.get("message");
  if (outcome !== "three" && outcome !== "one" && outcome !== "none" && outcome !== "empty") return;
  const root = document.getElementById("root");
  if (root) root.style.display = "none";
  const pane = document.createElement("div");
  document.body.append(pane);
  createRoot(pane).render(<MemoryMessageCase outcome={outcome} codex={query.get("engine") === "codex"} team={query.has("team")} live={query.has("live")} />);
}
