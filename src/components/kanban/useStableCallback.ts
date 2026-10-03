import { useCallback, useRef } from "react";

/**
 * One function for the life of the component that always runs the latest
 * `callback`. A handler handed to a memoized card must keep its identity, but
 * the closures behind a board's handlers close over the catalog, so each
 * catalog update gave every card a handler it had not seen and re-rendered
 * all of them (#2218). Call it only from an event, never while rendering.
 */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  // eslint-disable-next-line react-hooks/refs -- The pattern: the ref is read only from events, after this render committed.
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
