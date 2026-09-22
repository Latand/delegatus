import { getStepLog } from "@/lib/selfUpdate/routes";

/* The full log of one checkout-install update step (#2007). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StepLogContext = { params: Promise<{ step: string }> };

export async function GET(_request: Request, context: StepLogContext) {
  const { step } = await context.params;
  return getStepLog(step);
}
