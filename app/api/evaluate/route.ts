// app/api/evaluate/route.ts
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

async function ensureUsageRow(userId: string) {
  const db = supabaseServiceClient();
  const { error } = await db.from("usage_counters").upsert({ user_id: userId }, { onConflict: "user_id" });
  if (error) throw error;
}

async function checkAndConsumeQuota(userId: string, action: "evaluate") {
  const db = supabaseServiceClient();
  await ensureUsageRow(userId);

  const { data, error } = await db
    .from("usage_counters")
    .select("evaluate_used, evaluate_limit")
    .eq("user_id", userId)
    .single();
  if (error) throw error;

  const used = Number((data as any).evaluate_used ?? 0);
  const limit = Number((data as any).evaluate_limit ?? 0);
  if (used >= limit) return { ok: false as const, used, limit };

  const { error: updErr } = await db
    .from("usage_counters")
    .update({ evaluate_used: used + 1 })
    .eq("user_id", userId);
  if (updErr) throw updErr;

  const { error: ledErr } = await db.from("usage_ledger").insert({
    user_id: userId,
    action_type: "evaluate",
    delta: -1,
    reason: "usage",
    direction: "debit",
    action: "evaluate",
    note: "Evaluation invoked via /api/evaluate",
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

function buildEvaluatePrompt(args: {
  listingFactsConfirmed: any;
  listingStatsConfirmed: any;
  preferences: any;
  listingUrl: string;
}) {
  return `
You are evaluating a UK property listing for a specific user.

IMPORTANT RULES:
1) Output MUST be strict JSON only. No markdown. No extra text.
2) Use the user's preferences; interpret weights:
   - If weight == 5, treat as "average person / neutral preference" and note that in the relevant explanation.
   - If > 5: higher-than-average importance; if < 5: lower-than-average.
3) You may use web_search to verify claims (area safety, transport, flood risk, leasehold pitfalls, etc.). Provide sources for any important factual claim.
4) Also use web_search to form a brief opinion on the estate agent / branch handling the listing (reputation, customer sentiment, red flags). If you cannot find credible information, say so and keep confidence low.
5) Be cautious: if uncertain, add an assumption and/or warning rather than stating it as fact.

ESTATE AGENT OPINION (required):
- Use web_search to gather publicly available signals about the estate agent / branch named in listing_facts_confirmed.estate_agent (or from the listing URL if not provided).
- Summarize your opinion in "estate_agent_snippet": include the agent name, a short sentiment (positive/neutral/negative), and 2-4 bullet-like sentences about reputation/complaints/service quality.
- If you cannot find credible info quickly, still provide an opinion but mark it clearly as limited and cite what you did find (or say "no reliable public info found" and keep it neutral).

INPUTS:
A) listing_facts_confirmed:
${JSON.stringify(args.listingFactsConfirmed)}

B) listing_stats_confirmed:
${JSON.stringify(args.listingStatsConfirmed)}

C) user_preferences:
${JSON.stringify(args.preferences)}

D) listing_url:
${args.listingUrl}

OUTPUT JSON SCHEMA (must match exactly):

{
  "rank_score": 0.0,
  "overall_score": 0.0,
  "executive_summary": "",
  "estate_agent_snippet": "",
  "per_preference": {
    "budget": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "beds_baths": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "property_type": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "tenure": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "commute": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "running_costs": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "safety": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "cleanliness": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "transport_convenience": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "lifestyle": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "storage": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "parking": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""},
    "condition": {"score": 0, "explanation": "", "evidence": ["..."], "weight_note": ""}
  },
  "warnings": ["..."],
  "assumptions": ["..."],
  "model_info": {
    "schema_version": 1,
    "notes": ""
  }
}

Scoring guidance:
- per_preference.*.score is integer 0..10.
- overall_score is 0..10 (float allowed).
- rank_score is 0..100 (float allowed).
- In each per_preference.*.weight_note, explicitly mention if the relevant weight is 5 (neutral/average) vs above/below average.

Return JSON only.
`.trim();
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
    if (!sessionId) return NextResponse.json({ error: "property_session_id required" }, { status: 400 });

    const db = supabaseServiceClient();

    const { data: session, error: sErr } = await db
      .from("property_sessions")
      .select("id,user_id,status,rightmove_url")
      .eq("id", sessionId)
      .single();
    if (sErr) throw sErr;
    if ((session as any).user_id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const currentStatus = (session as any).status as LifecycleStage;
    if (currentStatus !== "STATS_READY" && currentStatus !== "AI_READY" && currentStatus !== "EVAL_FAILED") {
      return NextResponse.json({ error: "Invalid state", status: currentStatus }, { status: 409 });
    }

    const guarded = await setStatusGuarded({
      sessionId,
      userId,
      from: ["STATS_READY", "AI_READY", "EVAL_FAILED"],
      to: "EVAL_RUNNING",
    });
    if (!guarded) {
      return NextResponse.json({ error: "ALREADY_RUNNING_OR_INVALID_STATE", status: currentStatus }, { status: 409 });
    }

    // Read inputs
    const { data: facts, error: fErr } = await db
      .from("listing_facts_confirmed")
      .select("*")
      .eq("property_session_id", sessionId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!facts) {
      await db.from("property_sessions").update({ status: currentStatus }).eq("id", sessionId);
      return NextResponse.json({ error: "Listing not confirmed" }, { status: 400 });
    }

    const { data: stats, error: stErr } = await db
      .from("listing_stats_confirmed")
      .select("*")
      .eq("property_session_id", sessionId)
      .maybeSingle();
    if (stErr) throw stErr;
    if (!stats) {
      await db.from("property_sessions").update({ status: currentStatus }).eq("id", sessionId);
      return NextResponse.json({ error: "Stats not ready" }, { status: 400 });
    }

    const { data: prefs, error: pErr } = await db
      .from("preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prefs) {
      await db.from("property_sessions").update({ status: currentStatus }).eq("id", sessionId);
      return NextResponse.json({ error: "Preferences not found" }, { status: 400 });
    }

    // Quota
    const quota = await checkAndConsumeQuota(userId, "evaluate");
    if (!quota.ok) {
      await db.from("property_sessions").update({ status: currentStatus }).eq("id", sessionId);
      return NextResponse.json({ error: "Quota exceeded", used: quota.used, limit: quota.limit }, { status: 402 });
    }

    if (!process.env.OPENAI_API_KEY) {
      await db.from("property_sessions").update({ status: "EVAL_FAILED" }).eq("id", sessionId);
      return NextResponse.json({ error: "OPENAI_API_KEY missing" }, { status: 500 });
    }

    const prompt = buildEvaluatePrompt({
      listingFactsConfirmed: facts,
      listingStatsConfirmed: stats,
      preferences: prefs,
      listingUrl: (session as any).rightmove_url,
    });

    const resp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: prompt,
      tools: [{ type: "web_search" }],
      temperature: 0.1,
      max_output_tokens: 2400,
    });

    const outputText = (resp as any).output_text ?? "";
    const parsed = parseJsonLoose(outputText);
    if (!parsed || typeof parsed !== "object") {
      await db.from("property_sessions").update({ status: "EVAL_FAILED" }).eq("id", sessionId);
      return NextResponse.json({ error: "AI returned non-JSON" }, { status: 500 });
    }

    const evalPayload: any = {
      property_session_id: sessionId,
      rank_score: parsed.rank_score ?? null,
      overall_score: parsed.overall_score ?? null,
      executive_summary: String(parsed.executive_summary ?? ""),
      estate_agent_snippet: String(parsed.estate_agent_snippet ?? ""),
      per_preference: parsed.per_preference ?? {},
      warnings: parsed.warnings ?? null,
      assumptions: parsed.assumptions ?? null,
      model_info: parsed.model_info ?? { schema_version: 1 },
      evaluated_at: nowIso(),
    };

    const { error: evErr } = await db
      .from("listing_evaluation_raw")
      .upsert(evalPayload, { onConflict: "property_session_id" });
    if (evErr) throw evErr;

    await db.from("property_sessions").update({ status: "AI_READY" }).eq("id", sessionId);
    return NextResponse.json({ ok: true, status: "AI_READY" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
