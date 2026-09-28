import { NextResponse } from "next/server";

export const unauthorizedPeer = () => NextResponse.json({ error: "unauthorized" },
  { status: 401, headers: { "cache-control": "no-store" } });
