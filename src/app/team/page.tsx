import type { Metadata } from "next";

import { TeamPage, type TeamTab } from "@/components/team/TeamPage";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `Team · ${PRODUCT_NAME}` };

const TABS: readonly TeamTab[] = ["members", "workspaces", "activity", "sessions"];

/** Members, workspaces, who did what, and sessions (sign-in-and-team
    §6.8–6.9, workspaces.md §13.5). On a solo install it is the one card that
    sets up a team. `?tab=` opens a tab; `?create=1` with the Workspaces tab
    opens New workspace. */
export default async function Team({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const initialTab = TABS.includes(tab as TeamTab) ? tab as TeamTab : "members";
  const create = Array.isArray(params.create) ? params.create[0] : params.create;
  return <TeamPage initialTab={initialTab} initialCreate={initialTab === "workspaces" && create === "1"} />;
}
