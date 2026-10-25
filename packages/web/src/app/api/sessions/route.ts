/**
 * GET /api/sessions — query session statistics for the authenticated user.
 *
 * Query params:
 *   from   — ISO date string (default: 30 days ago)
 *   to     — ISO date string (default: now)
 *   source — filter by source (optional)
 *   kind   — filter by kind: "human" | "automated" (optional)
 *
 * Returns { records, summary }.
 */

import { NextResponse } from "next/server";
import { sumCounts, VALID_SOURCES } from "@pew/core";
import { resolveUser } from "@/lib/auth-helpers";
import { jsonResponse } from "@/lib/json-response";
import { getDbRead } from "@/lib/db";
import { dateParamToIso, isBareDate, isDateParam } from "@/lib/date-params";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set(["human", "automated"]);

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  // 1. Authenticate
  const authResult = await resolveUser(request);
  if (!authResult) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authResult.userId;

  // 2. Parse query params
  const url = new URL(request.url);
  const sourceFilter = url.searchParams.get("source");
  const kindFilter = url.searchParams.get("kind");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  // Validate source filter
  if (sourceFilter && !VALID_SOURCES.has(sourceFilter)) {
    return NextResponse.json(
      { error: "Invalid source parameter" },
      { status: 400 },
    );
  }

  // Validate kind filter
  if (kindFilter && !VALID_KINDS.has(kindFilter)) {
    return NextResponse.json(
      { error: "Invalid kind parameter" },
      { status: 400 },
    );
  }

  // Validate and compute date range
  let fromDate: string;
  let toDate: string;

  if (fromParam) {
    if (!isDateParam(fromParam)) {
      return NextResponse.json(
        { error: "Invalid from date format" },
        { status: 400 },
      );
    }
    fromDate = dateParamToIso(fromParam);
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 30);
    fromDate = d.toISOString();
  }

  if (toParam) {
    if (!isDateParam(toParam)) {
      return NextResponse.json(
        { error: "Invalid to date format" },
        { status: 400 },
      );
    }
    // Bare date "YYYY-MM-DD" → inclusive: bump +1 UTC day for `< toDate`
    const toD = new Date(toParam);
    if (isBareDate(toParam)) {
      toD.setUTCDate(toD.getUTCDate() + 1);
    }
    toDate = toD.toISOString();
  } else {
    toDate = new Date().toISOString();
  }

  // 3. Execute query via RPC
  const db = await getDbRead();

  try {
    // Use limit=1000 to get all sessions within the date range.
    // The response drops `session_key`, `last_message_at` and `project_ref`:
    // no page reads them (the dashboard derives everything from started_at,
    // the message counters, source and model), and the opaque session ids and
    // project hashes were 56% of a month's response — 230 KB -> 60 KB gzipped
    // on a 5,340-session window.
    const records = await db.getSessionRecords(userId, fromDate, toDate, {
      ...(sourceFilter && { source: sourceFilter }),
      ...(kindFilter && { kind: kindFilter }),
      limit: 1000,
    });
    const rows = records.map(({ source, kind, started_at, duration_seconds, user_messages,
      assistant_messages, total_messages, model }) => ({ source, kind, started_at, duration_seconds,
      user_messages, assistant_messages, total_messages, model }));

    // Compute summary
    const summary = records.reduce(
      (acc, r) => ({
        total_sessions: sumCounts(acc.total_sessions, 1),
        total_duration_seconds: sumCounts(acc.total_duration_seconds, r.duration_seconds),
        total_user_messages: sumCounts(acc.total_user_messages, r.user_messages),
        total_assistant_messages:
          sumCounts(acc.total_assistant_messages, r.assistant_messages),
        total_messages: sumCounts(acc.total_messages, r.total_messages),
      }),
      {
        total_sessions: 0,
        total_duration_seconds: 0,
        total_user_messages: 0,
        total_assistant_messages: 0,
        total_messages: 0,
      },
    );

    // A month of sessions is ~2 MB of JSON; Next's built-in compression does
    // not cover route-handler bodies, so this endpoint gzips its own.
    return jsonResponse(request, { records: rows, summary });
  } catch (err) {
    console.error("Failed to query sessions:", err);
    return NextResponse.json(
      { error: "Failed to query session data" },
      { status: 500 },
    );
  }
}
