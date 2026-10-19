import type { Metadata } from "next";

import { ActivityDashboard } from "@/components/activity/ActivityDashboard";
import { byFromSearch, rangeFromSearch, viewFromSearch } from "@/components/activity/pageParams";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Activity · ${PRODUCT_NAME}`,
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Human interaction time, agent activity and token usage per day and per
    project (docs/design/activity-dashboard.md,
    docs/design/activity-token-usage.md). `?range=` (`today|7d|30d|90d`) or
    `?from=`/`?to=` open it on a range, `?view=` (`days|projects|tokens`) on
    a view, `?stack=`/`?list=` on a token breakdown, `?project=` scopes it to
    one project, and `?member=` (the owner's) counts one member or `all`. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const search = new URLSearchParams();
  for (const key of ["range", "from", "to", "view", "stack", "list"]) {
    const value = first(params[key]);
    if (value !== undefined) search.set(key, value);
  }
  const project = first(params.project)?.trim();
  const member = first(params.member)?.trim();
  return (
    <ActivityDashboard
      initialRange={rangeFromSearch(search)}
      initialView={viewFromSearch(search)}
      initialBy={byFromSearch(search)}
      initialProject={project ? project : null}
      initialMember={member ? member : null}
    />
  );
}
