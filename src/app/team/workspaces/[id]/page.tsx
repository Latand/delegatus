import type { Metadata } from "next";

import { WorkspacePage } from "@/components/team/WorkspacePage";
import { PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = { title: `Workspace · ${PRODUCT_NAME}` };

/** One workspace: its name and its projects (docs/design/workspaces.md §13.5 D6). */
export default async function Workspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkspacePage id={id} />;
}
