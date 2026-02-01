"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { useRouter } from "next/navigation";

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

type Facts = {
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  tenure: string | null;
  lease_years_remaining: number | null;
  postcode: string | null;
  address: string | null;
  description: string | null;
  estate_agent: string | null;
};

type StatsRaw = {
  stats_version: number | null;
  computed_at: string | null;
  commute_total_minutes: number | null;
  commute_walk_minutes: number | null;
  commute_mode: string | null;
  commute_confidence: string | null;
  commute_notes: string | null;
  nearest_station_distance_m: number | null;
  nearest_station_name: string | null;
  supermarket_distance_m: number | null;
  supermarket_name: string | null;
  green_space_distance_m: number | null;
  green_space_name: string | null;
  safety_score: number | null;
  cleanliness_score: number | null;
  transport_convenience_score: number | null;
  required_confidence: Record<string, string> | null;
  required_source: Record<string, string[]> | null;
  optional_confidence: Record<string, string> | null;
  optional_source: Record<string, string[]> | null;
};

type StatsConfirmed = {
  commute_total_minutes: number | null;
  commute_walk_minutes: number | null;
  commute_mode: string | null;
  nearest_station_distance_m: number | null;
  nearest_station_name: string | null;
  supermarket_distance_m: number | null;
  supermarket_name: string | null;
  green_space_distance_m: number | null;
  green_space_name: string | null;
  safety_score: number | null;
  required_confidence: Record<string, string> | null;
  required_source: Record<string, string[]> | null;
  notes: string | null;
  confirmed_by_user: boolean | null;
  confirmed_at: string | null;
};

type EvaluationRaw = {
  rank_score: number | null;
  overall_score: number | null;
  executive_summary: string | null;
  estate_agent_snippet?: string | null;
  per_preference?: Record<string, any> | null;
  warnings?: string[] | null;
  assumptions?: string[] | null;
  model_info?: any;
  evaluated_at: string | null;
};

type SessionRow = {
  id: string;
  created_at: string;
  last_extracted_at: string | null;
  rightmove_url: string;
  rightmove_listing_id: string | null;
  status: LifecycleStage;
  listing_facts_raw: Facts | Facts[] | null;
  listing_facts_confirmed: (Facts & { confirmed_at: string }) | (Facts & { confirmed_at: string })[] | null;
  listing_stats_raw: StatsRaw | StatsRaw[] | null;
  listing_stats_confirmed: StatsConfirmed | StatsConfirmed[] | null;
  listing_evaluation_raw: EvaluationRaw | EvaluationRaw[] | null;
};

function badgeColor(status: LifecycleStage) {
  if (status === "NEEDS_CONFIRMATION") return "#fff3cd";
  if (status === "CONFIRMED" || status === "STATS_READY" || status === "VIDEO_READY") return "#d1e7dd";
  if (status.endsWith("FAILED")) return "#f8d7da";
  return "#e2e3e5";
}

export default function PropertiesPage() {
  const router = useRouter();

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [url, setUrl] = useState("");
  const [runStage] = useState<"full">("full");
  const [status, setStatus] = useState<string>("");

  // per-session action loading
  const [actionBusy, setActionBusy] = useState<Record<string, string | null>>({});

  // modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSession, setConfirmSession] = useState<SessionRow | null>(null);
  const [confirmFacts, setConfirmFacts] = useState<Facts | null>(null);
  const [confirmErr, setConfirmErr] = useState<string>("");

  // stats confirm modal
  const [statsConfirmOpen, setStatsConfirmOpen] = useState(false);
  const [statsConfirmSession, setStatsConfirmSession] = useState<SessionRow | null>(null);
  const [statsDraft, setStatsDraft] = useState<Partial<StatsConfirmed> & { notes?: string } | null>(null);
  const [statsConfirmErr, setStatsConfirmErr] = useState<string>("");

  // quick-nav
  const [activeId, setActiveId] = useState<string | null>(null);

  // full report modal
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSession, setReportSession] = useState<SessionRow | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      if (!data.session) router.push("/login");
      else await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getToken(): Promise<string> {
    const { data } = await supabaseBrowser.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not logged in");
    return token;
  }

  async function refresh() {
    setLoading(true);
    setStatus("Loading sessions...");
    try {
      const token = await getToken();
      const res = await fetch("/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to load sessions");
      setSessions(json.sessions || []);
      setStatus("OK");
    } catch (e: any) {
      setStatus(`Error: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runExtract() {
    setStatus("Running extract...");
    try {
      const token = await getToken();
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rightmove_url: url, stage: runStage }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json?.error === "MAX_LINKS_REACHED") {
          throw new Error(`You\'ve reached the 100 link limit. Remove one to add another.`);
        }
        throw new Error(json?.error || "Extract failed");
      }
      setUrl("");
      setStatus("Extract OK. Refreshing...");
      await refresh();
    } catch (e: any) {
      setStatus(`Extract error: ${e.message || String(e)}`);
    }
  }

  const cards = useMemo(() => sessions, [sessions]);

  const topTen = useMemo(() => (sessions || []).slice(0, 10), [sessions]);

  const rankedTen = useMemo(() => {
    const rows = (sessions || [])
      .map((s) => {
        const ev = getOne(s.listing_evaluation_raw) as any;
        const score = ev?.overall_score != null ? Number(ev.overall_score) : null;
        return { s, score };
      })
      .filter((x) => x.score != null)
      .sort((a, b) => (b.score as number) - (a.score as number))
      .slice(0, 10)
      .map((x) => x.s);
    return rows;
  }, [sessions]);

  function getOne<T>(v: T | T[] | null | undefined): T | null {
    if (!v) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  function titleForSession(s: SessionRow) {
    const conf = getOne(s.listing_facts_confirmed);
    const raw = getOne(s.listing_facts_raw);
    const postcode = conf?.postcode ?? raw?.postcode ?? null;
    const addr = conf?.address ?? raw?.address ?? null;
    if (postcode && addr) return `${postcode} — ${addr}`;
    if (postcode) return postcode;
    return "Listing";
  }

  function viewListingLink(s: SessionRow) {
    return s.rightmove_url;
  }

  function evalState(s: SessionRow): "missing" | "fresh" | "stale" {
    const statsC = getOne(s.listing_stats_confirmed);
    const evalR = getOne(s.listing_evaluation_raw);
    if (!evalR?.evaluated_at) return "missing";
    const tEval = new Date(evalR.evaluated_at).getTime();
    const tStats = statsC?.confirmed_at ? new Date(statsC.confirmed_at).getTime() : null;
    if (tStats !== null && tEval < tStats) return "stale";
    return "fresh";
  }

  function setBusy(sessionId: string, what: string | null) {
    setActionBusy((p) => ({ ...p, [sessionId]: what }));
  }

  async function runReExtract(s: SessionRow) {
    setBusy(s.id, "extract");
    try {
      const token = await getToken();
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rightmove_url: s.rightmove_url, stage: "full" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Re-extract failed");
      await refresh();
    } catch (e: any) {
      setStatus(`Re-extract error: ${e.message || String(e)}`);
    } finally {
      setBusy(s.id, null);
    }
  }

  async function runStats(s: SessionRow, force = false) {
    setBusy(s.id, "stats");
    try {
      const token = await getToken();
      const res = await fetch("/api/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ property_session_id: s.id, force_recalc: force }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json?.error === "MIN_PREFS_MISSING") {
          throw new Error(`Complete preferences before stats. Missing: ${(json?.missing || []).join(", ")}`);
        }
        throw new Error(json?.error || "Stats failed");
      }
      await refresh();
    } catch (e: any) {
      setStatus(`Stats error: ${e.message || String(e)}`);
    } finally {
      setBusy(s.id, null);
    }
  }

  async function runEvaluate(s: SessionRow) {
    setBusy(s.id, "evaluate");
    try {
      const token = await getToken();
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ property_session_id: s.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Evaluate failed");
      await refresh();
    } catch (e: any) {
      setStatus(`Evaluate error: ${e.message || String(e)}`);
    } finally {
      setBusy(s.id, null);
    }
  }

  function openReport(s: SessionRow) {
    setReportSession(s);
    setReportOpen(true);
  }

  function openStatsConfirm(s: SessionRow) {
    setStatsConfirmErr("");
    setStatsConfirmSession(s);
    const raw = getOne(s.listing_stats_raw);
    if (!raw) {
      setStatsConfirmErr("No stats_raw found.");
      return;
    }
    setStatsDraft({
      commute_total_minutes: raw.commute_total_minutes ?? 0,
      commute_walk_minutes: raw.commute_walk_minutes ?? 0,
      commute_mode: raw.commute_mode ?? "",
      nearest_station_distance_m: raw.nearest_station_distance_m ?? 0,
      nearest_station_name: raw.nearest_station_name ?? "",
      supermarket_distance_m: raw.supermarket_distance_m ?? 0,
      supermarket_name: raw.supermarket_name ?? "",
      green_space_distance_m: raw.green_space_distance_m ?? 0,
      green_space_name: raw.green_space_name ?? "",
      safety_score: raw.safety_score ?? 0,
      required_confidence: raw.required_confidence ?? null,
      required_source: raw.required_source ?? null,
      notes: "Confirmed by user",
    });
    setStatsConfirmOpen(true);
  }

  async function submitStatsConfirm() {
    if (!statsConfirmSession || !statsDraft) return;
    setStatsConfirmErr("");
    try {
      const token = await getToken();
      const res = await fetch("/api/stats/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          property_session_id: statsConfirmSession.id,
          stats: statsDraft,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Stats confirm failed");
      setStatsConfirmOpen(false);
      setStatsConfirmSession(null);
      setStatsDraft(null);
      await refresh();
    } catch (e: any) {
      setStatsConfirmErr(e.message || String(e));
    }
  }

  function openConfirm(s: SessionRow) {
    setConfirmErr("");
    setConfirmSession(s);

    // prefer raw facts if present; if already confirmed, use confirmed as starting point
    const raw =
    Array.isArray(s.listing_facts_raw)
    ? s.listing_facts_raw[0] ?? null
    : (s.listing_facts_raw ?? null);

    const conf =
    Array.isArray(s.listing_facts_confirmed)
    ? s.listing_facts_confirmed[0] ?? null
    : (s.listing_facts_confirmed ?? null);


    const initial: Facts = {
      price: (conf?.price ?? raw?.price ?? null) as any,
      bedrooms: (conf?.bedrooms ?? raw?.bedrooms ?? null) as any,
      bathrooms: (conf?.bathrooms ?? raw?.bathrooms ?? null) as any,
      property_type: (conf?.property_type ?? raw?.property_type ?? null) as any,
      tenure: (conf?.tenure ?? raw?.tenure ?? null) as any,
      lease_years_remaining: (conf?.lease_years_remaining ?? raw?.lease_years_remaining ?? null) as any,
      postcode: (conf?.postcode ?? raw?.postcode ?? null) as any,
      address: (conf?.address ?? raw?.address ?? null) as any,
      description: (conf?.description ?? raw?.description ?? null) as any,
      estate_agent: (conf?.estate_agent ?? raw?.estate_agent ?? null) as any,
    };

    setConfirmFacts(initial);
    setConfirmOpen(true);
  }

  async function submitConfirm() {
    if (!confirmSession || !confirmFacts) return;
    setConfirmErr("");

    // basic validation for required confirmed fields
    if (!confirmFacts.price || confirmFacts.price <= 0) return setConfirmErr("Price is required.");
    if (!confirmFacts.bedrooms || confirmFacts.bedrooms <= 0) return setConfirmErr("Bedrooms is required.");
    if (!confirmFacts.property_type?.trim()) return setConfirmErr("Property type is required.");
    if (!confirmFacts.tenure?.trim()) return setConfirmErr("Tenure is required.");
    if (!confirmFacts.postcode?.trim()) return setConfirmErr("Postcode is required.");

    try {
      const token = await getToken();
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: confirmSession.id, facts: confirmFacts }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Confirm failed");
      setConfirmOpen(false);
      setConfirmSession(null);
      setConfirmFacts(null);
      await refresh();
    } catch (e: any) {
      setConfirmErr(e.message || String(e));
    }
  }

  async function logout() {
    await supabaseBrowser.auth.signOut();
    router.push("/login");
  }

  return (
    <main style={{ maxWidth: 1280, margin: "24px auto", padding: "0 14px", fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>Saved Properties</h1>
          <p style={{ margin: "6px 0 0", color: "#666" }}>
            Paste a Rightmove link, extract, then confirm the details.
          </p>
        </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, borderRight: "1px solid #ddd", paddingRight: 10, marginRight: 2 }}>
              <button onClick={() => router.push("/preferences")} style={{ padding: "8px 12px" }}>Preferences</button>
              <button onClick={() => router.push("/account")} style={{ padding: "8px 12px" }}>Account</button>
            </div>

            <button onClick={refresh} style={{ padding: "8px 12px" }} disabled={loading}>Refresh</button>
            <button onClick={logout} style={{ padding: "8px 12px" }}>Logout</button>
          </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "260px 1fr 320px", gap: 14, alignItems: "start" }}>
        {/* LEFT: quick nav */}
        <aside style={{ border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fafafa", position: "sticky", top: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Quick nav</div>
          {topTen.length === 0 ? (
            <div style={{ color: "#666", fontSize: 13 }}>No listings yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {topTen.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setActiveId(s.id);
                    const el = document.getElementById(`card-${s.id}`);
                    el?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  style={{
                    textAlign: "left",
                    padding: "9px 10px",
                    borderRadius: 12,
                    border: "1px solid #ddd",
                    background: activeId === s.id ? "#e7f1ff" : "#fff",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                  }}
                  title={titleForSession(s)}
                >
                  {titleForSession(s)}
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
            Limit: 100 saved listings (paid upgrades coming).
          </div>
        </aside>

        {/* CENTER: add + cards */}
        <section>
          <section style={{ border: "1px solid #ddd", borderRadius: 14, padding: 12 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                style={{ flex: 1, padding: 10 }}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a Rightmove URL here..."
              />
              <button onClick={runExtract} style={{ padding: "10px 14px" }} disabled={!url.trim()}>
                Add & Extract
              </button>
            </div>
            <div style={{ marginTop: 8, color: "#666", fontSize: 13 }}>{status}</div>
          </section>

          <section style={{ marginTop: 14, display: "grid", gap: 12 }}>
        {cards.map((s) => {
          const raw = getOne(s.listing_facts_raw);
          const conf = getOne(s.listing_facts_confirmed);
          const statsC = getOne(s.listing_stats_confirmed);
          const statsR = getOne(s.listing_stats_raw);
          const evalR = getOne(s.listing_evaluation_raw);

          const isBusy = actionBusy[s.id] != null;
          const busyWhat = actionBusy[s.id];

          const canConfirmFacts = s.status === "NEEDS_CONFIRMATION";

          const canStats =
            s.status === "CONFIRMED" ||
            s.status === "STATS_FAILED" ||
            s.status === "STATS_NEEDS_CONFIRMATION" ||
            s.status === "STATS_READY" ||
            s.status === "AI_READY" ||
            s.status === "EVAL_FAILED";

          const canEvaluate = s.status === "STATS_READY" || s.status === "AI_READY" || s.status === "EVAL_FAILED";

          const eState = evalState(s);

          // Stats teaser (prefer confirmed stats)
          const commute = statsC?.commute_total_minutes != null ? `${statsC.commute_total_minutes}m` : "—";
          const station = statsC?.nearest_station_distance_m != null ? `${statsC.nearest_station_distance_m}m` : "—";
          const market = statsC?.supermarket_distance_m != null ? `${statsC.supermarket_distance_m}m` : "—";
          const green = statsC?.green_space_distance_m != null ? `${statsC.green_space_distance_m}m` : "—";
          const safety = statsC?.safety_score != null ? `${statsC.safety_score}/10` : "—";

          const title = titleForSession(s);

          // Right panel content
          let rightTitle = "";
          let rightBody = "";
          let rightCTA: { label: string; onClick: () => void; disabled?: boolean } | null = null;

          if (s.status === "AI_READY" && evalR) {
            rightTitle = "Score";
            rightBody = String(evalR.executive_summary ?? "");
          } else if (s.status === "STATS_READY") {
            rightTitle = "Stats ready";
            rightBody = "Run evaluation to get a score and summary.";
            rightCTA = { label: "Run evaluation", onClick: () => runEvaluate(s), disabled: busyWhat === "evaluate" };
          } else if (s.status === "STATS_NEEDS_CONFIRMATION") {
            rightTitle = "Stats need confirmation";
            rightBody = "Review low-confidence stats before continuing.";
            rightCTA = { label: "Review stats", onClick: () => openStatsConfirm(s) };
          } else if (s.status === "STATS_FAILED") {
            rightTitle = "Stats failed";
            rightBody = "Retry stats generation.";
            rightCTA = { label: "Retry stats", onClick: () => runStats(s, true), disabled: busyWhat === "stats" };
          } else if (s.status === "CONFIRMED") {
            rightTitle = "Ready";
            rightBody = "Calculate stats for this listing.";
            rightCTA = { label: "Calculate stats", onClick: () => runStats(s, false), disabled: busyWhat === "stats" };
          } else if (s.status === "NEEDS_CONFIRMATION") {
            rightTitle = "Needs confirmation";
            rightBody = "Confirm listing facts to continue.";
            rightCTA = { label: "Confirm facts", onClick: () => openConfirm(s) };
          } else if (s.status === "STATS_RUNNING") {
            rightTitle = "Calculating stats";
            rightBody = "Please wait…";
          } else if (s.status === "EVAL_RUNNING") {
            rightTitle = "Evaluating";
            rightBody = "Please wait…";
          } else if (s.status === "EVAL_FAILED") {
            rightTitle = "Evaluation failed";
            rightBody = "Retry evaluation.";
            rightCTA = { label: "Retry evaluation", onClick: () => runEvaluate(s), disabled: busyWhat === "evaluate" };
          } else {
            rightTitle = "Status";
            rightBody = s.status;
          }

          return (
            <div id={`card-${s.id}`} key={s.id} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontSize: 16, fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 700 }} title={title}>
                      {title}
                    </div>
                    <a href={viewListingLink(s)} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#0b5ed7" }}>
                      View listing
                    </a>
                  </div>
                  <div style={{ marginTop: 6, color: "#666", fontSize: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>Created: {new Date(s.created_at).toLocaleString()}</span>
                    {s.last_extracted_at ? <span>Extracted: {new Date(s.last_extracted_at).toLocaleString()}</span> : null}
                    {s.rightmove_listing_id ? <span>Listing ID: {s.rightmove_listing_id}</span> : null}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ padding: "6px 10px", borderRadius: 999, background: badgeColor(s.status), fontSize: 12 }}>
                    {s.status}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1.35fr 0.65fr", gap: 12 }}>
                {/* LEFT: key info + confirmed facts */}
                <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                      <span><b>Commute</b>: {commute} {statsC?.commute_mode ? `(${statsC.commute_mode})` : ""}</span>
                      <span><b>Station</b>: {station}</span>
                      <span><b>Supermarket</b>: {market}</span>
                      <span><b>Green</b>: {green}</span>
                      <span><b>Safety</b>: {safety}</span>
                    </div>
                    {statsR?.computed_at ? (
                      <div style={{ fontSize: 12, color: "#666" }}>Stats: {new Date(statsR.computed_at).toLocaleString()}</div>
                    ) : null}
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div style={{ background: "#f3fff7", borderRadius: 10, padding: 10, border: conf ? "1px solid #b3ffcc" : "1px solid #eee" }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Confirmed facts</div>
                      <div style={{ fontSize: 13 }}>
                        <div><b>Price</b>: {conf?.price ?? "—"}</div>
                        <div><b>Beds</b>: {conf?.bedrooms ?? "—"} | <b>Baths</b>: {conf?.bathrooms ?? "—"}</div>
                        <div><b>Type</b>: {conf?.property_type ?? "—"} | <b>Tenure</b>: {conf?.tenure ?? "—"}</div>
                        <div><b>Postcode</b>: {conf?.postcode ?? "—"}</div>
                        {conf?.confirmed_at ? <div style={{ marginTop: 6, color: "#666" }}>Confirmed: {new Date(conf.confirmed_at).toLocaleString()}</div> : null}
                      </div>
                    </div>

                    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: 10, border: evalR ? "1px solid #d6d6ff" : "1px solid #eee" }}>
                      {canConfirmFacts ? (
                        <>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>AI (raw)</div>
                          <div style={{ fontSize: 13 }}>
                            <div><b>Price</b>: {raw?.price ?? "—"}</div>
                            <div><b>Beds</b>: {raw?.bedrooms ?? "—"} | <b>Baths</b>: {raw?.bathrooms ?? "—"}</div>
                            <div><b>Type</b>: {raw?.property_type ?? "—"} | <b>Tenure</b>: {raw?.tenure ?? "—"}</div>
                            <div><b>Postcode</b>: {raw?.postcode ?? "—"}</div>
                          </div>
                          <button onClick={() => openConfirm(s)} style={{ marginTop: 10, padding: "8px 12px" }}>
                            Confirm facts
                          </button>
                        </>
                      ) : evalR ? (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>Highlights</div>
                            <button onClick={() => openReport(s)} style={{ padding: "6px 10px", fontSize: 12 }}>
                              View full report
                            </button>
                          </div>

                          <div style={{ fontSize: 13 }}>
                            {(() => {
                              const per = (evalR as any).per_preference || {};
                              const entries = Object.entries(per)
                                .map(([k, v]: any) => ({
                                  key: String(k),
                                  score: typeof v?.score === "number" ? v.score : null,
                                  explanation: typeof v?.explanation === "string" ? v.explanation : "",
                                }))
                                .filter((x) => x.score != null);
                              const worst = [...entries].sort((a, b) => (a.score as number) - (b.score as number)).slice(0, 3);
                              const best = [...entries].sort((a, b) => (b.score as number) - (a.score as number)).slice(0, 2);
                              const fmtKey = (k: string) => k.replace(/_/g, " ");
                              return (
                                <>
                                  {best.length > 0 ? (
                                    <div style={{ marginBottom: 8 }}>
                                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Strong points</div>
                                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                                        {best.map((x) => (
                                          <li key={`best-${x.key}`}>
                                            <b>{fmtKey(x.key)}</b>: {x.score}/10
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ) : null}
                                  {worst.length > 0 ? (
                                    <div style={{ marginBottom: 8 }}>
                                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Concerns</div>
                                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                                        {worst.map((x) => (
                                          <li key={`worst-${x.key}`}>
                                            <b>{fmtKey(x.key)}</b>: {x.score}/10
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ) : null}
                                </>
                              );
                            })()}

                            {(evalR as any).estate_agent_snippet ? (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>Estate agent</div>
                                <div style={{ whiteSpace: "pre-wrap", color: "#333" }}>
                                  {String((evalR as any).estate_agent_snippet)}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>AI (raw)</div>
                          <div style={{ fontSize: 13, color: "#666" }}>
                            No evaluation yet. Run stats and evaluation to see a summary.
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* RIGHT: outcome panel */}
                <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fbfbff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 800 }}>{rightTitle}</div>
                    {s.status === "AI_READY" && evalR ? (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1 }}>
                          {evalR.overall_score != null ? Number(evalR.overall_score).toFixed(1) : "—"}
                        </div>
                        <div style={{ fontSize: 12, color: "#666" }}>
                          {evalR.rank_score != null ? `Rank: ${Math.round(Number(evalR.rank_score))}/100` : ""}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {s.status === "AI_READY" && evalR && eState === "stale" ? (
                    <div style={{ marginTop: 8, padding: 8, borderRadius: 10, background: "#fff3cd", fontSize: 12 }}>
                      Evaluation may be outdated (stats updated after evaluation).
                    </div>
                  ) : null}

                  <div style={{ marginTop: 10, fontSize: 13, color: "#333", whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 6 as any, WebkitBoxOrient: "vertical" as any, overflow: "hidden" }}>
                    {rightBody || "—"}
                  </div>

                  {evalR?.evaluated_at ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>Evaluated: {new Date(evalR.evaluated_at).toLocaleString()}</div>
                  ) : null}

                  {(evalR || statsR || statsC || conf) ? (
                    <button
                      onClick={() => openReport(s)}
                      disabled={isBusy}
                      style={{ marginTop: 10, padding: "10px 12px", width: "100%" }}
                    >
                      View full report
                    </button>
                  ) : null}

                  {rightCTA ? (
                    <button
                      onClick={rightCTA.onClick}
                      disabled={!!rightCTA.disabled || isBusy}
                      style={{ marginTop: 12, padding: "10px 12px", width: "100%" }}
                    >
                      {rightCTA.label}{busyWhat ? "…" : ""}
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Button row */}
              <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={() => runReExtract(s)} disabled={busyWhat === "extract"} style={{ padding: "8px 12px" }}>
                  {busyWhat === "extract" ? "Re-extracting…" : "Re-extract"}
                </button>
                <button
                  onClick={() => runStats(s, true)}
                  disabled={!canStats || busyWhat === "stats"}
                  style={{ padding: "8px 12px" }}
                  title={!canStats ? "Confirm listing facts first" : ""}
                >
                  {busyWhat === "stats" ? "Re-statting…" : "Re-stat"}
                </button>
                <button
                  onClick={() => runEvaluate(s)}
                  disabled={!canEvaluate || busyWhat === "evaluate"}
                  style={{ padding: "8px 12px" }}
                  title={!canEvaluate ? "Stats must be ready" : ""}
                >
                  {busyWhat === "evaluate" ? "Re-evaluating…" : (eState === "stale" ? "Re-evaluate (stale)" : "Re-evaluate")}
                </button>
                {s.status === "STATS_NEEDS_CONFIRMATION" ? (
                  <button onClick={() => openStatsConfirm(s)} style={{ padding: "8px 12px" }}>
                    Review stats
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}

            {cards.length === 0 && <div style={{ color: "#666", padding: 12 }}>No saved properties yet. Add a link above.</div>}
          </section>
        </section>

        {/* RIGHT: ranked list */}
        <aside style={{ border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fbfbff", position: "sticky", top: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Top scores</div>
          {rankedTen.length === 0 ? (
            <div style={{ color: "#666", fontSize: 13 }}>Run evaluation to populate scores.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {rankedTen.map((s) => {
                const ev = getOne(s.listing_evaluation_raw) as any;
                const score = ev?.overall_score != null ? Number(ev.overall_score) : null;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      setActiveId(s.id);
                      const el = document.getElementById(`card-${s.id}`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      textAlign: "left",
                      padding: "10px 10px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      background: activeId === s.id ? "#e7f1ff" : "#fff",
                      fontSize: 13,
                    }}
                    title={titleForSession(s)}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleForSession(s)}</span>
                    <span style={{ fontWeight: 900 }}>{score != null ? score.toFixed(1) : "—"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      {/* Full report modal */}
      {reportOpen && reportSession && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            zIndex: 60,
          }}
          onClick={() => setReportOpen(false)}
        >
          <div
            style={{ width: "min(1100px, 100%)", maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 14, padding: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const s = reportSession;
              const raw = getOne(s.listing_facts_raw);
              const conf = getOne(s.listing_facts_confirmed);
              const statsC = getOne(s.listing_stats_confirmed);
              const statsR = getOne(s.listing_stats_raw);
              const ev = getOne(s.listing_evaluation_raw) as any;
              const title = titleForSession(s);
              const per = ev?.per_preference || {};
              const perEntries = Object.entries(per).map(([k, v]: any) => ({
                key: String(k),
                score: typeof v?.score === "number" ? v.score : null,
                explanation: typeof v?.explanation === "string" ? v.explanation : "",
                weight_note: typeof v?.weight_note === "string" ? v.weight_note : "",
                evidence: Array.isArray(v?.evidence) ? v.evidence : [],
              }));
              const fmtKey = (k: string) => k.replace(/_/g, " ");

              return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ margin: 0 }}>{title}</h2>
                      <div style={{ marginTop: 6, fontSize: 12, color: "#666", wordBreak: "break-all" }}>{s.rightmove_url}</div>
                    </div>
                    <button onClick={() => setReportOpen(false)} style={{ padding: "8px 12px" }}>Close</button>
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Evaluation</div>
                      {ev ? (
                        <>
                          <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                            <div style={{ fontSize: 36, fontWeight: 950, lineHeight: 1 }}>{ev?.overall_score != null ? Number(ev.overall_score).toFixed(1) : "—"}</div>
                            <div style={{ color: "#666" }}>{ev?.rank_score != null ? `Rank ${Math.round(Number(ev.rank_score))}/100` : ""}</div>
                          </div>
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Executive summary</div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{String(ev.executive_summary ?? "—")}</div>
                          </div>
                          {ev.estate_agent_snippet ? (
                            <div style={{ marginTop: 10 }}>
                              <div style={{ fontWeight: 700, marginBottom: 4 }}>Estate agent opinion</div>
                              <div style={{ whiteSpace: "pre-wrap" }}>{String(ev.estate_agent_snippet)}</div>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div style={{ color: "#666" }}>No evaluation yet.</div>
                      )}
                    </div>

                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Stats</div>
                      {statsC || statsR ? (
                        <div style={{ fontSize: 13 }}>
                          <div><b>Commute</b>: {statsC?.commute_total_minutes ?? statsR?.commute_total_minutes ?? "—"}m {statsC?.commute_mode || statsR?.commute_mode ? `(${statsC?.commute_mode || statsR?.commute_mode})` : ""}</div>
                          <div><b>Nearest station</b>: {statsC?.nearest_station_name ?? statsR?.nearest_station_name ?? "—"} ({statsC?.nearest_station_distance_m ?? statsR?.nearest_station_distance_m ?? "—"}m)</div>
                          <div><b>Supermarket</b>: {statsC?.supermarket_name ?? statsR?.supermarket_name ?? "—"} ({statsC?.supermarket_distance_m ?? statsR?.supermarket_distance_m ?? "—"}m)</div>
                          <div><b>Green space</b>: {statsC?.green_space_name ?? statsR?.green_space_name ?? "—"} ({statsC?.green_space_distance_m ?? statsR?.green_space_distance_m ?? "—"}m)</div>
                          <div><b>Safety score</b>: {statsC?.safety_score ?? statsR?.safety_score ?? "—"}/10</div>
                          {statsR?.computed_at ? <div style={{ marginTop: 8, color: "#666" }}>Computed: {new Date(statsR.computed_at).toLocaleString()}</div> : null}
                        </div>
                      ) : (
                        <div style={{ color: "#666" }}>No stats yet.</div>
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: 12, border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 8 }}>Per-preference scores</div>
                    {perEntries.length === 0 ? (
                      <div style={{ color: "#666" }}>No per-preference breakdown yet.</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10 }}>
                        {perEntries
                          .filter((x) => x.score != null)
                          .sort((a, b) => (b.score as number) - (a.score as number))
                          .map((x) => (
                            <div key={x.key} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                                <div style={{ fontWeight: 800, textTransform: "capitalize" }}>{fmtKey(x.key)}</div>
                                <div style={{ fontWeight: 950 }}>{x.score}/10</div>
                              </div>
                              {x.weight_note ? <div style={{ marginTop: 4, color: "#666", fontSize: 12 }}>{x.weight_note}</div> : null}
                              {x.explanation ? <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{x.explanation}</div> : null}
                              {x.evidence?.length ? (
                                <details style={{ marginTop: 8 }}>
                                  <summary style={{ cursor: "pointer", color: "#0b5ed7" }}>Evidence</summary>
                                  <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                                    {x.evidence.map((e: any, i: number) => (
                                      <li key={i} style={{ wordBreak: "break-all" }}>{String(e)}</li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Confirmed listing facts</div>
                      {conf ? (
                        <div style={{ fontSize: 13 }}>
                          <div><b>Price</b>: {conf.price ?? "—"}</div>
                          <div><b>Beds</b>: {conf.bedrooms ?? "—"} | <b>Baths</b>: {conf.bathrooms ?? "—"}</div>
                          <div><b>Type</b>: {conf.property_type ?? "—"} | <b>Tenure</b>: {conf.tenure ?? "—"}</div>
                          <div><b>Postcode</b>: {conf.postcode ?? "—"}</div>
                          {conf.address ? <div><b>Address</b>: {conf.address}</div> : null}
                          {conf.estate_agent ? <div><b>Agent</b>: {conf.estate_agent}</div> : null}
                          {conf.description ? (
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ cursor: "pointer", color: "#0b5ed7" }}>Description</summary>
                              <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{conf.description}</div>
                            </details>
                          ) : null}
                        </div>
                      ) : (
                        <div style={{ color: "#666" }}>Not confirmed yet.</div>
                      )}
                    </div>

                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Warnings & assumptions</div>
                      <div style={{ fontSize: 13 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>Warnings</div>
                        {Array.isArray(ev?.warnings) && ev.warnings.length ? (
                          <ul style={{ margin: 0, paddingLeft: 18 }}>{ev.warnings.map((w: any, i: number) => <li key={i}>{String(w)}</li>)}</ul>
                        ) : (
                          <div style={{ color: "#666" }}>—</div>
                        )}
                        <div style={{ fontWeight: 700, margin: "10px 0 4px" }}>Assumptions</div>
                        {Array.isArray(ev?.assumptions) && ev.assumptions.length ? (
                          <ul style={{ margin: 0, paddingLeft: 18 }}>{ev.assumptions.map((a: any, i: number) => <li key={i}>{String(a)}</li>)}</ul>
                        ) : (
                          <div style={{ color: "#666" }}>—</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: "pointer", fontWeight: 900 }}>Raw objects (debug)</summary>
                    <pre style={{ marginTop: 10, background: "#fafafa", padding: 12, borderRadius: 12, overflow: "auto" }}>
{JSON.stringify({ listing_facts_raw: raw, listing_facts_confirmed: conf, listing_stats_raw: statsR, listing_stats_confirmed: statsC, listing_evaluation_raw: ev }, null, 2)}
                    </pre>
                  </details>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmOpen && confirmSession && confirmFacts && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            zIndex: 50,
          }}
          onClick={() => setConfirmOpen(false)}
        >
          <div
            style={{ width: "min(880px, 100%)", background: "#fff", borderRadius: 14, padding: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0 }}>Confirm listing details</h2>
                <div style={{ marginTop: 6, fontSize: 12, color: "#666", wordBreak: "break-all" }}>
                  {confirmSession.rightmove_url}
                </div>
              </div>
              <button onClick={() => setConfirmOpen(false)} style={{ padding: "8px 12px" }}>
                Close
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <Field label="Price (required)" type="number" value={confirmFacts.price ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, price: v === "" ? null : Number(v) })} />
              <Field label="Bedrooms (required)" type="number" value={confirmFacts.bedrooms ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, bedrooms: v === "" ? null : Number(v) })} />

              <Field label="Bathrooms" type="number" value={confirmFacts.bathrooms ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, bathrooms: v === "" ? null : Number(v) })} />
              <Field label="Lease years remaining" type="number" value={confirmFacts.lease_years_remaining ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, lease_years_remaining: v === "" ? null : Number(v) })} />

              <Field label="Property type (required)" value={confirmFacts.property_type ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, property_type: v })} />
              <Field label="Tenure (required)" value={confirmFacts.tenure ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, tenure: v })} />

              <Field label="Postcode (required)" value={confirmFacts.postcode ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, postcode: v })} />
              <Field label="Address" value={confirmFacts.address ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, address: v })} />

              <Field label="Estate agent" value={confirmFacts.estate_agent ?? ""} onChange={(v) => setConfirmFacts({ ...confirmFacts, estate_agent: v })} />
              <div />
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Description</label>
              <textarea
                style={{ width: "100%", minHeight: 120, padding: 10, marginTop: 6 }}
                value={confirmFacts.description ?? ""}
                onChange={(e) => setConfirmFacts({ ...confirmFacts, description: e.target.value })}
              />
            </div>

            {confirmErr ? <div style={{ marginTop: 10, color: "#b00020" }}>{confirmErr}</div> : null}

            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmOpen(false)} style={{ padding: "10px 14px" }}>
                Cancel
              </button>
              <button onClick={submitConfirm} style={{ padding: "10px 14px" }}>
                Save confirmed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats Confirmation Modal */}
      {statsConfirmOpen && statsConfirmSession && statsDraft && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            zIndex: 50,
          }}
          onClick={() => setStatsConfirmOpen(false)}
        >
          <div
            style={{ width: "min(880px, 100%)", background: "#fff", borderRadius: 14, padding: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0 }}>Review stats</h2>
                <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                  Some required fields were low confidence. Edit if needed, then confirm.
                </div>
              </div>
              <button onClick={() => setStatsConfirmOpen(false)} style={{ padding: "8px 12px" }}>
                Close
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <Field label="Commute total minutes" type="number" value={statsDraft.commute_total_minutes ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, commute_total_minutes: Number(v) })} />
              <Field label="Commute walk minutes" type="number" value={statsDraft.commute_walk_minutes ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, commute_walk_minutes: Number(v) })} />
              <Field label="Commute mode" value={statsDraft.commute_mode ?? ""} onChange={(v) => setStatsDraft({ ...statsDraft, commute_mode: v })} />
              <div />

              <Field label="Nearest station (m)" type="number" value={statsDraft.nearest_station_distance_m ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, nearest_station_distance_m: Number(v) })} />
              <Field label="Nearest station name" value={statsDraft.nearest_station_name ?? ""} onChange={(v) => setStatsDraft({ ...statsDraft, nearest_station_name: v })} />

              <Field label="Supermarket (m)" type="number" value={statsDraft.supermarket_distance_m ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, supermarket_distance_m: Number(v) })} />
              <Field label="Supermarket name" value={statsDraft.supermarket_name ?? ""} onChange={(v) => setStatsDraft({ ...statsDraft, supermarket_name: v })} />

              <Field label="Green space (m)" type="number" value={statsDraft.green_space_distance_m ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, green_space_distance_m: Number(v) })} />
              <Field label="Green space name" value={statsDraft.green_space_name ?? ""} onChange={(v) => setStatsDraft({ ...statsDraft, green_space_name: v })} />

              <Field label="Safety score (0-10)" type="number" value={statsDraft.safety_score ?? 0} onChange={(v) => setStatsDraft({ ...statsDraft, safety_score: Number(v) })} />
              <div />
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Notes (optional)</label>
              <textarea
                style={{ width: "100%", minHeight: 80, padding: 10, marginTop: 6 }}
                value={(statsDraft.notes ?? "") as any}
                onChange={(e) => setStatsDraft({ ...statsDraft, notes: e.target.value })}
              />
            </div>

            {statsConfirmErr ? <div style={{ marginTop: 10, color: "#b00020" }}>{statsConfirmErr}</div> : null}

            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button onClick={() => setStatsConfirmOpen(false)} style={{ padding: "10px 14px" }}>
                Cancel
              </button>
              <button onClick={submitStatsConfirm} style={{ padding: "10px 14px" }}>
                Confirm stats
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Field(props: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</label>
      <input
        type={props.type ?? "text"}
        style={{ width: "100%", padding: 10, marginTop: 6 }}
        value={props.value as any}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}
