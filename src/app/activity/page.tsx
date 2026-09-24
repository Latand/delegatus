import type { Metadata } from "next";

import { ActivityDashboard, type ActivityView } from "@/components/activity/ActivityDashboard";
import type { RangeKey } from "@/lib/activity/method";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Activity · ${PRODUCT_NAME}`,
};

const RANGES: readonly RangeKey[] = ["today", "7d", "30d"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Human interaction time and agent activity per day and per project
    (docs/design/activity-dashboard.md). `?range=` and `?view=` open it on a
    given range and view. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const range = first(params.range);
  const view = first(params.view);
  return (
    <ActivityDashboard
      initialRange={RANGES.includes(range as RangeKey) ? range as RangeKey : "7d"}
      initialView={view === "projects" ? "projects" : "days" satisfies ActivityView}
    />
  );
}
