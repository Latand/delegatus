import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scope = { relay: id, target: id };
const codePattern = /DLG-[A-F0-9]{12}/i;
export const requesterCodeWord = /^DLG-[A-F0-9]{12}$/;
export const redactRequesterCodeText = (text: string) => text.replace(/DLG-[A-F0-9]{12}/gi, "[enrolment code]");
export const requesterLabel = z.string().trim().min(1).max(128).regex(/^[^\x00-\x1f\x7f]*$/)
  .refine(label => !codePattern.test(label));

export const requesterOperation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start_enrolment"), label: requesterLabel, ...scope }),
  z.strictObject({ action: z.enum(["confirm", "decline", "remove"]), entryId: id, ...scope }),
]);
export const requesterMcpInput = z.union([
  z.strictObject({ action: z.literal("list"), ...scope }),
  requesterOperation,
]);
export const requesterProposalId = z.string().regex(/^[a-f0-9]{48}$/);

export type RequesterOperation = z.infer<typeof requesterOperation>;
export type RequesterMcpInput = z.infer<typeof requesterMcpInput>;

export type RequesterView = {
  relay: string;
  target: string;
  targetName: string;
  project: string | null;
  revision: number;
  canStart: boolean;
  entries: { id: string; label: string; kind: "requester" | "paired-owner"; tier: "requester" | "owner"; project: string | null; addedAt: string; active: boolean }[];
  pending: {
    id: string; label: string; expiresAt: string; status: "waiting" | "candidate" | "contested" | "expired" | "stale";
    candidate: { name: string; chatTitle: string | null; at: string } | null;
  } | null;
  /** An enrolment started in another owner session; nothing about it beyond its expiry. */
  otherSession: { expiresAt: string } | null;
  history: { time: string; action: string; label: string; approvedBy: string; surface: "board" | "mcp" }[];
};
