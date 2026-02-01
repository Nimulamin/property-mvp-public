import { NextRequest, NextResponse } from "next/server";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

// Defaults that satisfy NOT NULL columns in preferences
function defaultPreferences(userId: string) {
  return {
    user_id: userId,
    budget_max: 450000,
    budget_flex: 0,
    notes_budget: null,

    min_bedrooms: 2,
    min_bathrooms: null,

    // must be non-null arrays
    property_type_rank: [
        "detached",
        "semi_detached",
        "terraced",
        "flat",
        "maisonette",
        "bungalow",
        "studio"
    ],      
    property_type_reject_below_index: 0,
    notes_property_type: null,

    tenure_rank: ["freehold", "share_of_freehold", "leasehold", "commonhold", "other"],
    tenure_reject_below_index: 0,
    min_lease_years: null,
    notes_tenure: null,

    work_postcode: "",
    transport_mode: "public_transport", // constrained by check
    max_commute_minutes_total: null,
    max_walk_minutes: null,
    car_owner: false,
    bike_owner: false,
    transport_convenience_weight: 5,
    notes_commute: null,

    religion_required: false,
    school_priority: false,
    gym_priority: false,
    has_children: false,
    quiet_area_priority: false,
    green_space_priority: false,
    safety_weight: 5,
    cleanliness_weight: 5,
    notes_lifestyle: null,

    max_service_charge: null,
    max_ground_rent: null,
    notes_running_costs: null,

    parking_required: "not_required", // constrained by check
    parking_type_rank: ["driveway", "garage", "allocated", "permit", "street", "none"],
    parking_reject_below_index: 0,
    storage_required: false,
    notes_parking: null,

    condition_tolerance: "light_cosmetic", // constrained by check
    notes_condition: null,

    affordability_weight: 5,
    notes_value: null,
  };
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

    const { data, error } = await db
      .from("preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    // If your provisioning trigger didn’t create it, create it now.
    if (!data) {
      const seed = defaultPreferences(userId);
      const { data: inserted, error: insErr } = await db
        .from("preferences")
        .insert(seed)
        .select("*")
        .single();
      if (insErr) throw insErr;
      return NextResponse.json({ ok: true, preferences: inserted });
    }

    return NextResponse.json({ ok: true, preferences: data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req);
    if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

    const auth = supabaseAuthClient();
    const { data: userRes, error: userErr } = await auth.auth.getUser(token);
    if (userErr || !userRes.user) return NextResponse.json({ error: "Invalid JWT" }, { status: 401 });

    const userId = userRes.user.id;
    const body = await req.json();

    // Force user_id from token, never trust client for that
    const payload = { ...body, user_id: userId };

    const db = supabaseServiceClient();
    const { data, error } = await db
      .from("preferences")
      .upsert(payload, { onConflict: "user_id" })
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, preferences: data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
