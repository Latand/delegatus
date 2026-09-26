"use client";

import type { MessageSender } from "@/lib/team/contract";

import { MemberAvatar } from "./MemberAvatar";

/**
 * Who sent a human message, above its bubble and aligned with it
 * (sign-in-and-team §6.7, D10). Drawn on every human message in a team,
 * the viewer's own included, so a shared screen reads the same for everyone.
 */
export function SenderLine({ sender, mobile }: { sender: MessageSender; mobile: boolean }) {
  return (
    <div
      data-message-sender={sender.memberId}
      className={`mb-1 flex min-w-0 items-center justify-end gap-1.5 ${mobile ? "max-w-[86%]" : "max-w-[70%]"}`}
    >
      <MemberAvatar name={sender.name} initials={sender.initials} color={sender.color} size={mobile ? 14 : 16} />
      <span className="min-w-0 truncate text-label font-semibold text-secondary">{sender.name}</span>
    </div>
  );
}
