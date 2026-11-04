export type AppPermissions = Record<string, "read" | "write">;
export interface AppConnectContext {
  appId: number;
  slug: string;
  accountId: number;
  accountType: "orgs" | "users";
  settingsUrl: string;
  prerequisite: "none" | "app_private";
}
export interface AppConnectDiscovery {
  context: AppConnectContext;
  covered: boolean;
  installationId: number | null;
  installationUrl: string | null;
  missingPermissions: string[];
  missingAppPermissions: string[];
  pending: boolean;
  proved?: boolean;
}
export type AppConnectState = "awaiting_click" | "awaiting_answer" | "awaiting_owner" | "missing_repository" |
  "missing_permissions" | "verification_failed" | "connected" | "expired" | "cancelled";
export interface AppConnectRow {
  kind: "request";
  key: string;
  requestId: string;
  repository: string;
  project: string;
  conversationId: string;
  permissions: AppPermissions;
  ownRepository: boolean;
  absentAtRequest: boolean;
  /** Permission keys that blocked proof when the operator's own request began. */
  missingPermissionsAtRequest?: string[];
  createdAt: number;
  expiresAt: number;
  nextAt: number;
  checks: number;
  state: AppConnectState;
  discovery: AppConnectDiscovery;
  repositoryId: number | null;
  reviewId?: string;
  form?: import("@/lib/prototypeReview/types").PublishPrototypeInput;
  replacedForm?: boolean;
  lastError?: string;
  changed?: boolean;
  notifiedState?: AppConnectState;
  notificationDeferred?: boolean;
}
export interface AppConnectReceipt {
  kind: "receipt";
  key: string;
  digest: string;
  response: AppConnectResponse;
}
export interface AppConnectResponse {
  requestId: string;
  repository: string;
  state: AppConnectState;
  reviewId?: string;
  expiresAt: string;
  prerequisite: AppConnectContext["prerequisite"];
  installationId: number | null;
  installationUrl: string | null;
  missingPermissions: string[];
  missingAppPermissions: string[];
  preselected: boolean;
  changed: boolean;
  appliesTo: "new launches";
  lastError?: string;
}
