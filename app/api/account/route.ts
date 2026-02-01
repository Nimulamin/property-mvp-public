import { NextRequest, NextResponse } from "next/server";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

async function ensureCountersRow(userId: string) {
  const db = supabaseServiceClient();
  // Ensure exists (matches your current patterns)
  const { error } = await db.from("usage_counters").upsert({ user_id: userId }, { onConflict: "user_id" });
  if (error) throw error;
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

    await ensureCountersRow(userId);

    const { data: counters, error: cErr } = await db
      .from("usage_counters")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (cErr) throw cErr;

    const { data: ledger, error: lErr } = await db
      .from("usage_ledger")
      .select("id, action_type, delta, reason, related_purchase_id, related_session_id, note, created_at, action, amount, direction")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (lErr) throw lErr;

    const { data: purchases, error: pErr } = await db
      .from("usage_purchases")
      .select("id, extract_credits, stats_credits, evaluate_credits, video_credits, provider, provider_ref, amount_pence, currency, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (pErr) throw pErr;

    // Stripe-ready placeholder fields:
    const billing = {
      plan: "free",                // later: from Stripe subscription or your own table
      status: "active",            // later: active/past_due/canceled etc
      next_renewal: null as string | null,
      portal_url: null as string | null, // later: Stripe customer portal link
    };

    return NextResponse.json({
      ok: true,
      counters,
      ledger: ledger ?? [],
      purchases: purchases ?? [],
      billing,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
