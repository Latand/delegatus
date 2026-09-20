import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { FeedItem } from "../FeedItem";
import { buildFeed } from "../parse";
import { claudePhoneRowLines, codexPhoneRowLines } from "./codexPhoneRows";

/* The rendered subject of the phone-row evidence (#1938): the same eight tool
   cases under both engines, mounted in one page so a capture at 390 px shows
   Codex rows directly beside Claude rows. The driver
   (`kanbanBoard.browser.test.tsx`, "codex tool rows on a phone") opens every
   disclosure and measures the row boxes here. */

setLocale(localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");

const sections = [
  { engine: "codex" as const, lines: codexPhoneRowLines() },
  { engine: "claude" as const, lines: claudePhoneRowLines() },
];

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full max-w-4xl p-3 text-primary" data-codex-phone-rows>
    {sections.map(({ engine, lines }) => {
      const file = { path: `/workspace/demo-${engine}.jsonl`, engine, fmt: engine, cwd: "/workspace/demo" } as FileEntry;
      return (
        <section key={engine} data-rows-engine={engine}>
          <h2 className="mb-1 mt-4 text-caption font-semibold uppercase tracking-wide text-muted">{engine}</h2>
          {buildFeed(file, lines, false, "").items.map((item, index) => <FeedItem key={index} item={item} />)}
        </section>
      );
    })}
  </main>,
);
