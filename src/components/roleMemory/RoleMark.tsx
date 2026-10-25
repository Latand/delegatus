import { RoleAvatar, roleAvatarKey } from "@/components/brand/RoleAvatar";

/** The role's Delegatus costume placed in running text, directly before the words that name the role. The name stays in the text beside it. */
export function RoleMark({ role, size = 14 }: { role: string | null | undefined; size?: number }) {
  if (!role) return null;
  return <RoleAvatar role={roleAvatarKey(role)} size={size} className="mr-1 inline-block align-text-bottom" />;
}
