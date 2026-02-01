// app/api/extract/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAuthClient, supabaseServiceClient } from "@/lib/supabaseServer";

type Stage = "auth" | "quota" | "fetch" | "openai" | "full";

type AIFacts = {
  price?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  tenure?: string | null;
  lease_years_remaining?: number | null;
  postcode?: string | null;
  address?: string | null;
  description?: string | null;
  estate_agent?: string | null;
  ai_confidence?: Record<string, number> | null; // jsonb
  ai_warnings?: string[] | null; // text[]
};

function parseRightmoveListingId(url: string): string | null {
  // Handles: https://www.rightmove.co.uk/properties/170645465#/?channel=RES_BUY
  const m = url.match(/rightmove\.co\.uk\/properties\/(\d+)/i);
  return m?.[1] ?? null;
}

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

async function ensureUsageRow(userId: string) {
  const db = supabaseServiceClient();
  // upsert row for counters if missing
  const { error } = await db
    .from("usage_counters")
    .upsert({ user_id: userId }, { onConflict: "user_id" });

  if (error) throw error;
}

async function checkAndConsumeQuota(userId: string, action: "extract") {
  const db = supabaseServiceClient();

  await ensureUsageRow(userId);

  const { data: counters, error: readErr } = await db
    .from("usage_counters")
    .select("extract_used, extract_limit")
    .eq("user_id", userId)
    .single();

  if (readErr) throw readErr;

  const used = counters.extract_used as number;
  const limit = counters.extract_limit as number;

  if (used >= limit) {
    return { ok: false, used, limit };
  }

  // increment used
  const { error: updErr } = await db
    .from("usage_counters")
    .update({ extract_used: used + 1 })
    .eq("user_id", userId);

  if (updErr) throw updErr;

  // ledger entry (MUST match constraints)
  const { error: ledErr } = await db.from("usage_ledger").insert({
    user_id: userId,
    action_type: "extract",   // allowed
    delta: -1,                // debit usage
    reason: "usage",          // MUST be one of: free_grant|purchase|usage|admin_adjustment|refund
    direction: "debit",       // optional but if set must be debit|credit
    action: "extract",        // optional
    note: "Extract invoked via /api/extract",
    amount: 1,                // optional (integer). You can also omit this.
  });
  if (ledErr) throw ledErr;

  return { ok: true, used: used + 1, limit };
}

async function fetchRightmoveHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        // Some sites block empty UA
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      // no-store so dev doesn't cache bad responses
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Rightmove fetch failed: ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractSnippets(html: string): string[] {
  // “Good enough” snippets without relying on Rightmove internal JSON formats.
  // We strip tags and grab some high-signal areas.
  const metaDesc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";

  const title =
    html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";

  // crude text body
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const chunks: string[] = [];
  if (title) chunks.push(`TITLE: ${title}`);
  if (metaDesc) chunks.push(`META_DESCRIPTION: ${metaDesc}`);

  // take some slices of the page text (avoid too huge)
  if (text) {
    chunks.push(`PAGE_TEXT_HEAD: ${text.slice(0, 800)}`);
    chunks.push(`PAGE_TEXT_MID: ${text.slice(Math.max(0, Math.floor(text.length / 2) - 400), Math.floor(text.length / 2) + 400)}`);
  }

  // dedupe + limit
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks.map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.slice(0, 6);
}

async function upsertPropertySession(userId: string, rightmoveUrl: string, listingId: string | null) {
  const db = supabaseServiceClient();

  async function enforceMaxLinks() {
    // Hard cap: 100 saved links per user (paywall later)
    const { count, error } = await db
      .from("property_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw error;
    const c = count ?? 0;
    if (c >= 100) {
      const err: any = new Error("MAX_LINKS_REACHED");
      err.code = "MAX_LINKS_REACHED";
      err.limit = 100;
      throw err;
    }
  }

  // Find existing session using your unique logic:
  // - if listingId exists, use (user_id, rightmove_listing_id)
  // - else use (user_id, rightmove_url)
  if (listingId) {
    const { data: existing } = await db
      .from("property_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("rightmove_listing_id", listingId)
      .maybeSingle();

    if (existing) return existing;

    await enforceMaxLinks();

    const { data, error } = await db
      .from("property_sessions")
      .insert({
        user_id: userId,
        rightmove_url: rightmoveUrl,
        rightmove_listing_id: listingId,
        status: "CREATED",
      })
      .select("*")
      .single();

    if (error) throw error;
    return data;
  } else {
    const { data: existing } = await db
      .from("property_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("rightmove_url", rightmoveUrl)
      .maybeSingle();

    if (existing) return existing;

    await enforceMaxLinks();

    const { data, error } = await db
      .from("property_sessions")
      .insert({
        user_id: userId,
        rightmove_url: rightmoveUrl,
        status: "CREATED",
      })
      .select("*")
      .single();

    if (error) throw error;
    return data;
  }
}

async function writeFactsRaw(propertySessionId: string, facts: AIFacts) {
  const db = supabaseServiceClient();
  const { error } = await db
    .from("listing_facts_raw")
    .upsert(
      {
        property_session_id: propertySessionId,
        price: facts.price ?? null,
        bedrooms: facts.bedrooms ?? null,
        bathrooms: facts.bathrooms ?? null,
        property_type: facts.property_type ?? null,
        tenure: facts.tenure ?? null,
        lease_years_remaining: facts.lease_years_remaining ?? null,
        postcode: facts.postcode ?? null,
        address: facts.address ?? null,
        description: facts.description ?? null,
        estate_agent: facts.estate_agent ?? null,
        ai_confidence: facts.ai_confidence ?? null,
        ai_warnings: facts.ai_warnings ?? null,
        // extracted_at default is now()
      },
      { onConflict: "property_session_id" } // matches unique_raw_per_session
    );

  if (error) throw error;
}

async function updateSessionStatus(sessionId: string, status: string) {
  const db = supabaseServiceClient();
  const { error } = await db
    .from("property_sessions")
    .update({ status, last_extracted_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}


import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function callOpenAIWithWeb(rightmoveUrl: string, snippets: string[]) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ai_warnings: ["OPENAI_API_KEY missing – skipping AI extraction"],
      ai_confidence: { overall: 0 },
    };
  }

  const prompt = `
You are extracting UK property listing facts from a Rightmove URL.

Task:
1) Use web search to open/check the Rightmove listing page.
2) Use the provided snippets as additional evidence.
3) Return ONLY valid JSON with these keys:
price (number|null), bedrooms (number|null), bathrooms (number|null),
property_type (string|null), tenure (string|null), lease_years_remaining (number|null),
postcode (string|null), address (string|null), description (string|null), estate_agent (string|null),
ai_confidence (object|null), ai_warnings (array|null).

Rules:
- Do not guess. If you cannot find a field, return null.
- Prefer values you can cite from the page content.
- If the page blocks access, add a warning in ai_warnings.

Rightmove URL:
${rightmoveUrl}

Snippets:
${snippets.map((s, i) => `SNIPPET_${i + 1}: ${s}`).join("\n\n")}
`.trim();

  const resp = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    input: prompt,
    tools: [
      { type: "web_search" } // built-in web tool
    ],
    temperature: 0.1,
    max_output_tokens: 900,
  });

  // The SDK usually provides output_text convenience
  const outputText = (resp as any).output_text ?? "";

  let parsed: any = null;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    const m = outputText.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ai_warnings: ["AI returned non-JSON or empty output"],
      ai_confidence: { overall: 0 },
    };
  }

  return parsed;
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Missing Authorization: Bearer <token>" }, { status: 401 });
    }

    const { rightmove_url, stage } = (await req.json().catch(() => ({}))) as {
      rightmove_url?: string;
      stage?: Stage;
    };

    const runStage: Stage = stage || "full";

    // 1) AUTH
    const auth = supabaseAuthClient();
    const { data: userRes, error: userErr } = await auth.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return NextResponse.json({ error: "Invalid JWT", details: userErr?.message }, { status: 401 });
    }
    const userId = userRes.user.id;

    if (runStage === "auth") {
      return NextResponse.json({ ok: true, stage: "auth", user_id: userId });
    }

    // 2) QUOTA
    const quota = await checkAndConsumeQuota(userId, "extract");
    if (!quota.ok) {
      return NextResponse.json(
        { ok: false, stage: "quota", error: "Quota exceeded", used: quota.used, limit: quota.limit },
        { status: 402 }
      );
    }

    if (runStage === "quota") {
      return NextResponse.json({ ok: true, stage: "quota", user_id: userId, quota });
    }

    if (!rightmove_url || typeof rightmove_url !== "string") {
      return NextResponse.json({ error: "Missing rightmove_url in body" }, { status: 400 });
    }

    const listingId = parseRightmoveListingId(rightmove_url);

    // 3) FETCH + SNIPPETS
    const html = await fetchRightmoveHtml(rightmove_url);
    const snippets = extractSnippets(html);

    if (runStage === "fetch") {
      return NextResponse.json({ ok: true, stage: "fetch", user_id: userId, listing_id: listingId, snippets });
    }

    // 4) OPENAI
    const facts = await callOpenAIWithWeb(rightmove_url, snippets);

    if (runStage === "openai") {
      return NextResponse.json({ ok: true, stage: "openai", user_id: userId, listing_id: listingId, snippets, facts });
    }

    // FULL: write session + facts
    let session: any;
    try {
      session = await upsertPropertySession(userId, rightmove_url, listingId);
    } catch (err: any) {
      if (err?.code === "MAX_LINKS_REACHED") {
        return NextResponse.json(
          { ok: false, error: "MAX_LINKS_REACHED", limit: err?.limit ?? 100 },
          { status: 403 }
        );
      }
      throw err;
    }

    await updateSessionStatus(session.id, "FETCHED_HTML");      // optional if you want it explicit
    await updateSessionStatus(session.id, "AI_PARSED");
    
    await writeFactsRaw(session.id, facts);
    
    // after raw facts exist, flag as needing user confirmation
    await updateSessionStatus(session.id, "NEEDS_CONFIRMATION");
    

    return NextResponse.json({
      ok: true,
      stage: "full",
      user_id: userId,
      session_id: session.id,
      listing_id: listingId,
      snippets,
      facts,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || String(e), stack: e?.stack || null },
      { status: 500 }
    );
  }
}
