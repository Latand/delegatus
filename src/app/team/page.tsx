import type { Metadata } from "next";

import { TeamPage, type TeamTab } from "@/components/team/TeamPage";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `Team · ${PRODUCT_NAME}` };

const TABS: readonly TeamTab[] = ["members", "activity", "sessions"];

/** Members, who did what, and sessions (sign-in-and-team §6.8–6.9). On a solo
    install it is the one card that sets up a team. `?tab=` opens a tab. */
export default async function Team({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  return <TeamPage initialTab={TABS.includes(tab as TeamTab) ? tab as TeamTab : "members"} />;
}
