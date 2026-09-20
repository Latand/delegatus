export function errorRow(status: "pending" | "rejected"): string { return status === "rejected" ? "" : "pending"; }
