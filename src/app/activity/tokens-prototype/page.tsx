import type { Metadata } from "next";

import { TokensPrototype, type PrototypeParams, type Variant } from "@/components/activity/tokensPrototype/TokensPrototype";
import type { RangeChoice } from "@/components/activity/tokensPrototype/parts";
import type { TokenDimension } from "@/components/activity/tokensPrototype/fixture";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Activity · tokens prototype · ${PRODUCT_NAME}`,
};

const RANGES: readonly RangeChoice[] = ["today", "7d", "30d", "90d", "custom"];
const DIMENSIONS: readonly TokenDimension[] = ["kind", "model", "role", "project", "member", "account"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The prototype route of docs/design/activity-token-usage.md §9: invented
    fixture data only, no store or endpoint. `?variant=1..4`, `range`
    (`today|7d|30d|90d|custom`), `from`/`to` (YYYY-MM-DD), `project`, `by`
    and `open=1` (the custom range popover open) set the captured state.
    Removed once the operator has chosen a variant. */
export default async function TokensPrototypePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const variant = Number(first(params.variant));
  const range = first(params.range) as RangeChoice | undefined;
  const from = first(params.from);
  const to = first(params.to);
  const by = first(params.by) as TokenDimension | undefined;
  const initial: PrototypeParams = {
    variant: ([1, 2, 3, 4].includes(variant) ? variant : 1) as Variant,
    range: range && RANGES.includes(range) ? range : "7d",
    from: from && DATE.test(from) ? from : null,
    to: to && DATE.test(to) ? to : null,
    project: first(params.project)?.trim() || null,
    by: by && DIMENSIONS.includes(by) ? by : "model",
    open: first(params.open) === "1",
  };
  return <TokensPrototype initial={initial} />;
}
