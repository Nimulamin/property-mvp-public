import { NextRequest, NextResponse } from "next/server";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const token = getBearerToken(req);
    if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

    const auth = supabaseAuthClient();
    const { data: userRes, error: userErr } = await auth.auth.getUser(token);
    if (userErr || !userRes.user) return NextResponse.json({ error: "Invalid JWT" }, { status: 401 });

    const userId = userRes.user.id;
    const db = supabaseServiceClient();

    // Join raw facts (FK assumed: listing_facts_raw.property_session_id -> property_sessions.id)
    const { data, error } = await db
      .from("property_sessions")
      .select(`
        id,
        created_at,
        last_extracted_at,
        rightmove_url,
        rightmove_listing_id,
        status,
        listing_stats_raw (
          stats_version,
          computed_at,
          commute_total_minutes,
          commute_walk_minutes,
          commute_mode,
          commute_confidence,
          commute_notes,
          nearest_station_distance_m,
          nearest_station_name,
          supermarket_distance_m,
          supermarket_name,
          green_space_distance_m,
          green_space_name,
          safety_score,
          cleanliness_score,
          transport_convenience_score,
          required_confidence,
          required_source,
          optional_confidence,
          optional_source
        ),
        listing_stats_confirmed (
          commute_total_minutes,
          commute_walk_minutes,
          commute_mode,
          nearest_station_distance_m,
          nearest_station_name,
          supermarket_distance_m,
          supermarket_name,
          green_space_distance_m,
          green_space_name,
          safety_score,
          required_confidence,
          required_source,
          notes,
          confirmed_by_user,
          confirmed_at
        ),
        listing_evaluation_raw (
          rank_score,
          overall_score,
          executive_summary,
          estate_agent_snippet,
          per_preference,
          warnings,
          assumptions,
          evaluated_at
        ),
        listing_facts_raw (
          price,
          bedrooms,
          bathrooms,
          property_type,
          tenure,
          lease_years_remaining,
          postcode,
          address,
          description,
          estate_agent
        ),
        listing_facts_confirmed (
          price,
          bedrooms,
          bathrooms,
          property_type,
          tenure,
          lease_years_remaining,
          postcode,
          address,
          description,
          estate_agent,
          confirmed_at
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ ok: true, sessions: data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
