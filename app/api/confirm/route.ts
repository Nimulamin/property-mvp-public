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
    const body = await req.json();

    const sessionId = must<string>(body.session_id, "session_id required");
    const facts = must<any>(body.facts, "facts required");

    // Validate required confirmed fields
    const payload = {
      property_session_id: sessionId,
      price: must<number>(facts.price, "price required"),
      bedrooms: must<number>(facts.bedrooms, "bedrooms required"),
      property_type: must<string>(facts.property_type, "property_type required"),
      tenure: must<string>(facts.tenure, "tenure required"),
      postcode: must<string>(facts.postcode, "postcode required"),
      bathrooms: facts.bathrooms ?? null,
      lease_years_remaining: facts.lease_years_remaining ?? null,
      address: facts.address ?? null,
      description: facts.description ?? null,
      estate_agent: facts.estate_agent ?? null,
      // confirmed_at default now()
    };

    const db = supabaseServiceClient();

    // Ensure session belongs to user
    const { data: s, error: sErr } = await db
      .from("property_sessions")
      .select("id,user_id")
      .eq("id", sessionId)
      .single();
    if (sErr) throw sErr;
    if (s.user_id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Upsert confirmed facts (PK: property_session_id)
    const { error: upErr } = await db
      .from("listing_facts_confirmed")
      .upsert(payload, { onConflict: "property_session_id" });
    if (upErr) throw upErr;

    // Mark session confirmed
    const { error: stErr } = await db
      .from("property_sessions")
      .update({ status: "CONFIRMED" })
      .eq("id", sessionId);
    if (stErr) throw stErr;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
