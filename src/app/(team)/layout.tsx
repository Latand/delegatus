import type { ReactNode } from "react";

/* The pages a signed-out person sees (sign-in-and-team §10.1) render outside
   the Viewer shell: no rail, no board, nothing of the install before sign-in.
   The proxy sets X-Frame-Options and frame-ancestors on these paths. */
export default function TeamAuthLayout({ children }: { children: ReactNode }) {
  return children;
}
