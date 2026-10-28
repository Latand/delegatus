import type { Flow as ArchivedReview } from "@/lib/reviewHistory/types";

/** Shared presentation for recorded reviews and independent reviewer groups.
 * Direct groups carry no template or execution configuration. */
export type ReviewGroup = Omit<ArchivedReview, "template" | "mode" | "baseRef" | "baseMode" | "reviewerMode" | "roundLimit"> &
  Partial<Pick<ArchivedReview, "template" | "mode" | "baseRef" | "baseMode" | "reviewerMode" | "roundLimit">> & {
    kind?: "direct-review";
  };

export type DirectReviewGroup = ReviewGroup & {
  kind: "direct-review";
  template?: never;
  baseRef?: never;
  mode?: never;
  baseMode?: never;
  reviewerMode?: never;
  roundLimit?: never;
};

/** The old client namespace remains decodable during the compatibility window. */
export function isDirectGroup(group: Pick<ReviewGroup, "id" | "kind">): boolean {
  return group.kind === "direct-review" || group.id.startsWith("direct-review::");
}
