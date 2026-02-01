"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { useRouter } from "next/navigation";

type Counters = {
  user_id: string;
  extract_used: number;
  evaluate_used: number;
  video_used: number;
  stats_used: number;
  extract_limit: number;
  evaluate_limit: number;
  video_limit: number;
  stats_limit: number;
  updated_at: string;
  created_at: string;
};

type LedgerRow = {
  id: string;
  action_type: "extract" | "stats" | "evaluate" | "video";
  delta: number;
  reason: "free_grant" | "purchase" | "usage" | "admin_adjustment" | "refund";
  direction: "debit" | "credit" | null;
  amount: number | null;
  note: string | null;
  related_purchase_id: string | null;
  related_session_id: string | null;
  created_at: string;
  action: string | null;
};

type PurchaseRow = {
  id: string;
  extract_credits: number;
  stats_credits: number;
  evaluate_credits: number;
  video_credits: number;
  provider: string | null;
  provider_ref: string | null;
  amount_pence: number | null;
  currency: string | null;
  created_at: string;
};

type AccountResponse = {
  ok: boolean;
  counters: Counters;
  ledger: LedgerRow[];
  purchases: PurchaseRow[];
  billing: {
    plan: string;
    status: string;
    next_renewal: string | null;
    portal_url: string | null;
  };
};

function pct(used: number, limit: number) {
  if (!limit || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function formatMoneyPence(amount_pence: number | null, currency: string | null) {
  if (amount_pence === null || amount_pence === undefined) return "—";
  const c = currency || "GBP";
  const value = amount_pence / 100;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: c }).format(value);
  } catch {
    return `${value.toFixed(2)} ${c}`;
  }
}

export default function AccountPage() {
  const router = useRouter();
  const [data, setData] = useState<AccountResponse | null>(null);
  const [status, setStatus] = useState("Loading…");

  async function getToken() {
    const { data } = await supabaseBrowser.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not logged in");
    return token;
  }

  async function load() {
    setStatus("Loading account…");
    try {
      const token = await getToken();
      const res = await fetch("/api/account", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to load");
      setData(json);
      setStatus("Ready");
    } catch (e: any) {
      setStatus(`Error: ${e?.message || String(e)}`);
    }
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      if (!data.session) router.push("/login");
      else load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usageTiles = useMemo(() => {
    if (!data) return [];
    const c = data.counters;
    return [
      { key: "extract", label: "Extract", used: c.extract_used, limit: c.extract_limit },
      { key: "stats", label: "Stats", used: c.stats_used, limit: c.stats_limit },
      { key: "evaluate", label: "Evaluate", used: c.evaluate_used, limit: c.evaluate_limit },
      { key: "video", label: "Video", used: c.video_used, limit: c.video_limit },
    ] as const;
  }, [data]);

  if (!data) {
    return (
      <main style={{ maxWidth: 1050, margin: "24px auto", fontFamily: "system-ui", padding: "0 12px" }}>
        <h1 style={{ margin: 0 }}>Account</h1>
        <p style={{ color: "#666" }}>{status}</p>
      </main>
    );
  }

  const c = data.counters;

  return (
    <main style={{ maxWidth: 1050, margin: "24px auto", fontFamily: "system-ui", padding: "0 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0 }}>Account</h1>
          <div style={{ color: "#666", marginTop: 6 }}>
            Plan: <b>{data.billing.plan}</b> · Status: <b>{data.billing.status}</b>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => router.push("/properties")} style={{ padding: "10px 14px", borderRadius: 12 }}>
            Back to properties
          </button>
          <button onClick={load} style={{ padding: "10px 14px", borderRadius: 12 }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Usage */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {usageTiles.map((t) => (
          <div key={t.key} style={{ border: "1px solid #e6e6e6", borderRadius: 16, padding: 12, background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>{t.label}</div>
              <div style={{ fontSize: 12, color: "#666" }}>
                {t.used}/{t.limit}
              </div>
            </div>
            <div style={{ marginTop: 10, height: 10, borderRadius: 999, background: "#f1f1f1", overflow: "hidden" }}>
              <div style={{ width: `${pct(t.used, t.limit)}%`, height: "100%", background: "#111" }} />
            </div>
            <div style={{ marginTop: 8, color: "#666", fontSize: 12 }}>{pct(t.used, t.limit)}% used</div>
          </div>
        ))}
      </section>

      {/* Billing (Stripe-ready skeleton) */}
      <section style={{ marginTop: 12, border: "1px solid #e6e6e6", borderRadius: 16, padding: 14, background: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 16 }}>Billing</div>
            <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
              Payments and limit upgrades will plug in here (Stripe).
            </div>
          </div>

          <button
            disabled
            title="Coming soon"
            style={{ padding: "10px 14px", borderRadius: 12, opacity: 0.6, cursor: "not-allowed" }}
          >
            Upgrade plan (soon)
          </button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Info label="Current plan" value={data.billing.plan} />
          <Info label="Billing status" value={data.billing.status} />
          <Info label="Next renewal" value={data.billing.next_renewal ? new Date(data.billing.next_renewal).toLocaleString() : "—"} />
        </div>
      </section>

      {/* Purchases */}
      <section style={{ marginTop: 12, border: "1px solid #e6e6e6", borderRadius: 16, padding: 14, background: "#fff" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Purchase history</div>
        <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
          This is backed by <code>usage_purchases</code>. Stripe webhooks will write into it later.
        </div>

        <div style={{ marginTop: 10 }}>
          {data.purchases.length === 0 ? (
            <div style={{ color: "#666" }}>No purchases yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {data.purchases.map((p) => (
                <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 800 }}>
                      {formatMoneyPence(p.amount_pence, p.currency)}{" "}
                      <span style={{ color: "#666", fontWeight: 600, fontSize: 12 }}>
                        · {new Date(p.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ color: "#666", fontSize: 12 }}>
                      {p.provider ? `${p.provider}` : "—"}
                      {p.provider_ref ? ` · ${p.provider_ref}` : ""}
                    </div>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap", color: "#444", fontSize: 13 }}>
                    <span>Extract +{p.extract_credits}</span>
                    <span>Stats +{p.stats_credits}</span>
                    <span>Evaluate +{p.evaluate_credits}</span>
                    <span>Video +{p.video_credits}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Ledger */}
      <section style={{ marginTop: 12, border: "1px solid #e6e6e6", borderRadius: 16, padding: 14, background: "#fff" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Usage ledger</div>
        <div style={{ color: "#666", fontSize: 13, marginTop: 4 }}>
          Most recent debits/credits. Backed by <code>usage_ledger</code>.
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {data.ledger.length === 0 ? (
            <div style={{ color: "#666" }}>No ledger entries.</div>
          ) : (
            data.ledger.map((r) => (
              <div key={r.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontWeight: 900 }}>
                    {r.direction === "credit" ? "➕" : "➖"} {r.action_type.toUpperCase()}{" "}
                    <span style={{ color: "#666", fontWeight: 700 }}>
                      {r.delta > 0 ? `+${r.delta}` : `${r.delta}`}
                    </span>
                  </div>
                  <div style={{ color: "#666", fontSize: 12 }}>{new Date(r.created_at).toLocaleString()}</div>
                </div>

                <div style={{ marginTop: 6, color: "#444", fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>Reason: <b>{r.reason}</b></span>
                  {r.note ? <span>Note: {r.note}</span> : null}
                  {r.related_session_id ? <span>Session: {r.related_session_id}</span> : null}
                  {r.related_purchase_id ? <span>Purchase: {r.related_purchase_id}</span> : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
        Counters last updated: {new Date(c.updated_at).toLocaleString()}
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
      <div style={{ fontSize: 12, color: "#666", fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontWeight: 900 }}>{value}</div>
    </div>
  );
}
