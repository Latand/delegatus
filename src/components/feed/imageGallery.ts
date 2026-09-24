"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import { imageCardText } from "./cards/ImageCard";
import { parseProtocolPayload, protocolProse } from "./cards/ProtocolMessage";
import { reviewTexts } from "./cards/ReviewCard";
import { resolveDeliveredItem } from "./FeedItem";
import { inboxImageSrc } from "./InboxImage";
import type { GalleryImage } from "./Lightbox";
import { mandateMessage } from "./mandateMessage";
import { mdImages } from "./markdown";
import { NO_PROVENANCE, type ProvenanceLookup } from "./messageProvenance";
import { tr, type FeedEntry, type Item } from "./parse";

/* The markdown texts a row renders through `md`/`mdBlocks`, in reading order. */
function markdownTexts(item: Item): string[] {
  switch (item.kind) {
    case "prose":
    case "user":
    case "note":
      return [item.text];
    case "mandate": {
      const { mandate, handoff } = mandateMessage(item.text);
      return [mandate, handoff ?? ""];
    }
    case "tmsg": {
      const protocol = parseProtocolPayload(item.text);
      return protocol ? [protocolProse(protocol) ?? ""] : [item.summary, item.text];
    }
    case "review":
      return reviewTexts(item);
    default:
      return [];
  }
}

/* The pictures one feed row draws, in the order it draws them, named the way
   the card that draws each one names it. `item` is the row as `FeedItem`
   draws it; `owner` is the feed's own record for it. */
function itemImages(item: Item, owner: Item): GalleryImage[] {
  if (item.kind === "image") {
    const { kind: _kind, structuredUserRef: _ref, ...source } = item;
    const { src, label, caption, name } = imageCardText(source);
    return [{ src, alt: label, caption: caption || name, owner }];
  }
  if (item.kind === "inbox-image") {
    return [{ src: inboxImageSrc(item.name), alt: tr("inbox.attachedAlt", { name: item.name }), caption: item.path, owner }];
  }
  if (item.kind === "tool") {
    if (item.mcp || item.wakeup) return [];
    return (item.outputBlocks ?? []).flatMap((block) => {
      if (block.type !== "image" || !(block.data || block.path)) return [];
      const { src, label, caption, name } = imageCardText(block);
      return [{ src, alt: label, caption: caption || name, owner }];
    });
  }
  return markdownTexts(item).flatMap((text) => mdImages(text).map(({ alt, src }) => ({ src, alt, caption: alt || undefined, owner })));
}

/** Every picture a conversation's feed draws, in feed order, read from the
    feed's records rather than the page: a picture above the rendered window
    or off screen is in the list all the same. Each carries its place among
    its row's pictures, the place the card that draws it names. A delivered
    row is read as the provenance lookup resolves it, the way the feed draws
    it: the operator's bubble, a mandate or a relay card. */
export function conversationImages(entries: readonly FeedEntry[], provenance: ProvenanceLookup = NO_PROVENANCE): GalleryImage[] {
  return entries.flatMap(({ item }) => itemImages(resolveDeliveredItem(item, provenance), item).map((image, at) => ({ ...image, at })));
}

/** The gallery a LogFeed hands its viewers: one stable reader over the latest
    records and provenance, so a tail tick or a provenance answer re-renders
    nothing and the list is built only when a viewer opens. */
export function useConversationGallery(entries: readonly FeedEntry[], provenance: ProvenanceLookup): () => GalleryImage[] {
  const latest = useRef({ entries, provenance });
  useLayoutEffect(() => {
    latest.current = { entries, provenance };
  }, [entries, provenance]);
  return useCallback(() => conversationImages(latest.current.entries, latest.current.provenance), []);
}
