import { z } from "zod";
export const recordedCheckInput = z.object({
  action: z.enum(["handoff", "read", "acknowledge"]),
  ticket: z.string().min(1).max(4096).optional(),
  receiptId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cursor: z.coerce.number().int().min(0).catch(0).optional(),
  resultRevision: z.number().int().positive().optional(), resultDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), disposition: z.literal("adopt-retained").optional(),
});
