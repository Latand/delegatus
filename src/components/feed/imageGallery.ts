"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import { imageCardText } from "./cards/ImageCard";
import { inboxImageSrc } from "./InboxImage";
import type { GalleryImage } from "./Lightbox";
import { mdImages } from "./markdown";
import { tr, type FeedEntry, type Item } from "./parse";

/* The markdown texts a row renders through `md`/`mdBlocks`, in reading order. */
function markdownTexts(item: Item): string[] {
  switch (item.kind) {
    case "prose":
    case "user":
    case "note":
    case "mandate":
      return [item.text];
    case "tmsg":
      return [item.summary, item.text];
    default:
      return [];
  }
}

/* The pictures one feed row draws, in the order it draws them, named the way
   the card that draws each one names it. */
function itemImages(item: Item): GalleryImage[] {
  if (item.kind === "image") {
    const { kind: _kind, structuredUserRef: _ref, ...source } = item;
    const { src, label, caption, name } = imageCardText(source);
    return [{ src, alt: label, caption: caption || name, owner: item }];
  }
  if (item.kind === "inbox-image") {
    return [{ src: inboxImageSrc(item.name), alt: tr("inbox.attachedAlt", { name: item.name }), caption: item.path, owner: item }];
  }
  if (item.kind === "tool") {
    if (item.mcp || item.wakeup) return [];
    return (item.outputBlocks ?? []).flatMap((block) => {
      if (block.type !== "image" || !(block.data || block.path)) return [];
      const { src, label, caption, name } = imageCardText(block);
      return [{ src, alt: label, caption: caption || name, owner: item }];
    });
  }
  return markdownTexts(item).flatMap((text) => mdImages(text).map(({ alt, src }) => ({ src, alt, caption: alt || undefined, owner: item })));
}

/** Every picture a conversation's feed draws, in feed order, read from the
    feed's records rather than the page: a picture above the rendered window
    or off screen is in the list all the same. Each carries its place among
    its row's pictures, the place the card that draws it names. */
export function conversationImages(entries: readonly FeedEntry[]): GalleryImage[] {
  return entries.flatMap(({ item }) => itemImages(item).map((image, at) => ({ ...image, at })));
}

/** The gallery a LogFeed hands its viewers: one stable reader over the latest
    records, so a tail tick re-renders nothing and the list is built only when
    a viewer opens. */
export function useConversationGallery(entries: readonly FeedEntry[]): () => GalleryImage[] {
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
  }, [entries]);
  return useCallback(() => conversationImages(latest.current), []);
}
