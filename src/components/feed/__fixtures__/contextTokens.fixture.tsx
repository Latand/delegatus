import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { FeedItem } from "../FeedItem";
import { buildFeed } from "../parse";
import { contextTokensConversationLines } from "./contextTokens";

/* The rendered subject of the tool-call token evidence
   (docs/design/tool-call-tokens.md): one conversation parsed by the real
   parser and drawn by the real feed cards. The driver
   (`issue1671Evidence.browser.test.tsx`, "tool call context tokens") measures
   the rows and captures the frames. */

setLocale(localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");

const file = { path: "/workspace/demo.jsonl", engine: "claude", fmt: "claude", cwd: "/workspace/demo", activity: "idle" } as FileEntry;
const items = buildFeed(file, contextTokensConversationLines(), false, "").items;

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full max-w-4xl overflow-y-auto p-3 text-primary" data-context-tokens-feed>
    {items.map((item, index) => <FeedItem key={index} item={item} />)}
  </main>,
);
