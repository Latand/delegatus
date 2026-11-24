"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { boardBootScopeFor, bootSnapshotStore, useBoardBootAuthorityValue } from "@/lib/client/boardBootAuthority";
import { FIRST_SCREEN_VERSION, type FirstScreenProjection, type ProjectFirstScreen } from "@/lib/client/projectFirstScreen";

type ScreenParts = Pick<ProjectFirstScreen, "desktop" | "phone" | "seat">;

export function useProjectFirstScreen(project: string, mobile: boolean, revision: number, current: boolean, seatName: string | null | undefined) {
  /* Nothing saved is read until the server names this identity; the answer
     arrives after the board's own reads have started. */
  useBoardBootAuthorityValue();
  const scope = boardBootScopeFor(project);
  const [stored, setStored] = useState<ProjectFirstScreen | null>(null);
  const lastWrite = useRef("");
  useEffect(() => {
    if (!scope || !bootSnapshotStore) return;
    let active = true;
    void bootSnapshotStore.readFirstScreen(scope, project).then(record => {
      if (active && boardBootScopeFor(project) === scope) setStored(record);
    });
    return () => { active = false; };
  }, [project, scope]);

  const write = useCallback((parts: (savedAt: number) => ScreenParts) => {
    if (!scope || !bootSnapshotStore) return;
    const savedAt = Date.now();
    void bootSnapshotStore.writeFirstScreen({ version: FIRST_SCREEN_VERSION, savedAt, scope, project, ...parts(savedAt) },
      () => boardBootScopeFor(project) === scope).catch(() => {});
  }, [project, scope]);

  useEffect(() => {
    if (seatName !== undefined) write(savedAt => ({ seat: { name: seatName, savedAt } }));
  }, [seatName, write]);

  const saveLayout = useCallback((layout: FirstScreenProjection) => {
    if (!current || !scope) return;
    const signature = JSON.stringify([scope, project, mobile, revision, layout]);
    if (signature === lastWrite.current) return;
    lastWrite.current = signature;
    write(savedAt => ({ [mobile ? "phone" : "desktop"]: { ...layout, revision, savedAt } }));
  }, [current, mobile, project, revision, scope, write]);

  const preview = stored && stored.project === project && stored.scope === scope ? stored : null;
  return {
    layout: mobile ? preview?.phone ?? preview?.desktop : preview?.desktop ?? preview?.phone,
    seatName: seatName === undefined ? preview?.seat?.name : seatName,
    saveLayout: current && scope ? saveLayout : undefined,
  };
}
