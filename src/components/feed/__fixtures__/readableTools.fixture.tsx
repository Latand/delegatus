import { createRoot } from "react-dom/client";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { FeedItem } from "../FeedItem";
import { buildFeed } from "../parse";
import { currentCodexToolLines } from "./readableTools";

setLocale(localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");
const file = { path: "/workspace/demo.jsonl", engine: "codex", fmt: "codex", cwd: "/workspace/app" } as FileEntry;
const items = buildFeed(file, currentCodexToolLines(), false, "").items;
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full max-w-4xl p-3 text-primary" data-readable-tools>
    {items.map((item, index) => <FeedItem key={index} item={item} />)}
  </main>,
);
