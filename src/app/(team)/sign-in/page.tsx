import type { Metadata } from "next";

import { SignInCard } from "@/components/team/SignInCard";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `Sign in · ${PRODUCT_NAME}` };

/** Sign in to a team install (sign-in-and-team §6.6). `?next=` is where to
    return; the card clamps it to a same-origin path. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const next = Array.isArray(params.next) ? params.next[0] : params.next;
  return <SignInCard next={next ?? "/"} />;
}
