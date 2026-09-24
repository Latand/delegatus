/**
 * In-app navigation a component asks for by the app's own URL fragment
 * (#2105): a conversation's `#c=`/`#f=` link, a project's `#p=`. The Viewer
 * serves it while the phone layout is up, so the phone's navigation store
 * writes the one history entry the navigation owes — over the place the
 * operator is, taking the place of a sheet the same tap closed. Anywhere else
 * the fragment is assigned, as it always was, and the Viewer's `hashchange`
 * resolver takes it from there.
 *
 * A fragment assigned beside the store is a history write the store did not
 * make: a sheet closed in the same tap stayed in the history under it, and
 * Back reopened the sheet.
 */

/** The message a tapped notification's service worker sends the tab with the
    link it opens (`public/question-push-sw.js` spells the same string). */
export const NOTIFICATION_OPEN_MESSAGE = "delegatus:open-url";

/** Returns true when it took the navigation. */
export type FragmentNavigator = (hash: string) => boolean;

let served: FragmentNavigator | null = null;

/** Serve fragment navigations until the returned release runs. */
export function setFragmentNavigator(next: FragmentNavigator): () => void {
  served = next;
  return () => {
    if (served === next) served = null;
  };
}

/** Navigate to one of the app's fragments (`#c=…`, `#f=…`, `#p=…`). */
export function navigateToFragment(hash: string): void {
  if (served?.(hash)) return;
  if (typeof window !== "undefined") window.location.hash = hash;
}
