import { createRoot } from "react-dom/client";
import { renderMemoryMessageCase } from "./memoryMessageCases";
import { MemoryPanel, MemoryReadingProvider } from "@/components/memory/MemoryPage";
import { FeedItem } from "@/components/feed/FeedItem";
import { MessageProvenanceProvider, provenanceLookupFor } from "@/components/feed/messageProvenance";
import { createFeedSession, type Item } from "@/components/feed/parse";

// `?message=` draws one message-side case in a pane of its own.
renderMemoryMessageCase();
const item: Item = { kind: "user", ts: "2026-10-01T12:00:00Z", text: "Update the widget parser.", structuredUserRef: "fixture-memory-turn" };
const short: Item = { kind: "user", ts: "2026-10-01T12:01:00Z", text: "Short offer.", structuredUserRef: "fixture-short-memory-turn" };
const titles = Array.from({ length: 15 }, (_, i) => `Widget parser constraint ${i + 1}`);
// The existing driver can seed confirmed production joins as well as the
// long-title typography case. This endpoint exists only in its fixture server.
const seat = new URLSearchParams(location.search).has("seat-memory")
  ? await (await fetch("/api/fixture/memory-turn")).json() : null;
const feed = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
const items: Item[] = seat ? feed.feed(seat.lines, 0, false).items.map(entry => entry.item) : [item, short];
const lookup = provenanceLookupFor(seat ?? { memoryOffers: { "fixture-memory-turn": titles, "fixture-short-memory-turn": ["Widget parser"] } }, items);
createRoot(document.getElementById("root")!).render(<main className="mx-auto w-full max-w-3xl p-4 text-primary">
  {/* Shared memory's page of the header menu, at the menu's width. */}
  <section data-memory-fixture-page="" className="mb-4 w-[232px] rounded-[10px] border border-border bg-card p-1">
    <MemoryReadingProvider project="fixture-project"><MemoryPanel /></MemoryReadingProvider>
  </section>
  <MessageProvenanceProvider value={lookup}>
    {items.map((entry, i) => <FeedItem key={i} item={entry} />)}
  </MessageProvenanceProvider>
</main>);
