// app/api/stats/confirm/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function must<T>(v: T | null | undefined, msg: string): T {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) throw new Error(msg);
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req);
    if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

    const auth = supabaseAuthClient();
    const { data: userRes, error: userErr } = await auth.auth.getUser(token);
    if (userErr || !userRes.user) return NextResponse.json({ error: "Invalid JWT" }, { status: 401 });
    const userId = userRes.user.id;

    const body = await req.json().catch(() => ({}));
    const sessionId = must<string>(body.property_session_id, "property_session_id required");
    const stats = must<any>(body.stats, "stats required");

    const db = supabaseServiceClient();

    const { data: s, error: sErr } = await db
      .from("property_sessions")
      .select("id,user_id,status")
      .eq("id", sessionId)
      .single();
    if (sErr) throw sErr;
    if ((s as any).user_id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if ((s as any).status !== "STATS_NEEDS_CONFIRMATION") {
      return NextResponse.json({ error: "Invalid state", status: (s as any).status }, { status: 409 });
    }

    // Require the core confirmed fields
    const payload: any = {
      property_session_id: sessionId,
      commute_total_minutes: must<number>(stats.commute_total_minutes, "commute_total_minutes required"),
      commute_walk_minutes: must<number>(stats.commute_walk_minutes, "commute_walk_minutes required"),
      commute_mode: must<string>(stats.commute_mode, "commute_mode required"),
      nearest_station_distance_m: must<number>(stats.nearest_station_distance_m, "nearest_station_distance_m required"),
      nearest_station_name: must<string>(stats.nearest_station_name, "nearest_station_name required"),
      supermarket_distance_m: must<number>(stats.supermarket_distance_m, "supermarket_distance_m required"),
      supermarket_name: must<string>(stats.supermarket_name, "supermarket_name required"),
      green_space_distance_m: must<number>(stats.green_space_distance_m, "green_space_distance_m required"),
      green_space_name: must<string>(stats.green_space_name, "green_space_name required"),
      safety_score: must<number>(stats.safety_score, "safety_score required"),

      required_confidence: stats.required_confidence ?? null,
      required_source: stats.required_source ?? null,
      notes: stats.notes ?? "Confirmed by user",
      confirmed_by_user: true,
      confirmed_at: new Date().toISOString(),
    };

    const { error: upErr } = await db
      .from("listing_stats_confirmed")
      .upsert(payload, { onConflict: "property_session_id" });
    if (upErr) throw upErr;

    const { error: stErr } = await db
      .from("property_sessions")
      .update({ status: "STATS_READY" })
      .eq("id", sessionId);
    if (stErr) throw stErr;

    return NextResponse.json({ ok: true, status: "STATS_READY" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
