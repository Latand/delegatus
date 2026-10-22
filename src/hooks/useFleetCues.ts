"use client";

import { useEffect } from "react";

import { playCue, watchEventTab } from "@/lib/audio/app";
import { awaitingReplies, createFleetCueWatcher } from "@/lib/audio/fleetCues";
import { hasLiveFeed } from "@/lib/chime";

import { getRuntimeBus, isRuntimeUiEnabled } from "./runtimeBus";

/**
 * The runtime stream's sounds (docs/design/sound-redesign.md §4.4): S2, the
 * murmur of agents working off screen, and S8, the answer to this tab's own
 * message or launch. Mounted once in the Viewer; also owns this tab's claim on
 * the device's event sounds (§8).
 */
export function useFleetCues(): void {
  useEffect(() => watchEventTab(), []);

  useEffect(() => {
    /* With the runtime UI rolled back there is no stream to hear. */
    if (!isRuntimeUiEnabled()) return;
    const bus = getRuntimeBus();
    const watcher = createFleetCueWatcher({ hasLiveFeed, awaiting: awaitingReplies, play: (request) => void playCue(request) });
    /* The first installed snapshot is the baseline: the empty store before it
       would make every running tool in that snapshot read as new. */
    const observe = () => {
      const { store } = bus.getState();
      if (store.cursor > 0 || Object.keys(store.sessions).length > 0) watcher.observe(store.sessions);
    };
    observe();
    return bus.subscribe(observe);
  }, []);
}
