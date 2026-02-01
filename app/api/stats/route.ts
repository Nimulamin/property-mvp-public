// app/api/stats/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

type LifecycleStage =
  | "CREATED"
  | "FETCHED_HTML"
  | "EXTRACTED_BASE"
  | "AI_PARSED"
  | "NEEDS_CONFIRMATION"
  | "CONFIRMED"
  | "STATS_RUNNING"
  | "STATS_NEEDS_CONFIRMATION"
  | "STATS_READY"
  | "STATS_FAILED"
  | "EVAL_RUNNING"
  | "AI_READY"
  | "EVAL_FAILED"
  | "VIDEO_REQUESTED"
  | "VIDEO_READY";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonLoose(text: string): any {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  }
}

function checkMinimumPreferences(p: any): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  // All NOT NULL columns (per your schema) + additional non-empty checks.
  const reqFields = [
    "budget_max",
    "budget_flex",
    "min_bedrooms",
    "property_type_rank",
    "property_type_reject_below_index",
    "tenure_rank",
    "tenure_reject_below_index",
    "work_postcode",
    "transport_mode",
    "car_owner",
    "bike_owner",
    "transport_convenience_weight",
    "religion_required",
    "school_priority",
    "gym_priority",
    "has_children",
    "quiet_area_priority",
    "green_space_priority",
    "safety_weight",
    "cleanliness_weight",
    "storage_required",
    "affordability_weight",
  ];

  for (const k of reqFields) {
    if (p?.[k] === null || p?.[k] === undefined) missing.push(k);
  }

  if (!p?.work_postcode || typeof p.work_postcode !== "string" || p.work_postcode.trim().length === 0) {
    if (!missing.includes("work_postcode")) missing.push("work_postcode");
  }
  if (!Array.isArray(p?.property_type_rank) || p.property_type_rank.length === 0) {
    if (!missing.includes("property_type_rank")) missing.push("property_type_rank");
  }
  if (!Array.isArray(p?.tenure_rank) || p.tenure_rank.length === 0) {
    if (!missing.includes("tenure_rank")) missing.push("tenure_rank");
  }

  return { ok: missing.length === 0, missing };
}

async function ensureUsageRow(userId: string) {
  const db = supabaseServiceClient();
  const { error } = await db.from("usage_counters").upsert({ user_id: userId }, { onConflict: "user_id" });
  if (error) throw error;
}

async function checkAndConsumeQuota(userId: string, action: "stats") {
  const db = supabaseServiceClient();
  await ensureUsageRow(userId);

  const { data, error } = await db
    .from("usage_counters")
    .select("stats_used, stats_limit")
    .eq("user_id", userId)
    .single();
  if (error) throw error;

  const used = Number((data as any).stats_used ?? 0);
  const limit = Number((data as any).stats_limit ?? 0);
  if (used >= limit) return { ok: false as const, used, limit };

  const { error: updErr } = await db
    .from("usage_counters")
    .update({ stats_used: used + 1 })
    .eq("user_id", userId);
  if (updErr) throw updErr;

  const { error: ledErr } = await db.from("usage_ledger").insert({
    user_id: userId,
    action_type: "stats",
    delta: -1,
    reason: "usage",
    direction: "debit",
    action: "stats",
    note: "Stats invoked via /api/stats",
    amount: 1,
  });
  if (ledErr) throw ledErr;

  return { ok: true as const, used: used + 1, limit };
}

async function setStatusGuarded(opts: {
  sessionId: string;
  userId: string;
  from: LifecycleStage[];
  to: LifecycleStage;
}) {
  const db = supabaseServiceClient();
  const { data, error } = await db
    .from("property_sessions")
    .update({ status: opts.to })
    .eq("id", opts.sessionId)
    .eq("user_id", opts.userId)
    .in("status", opts.from)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function buildStatsPrompt(args: {
  listingFactsConfirmed: any;
  preferences: any;
  listingUrl: string;
}) {
  return `
You are generating listing statistics for a UK homebuyer app.

IMPORTANT RULES:
1) Output MUST be strict JSON only. No markdown. No extra text.
2) All *_score fields MUST be integers from 0 to 10.
3) Distances MUST be integer meters. Times MUST be integer minutes.
4) Always return a value for every field (even if uncertain). If you must guess, set confidence="low" and explain in notes.
5) Provide sources whenever you used web information (URLs preferred). If you used listing data only, put source "listing".
6) Use the user's preferences to decide which optional fields matter, but still fill all fields.

PREFERENCE WEIGHTS INTERPRETATION:
- safety_weight, cleanliness_weight, transport_convenience_weight are integers 1..10.
- If a weight is exactly 5, treat it as "average person / neutral preference" (not a special priority).
- If weight > 5: the user cares more than average.
- If weight < 5: the user cares less than average.
In your notes, add a brief comment when a weight is 5 explaining that it's neutral/average.

TASK:
Given (A) confirmed listing facts, (B) the user's preferences, and (C) the listing URL, compute:
- Commute estimate from listing postcode to work_postcode following transport_mode and constraints.
- Proximity stats: nearest station, supermarket, gym, school, religious building, green space.
- Area-level scores: safety_score, cleanliness_score, transport_convenience_score.
- Running cost estimates: service_charge_estimate_annual, ground_rent_estimate_annual.

When estimating:
- Prefer official, reputable sources for safety/crime, transport, and area info. If you cannot find a credible source quickly, still output an integer but mark confidence low.
- If a preference priority is false (e.g., gym_priority=false), you may use simpler sources and allow lower confidence, but still provide a value.

INPUTS:

A) listing_facts_confirmed:
${JSON.stringify(args.listingFactsConfirmed)}

B) user_preferences (table row):
${JSON.stringify(args.preferences)}

C) listing_url:
${args.listingUrl}

OUTPUT JSON SCHEMA (must match exactly):

{
  "stats_version": 1,
  "fields": {
    "commute_total_minutes": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "commute_walk_minutes":  {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "commute_mode":          {"value": "public_transport|car|bike|walk", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "nearest_station_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "nearest_station_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "supermarket_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "supermarket_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "gym_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "gym_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "school_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "school_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "religious_building_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "religious_building_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "green_space_distance_m": {"value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": ""},
    "green_space_name":       {"value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": ""},

    "safety_score": { "value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": "" },
    "cleanliness_score": { "value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": "" },
    "transport_convenience_score": { "value": 0, "confidence": "low|medium|high", "sources": ["..."], "notes": "" },

    "service_charge_estimate_annual": { "value": 0, "confidence": "low|medium|high", "sources": ["listing|..."], "notes": "" },
    "ground_rent_estimate_annual":    { "value": 0, "confidence": "low|medium|high", "sources": ["listing|..."], "notes": "" },

    "running_costs_confidence": { "value": "low|medium|high", "confidence": "low|medium|high", "sources": ["..."], "notes": "" },
    "running_costs_notes":      { "value": "", "confidence": "low|medium|high", "sources": ["..."], "notes": "" }
  },

  "required_confidence": { "field": "low|medium|high" },
  "required_source":     { "field": ["..."] },
  "optional_confidence": { "field": "low|medium|high" },
  "optional_source":     { "field": ["..."] }
}

Additionally:
- Fill required_confidence/source for these required fields:
  commute_total_minutes, commute_walk_minutes, commute_mode,
  nearest_station_distance_m, nearest_station_name,
  supermarket_distance_m, supermarket_name,
  green_space_distance_m, green_space_name,
  safety_score
- Everything else goes into optional_confidence/source.

Return JSON only.
`.trim();
}

function requiredFields() {
  return [
    "commute_total_minutes",
    "commute_walk_minutes",
    "commute_mode",
    "nearest_station_distance_m",
    "nearest_station_name",
    "supermarket_distance_m",
    "supermarket_name",
    "green_space_distance_m",
    "green_space_name",
    "safety_score",
  ];
}

function isMediumOrHigh(c: string | undefined | null) {
  return c === "medium" || c === "high";
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
    const sessionId = body?.property_session_id as string | undefined;
    const forceRecalc = Boolean(body?.force_recalc);
    if (!sessionId) return NextResponse.json({ error: "property_session_id required" }, { status: 400 });

    const db = supabaseServiceClient();

    // Ownership + current status
    const { data: session, error: sErr } = await db
      .from("property_sessions")
      .select("id,user_id,status,rightmove_url")
      .eq("id", sessionId)
      .single();
    if (sErr) throw sErr;
    if ((session as any).user_id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const currentStatus = (session as any).status as LifecycleStage;

    // Preconditions: must have confirmed facts + min prefs
    const { data: facts, error: fErr } = await db
      .from("listing_facts_confirmed")
      .select("*")
      .eq("property_session_id", sessionId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!facts) return NextResponse.json({ error: "Listing not confirmed" }, { status: 400 });

    const { data: prefs, error: pErr } = await db.from("preferences").select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prefs) return NextResponse.json({ error: "Preferences not found" }, { status: 400 });

    const min = checkMinimumPreferences(prefs);
    if (!min.ok) {
      return NextResponse.json({ error: "MIN_PREFS_MISSING", missing: min.missing }, { status: 400 });
    }

    // Allowed states to run stats
    const allowedFrom: LifecycleStage[] = forceRecalc
      ? ["CONFIRMED", "STATS_FAILED", "STATS_READY", "AI_READY", "EVAL_FAILED", "STATS_NEEDS_CONFIRMATION"]
      : ["CONFIRMED", "STATS_FAILED", "STATS_NEEDS_CONFIRMATION"];

    const guarded = await setStatusGuarded({
      sessionId,
      userId,
      from: allowedFrom,
      to: "STATS_RUNNING",
    });
    if (!guarded) {
      return NextResponse.json({ error: "ALREADY_RUNNING_OR_INVALID_STATE", status: currentStatus }, { status: 409 });
    }

    // Quota + ledger debit (stats consumes 1 usage)
    const quota = await checkAndConsumeQuota(userId, "stats");
    if (!quota.ok) {
      // revert to previous status if quota exceeded
      await db.from("property_sessions").update({ status: currentStatus }).eq("id", sessionId);
      return NextResponse.json({ error: "Quota exceeded", used: quota.used, limit: quota.limit }, { status: 402 });
    }

    if (!process.env.OPENAI_API_KEY) {
      await db.from("property_sessions").update({ status: "STATS_FAILED" }).eq("id", sessionId);
      return NextResponse.json({ error: "OPENAI_API_KEY missing" }, { status: 500 });
    }

    const prompt = buildStatsPrompt({
      listingFactsConfirmed: facts,
      preferences: prefs,
      listingUrl: (session as any).rightmove_url,
    });

    const resp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: prompt,
      tools: [{ type: "web_search" }],
      temperature: 0.1,
      max_output_tokens: 2200,
    });

    const outputText = (resp as any).output_text ?? "";
    const parsed = parseJsonLoose(outputText);
    if (!parsed || typeof parsed !== "object" || !parsed.fields) {
      await db.from("property_sessions").update({ status: "STATS_FAILED" }).eq("id", sessionId);
      return NextResponse.json({ error: "AI returned non-JSON or missing fields" }, { status: 500 });
    }

    const fields = parsed.fields as Record<string, any>;

    // Build listing_stats_raw payload
    const rawPayload: any = {
      property_session_id: sessionId,
      stats_version: Number(parsed.stats_version ?? 1),
      computed_at: nowIso(),

      commute_total_minutes: Number(fields.commute_total_minutes?.value ?? 0),
      commute_walk_minutes: Number(fields.commute_walk_minutes?.value ?? 0),
      commute_mode: String(fields.commute_mode?.value ?? ""),
      commute_confidence: String(fields.commute_total_minutes?.confidence ?? "low"),
      commute_notes: String(fields.commute_total_minutes?.notes ?? ""),

      nearest_station_distance_m: Number(fields.nearest_station_distance_m?.value ?? 0),
      nearest_station_name: String(fields.nearest_station_name?.value ?? ""),
      supermarket_distance_m: Number(fields.supermarket_distance_m?.value ?? 0),
      supermarket_name: String(fields.supermarket_name?.value ?? ""),
      gym_distance_m: Number(fields.gym_distance_m?.value ?? 0),
      gym_name: String(fields.gym_name?.value ?? ""),
      school_distance_m: Number(fields.school_distance_m?.value ?? 0),
      school_name: String(fields.school_name?.value ?? ""),
      religious_building_distance_m: Number(fields.religious_building_distance_m?.value ?? 0),
      religious_building_name: String(fields.religious_building_name?.value ?? ""),
      green_space_distance_m: Number(fields.green_space_distance_m?.value ?? 0),
      green_space_name: String(fields.green_space_name?.value ?? ""),

      safety_score: Number(fields.safety_score?.value ?? 0),
      cleanliness_score: Number(fields.cleanliness_score?.value ?? 0),
      transport_convenience_score: Number(fields.transport_convenience_score?.value ?? 0),

      service_charge_estimate_annual: Number(fields.service_charge_estimate_annual?.value ?? 0),
      ground_rent_estimate_annual: Number(fields.ground_rent_estimate_annual?.value ?? 0),
      running_costs_confidence: String(fields.running_costs_confidence?.value ?? "low"),
      running_costs_notes: String(fields.running_costs_notes?.value ?? ""),

      required_confidence: parsed.required_confidence ?? null,
      required_source: parsed.required_source ?? null,
      optional_confidence: parsed.optional_confidence ?? null,
      optional_source: parsed.optional_source ?? null,
    };

    const { error: rawErr } = await db
      .from("listing_stats_raw")
      .upsert(rawPayload, { onConflict: "property_session_id" });
    if (rawErr) throw rawErr;

    // Auto-confirm gate
    const reqFields = requiredFields();
    const allOk = reqFields.every((k) => isMediumOrHigh(String(fields[k]?.confidence ?? parsed.required_confidence?.[k] ?? "low")));

    if (allOk) {
      const confirmedPayload: any = {
        property_session_id: sessionId,
        commute_total_minutes: rawPayload.commute_total_minutes,
        commute_walk_minutes: rawPayload.commute_walk_minutes,
        commute_mode: rawPayload.commute_mode,
        nearest_station_distance_m: rawPayload.nearest_station_distance_m,
        nearest_station_name: rawPayload.nearest_station_name,
        supermarket_distance_m: rawPayload.supermarket_distance_m,
        supermarket_name: rawPayload.supermarket_name,
        green_space_distance_m: rawPayload.green_space_distance_m,
        green_space_name: rawPayload.green_space_name,
        safety_score: rawPayload.safety_score,
        required_confidence: parsed.required_confidence ?? null,
        required_source: parsed.required_source ?? null,
        notes: "Auto-confirmed (required fields medium/high)",
        confirmed_by_user: false,
        confirmed_at: nowIso(),
      };

      const { error: confErr } = await db
        .from("listing_stats_confirmed")
        .upsert(confirmedPayload, { onConflict: "property_session_id" });
      if (confErr) throw confErr;

      await db.from("property_sessions").update({ status: "STATS_READY" }).eq("id", sessionId);
      return NextResponse.json({ ok: true, status: "STATS_READY" });
    }

    await db.from("property_sessions").update({ status: "STATS_NEEDS_CONFIRMATION" }).eq("id", sessionId);
    return NextResponse.json({ ok: true, status: "STATS_NEEDS_CONFIRMATION" });
  } catch (e: any) {
    // Best effort: mark session failed if we know the id
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
