import type { Metadata } from "next";

import { JoinCard } from "@/components/team/JoinCard";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `Join · ${PRODUCT_NAME}`, referrer: "no-referrer" };

/** An invite, a phone hand-off or a host recovery link (sign-in-and-team §6.4). */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinCard code={code} />;
}
