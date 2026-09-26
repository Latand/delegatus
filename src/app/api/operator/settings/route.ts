import { NextRequest, NextResponse } from "next/server";

import {
  isOperatorLocale,
  isTimeZone,
  readOperatorSettings,
  updateOperatorSettings,
  type OperatorSettings,
} from "@/lib/operator/settings";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** The operator's interface language and time zone
    (docs/design/orchestrator-reports.md §4.2). */
export interface OperatorSettingsResponse extends OperatorSettings {
  ok: true;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, ...readOperatorSettings() } satisfies OperatorSettingsResponse, { headers });
}

/** The client's write: the toggle sends `{ locale, source: "chosen" }`, a
    client with nothing stored sends what it shows as `detected`, and every
    client reports its time zone. A detected language never replaces a chosen
    one; the store enforces that. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const locale = record?.locale;
  const source = record?.source;
  const timeZone = record?.timeZone;
  const shapeOk = !!record
    && (locale === undefined || isOperatorLocale(locale))
    && (source === undefined || source === "chosen" || source === "detected")
    && (timeZone === undefined || isTimeZone(timeZone))
    && (locale !== undefined || timeZone !== undefined);
  if (!shapeOk) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "locale (en or uk) with an optional source (chosen or detected), or a timeZone, is required" }, { status: 400, headers });
  }
  const updated = updateOperatorSettings({
    ...(isOperatorLocale(locale) ? { locale } : {}),
    ...(source === "chosen" || source === "detected" ? { source } : {}),
    ...(typeof timeZone === "string" ? { timeZone } : {}),
  });
  if (!updated) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
  }
  return NextResponse.json({ ok: true, ...updated } satisfies OperatorSettingsResponse, { headers });
}
