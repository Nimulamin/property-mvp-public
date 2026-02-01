// app/extract/page.tsx
"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { useRouter } from "next/navigation";

type Stage = "auth" | "quota" | "fetch" | "openai" | "full";

export default function ExtractPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("full");
  const [out, setOut] = useState<any>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      if (!data.session) router.push("/login");
    })();
  }, [router]);

  async function logout() {
    await supabaseBrowser.auth.signOut();
    router.push("/login");
  }

  async function run() {
    setStatus("Running...");
    setOut(null);

    const { data } = await supabaseBrowser.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setStatus("Not logged in.");
      router.push("/login");
      return;
    }

    const res = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ rightmove_url: url, stage }),
    });

    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    setOut({ status: res.status, body: json });
    setStatus(res.ok ? "OK" : `Failed (${res.status})`);
  }

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Extract Rightmove Listing</h1>
        <button onClick={logout} style={{ padding: "8px 12px" }}>Logout</button>
      </div>

      <label>Rightmove URL</label>
      <input
        style={{ width: "100%", padding: 10, margin: "6px 0 14px" }}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.rightmove.co.uk/properties/170645465#/?channel=RES_BUY"
      />

      <label>Test stage</label>
      <select
        style={{ width: "100%", padding: 10, margin: "6px 0 14px" }}
        value={stage}
        onChange={(e) => setStage(e.target.value as Stage)}
      >
        <option value="auth">1) auth only</option>
        <option value="quota">2) auth + quota</option>
        <option value="fetch">3) auth + quota + fetch</option>
        <option value="openai">4) auth + quota + fetch + openai (no DB write beyond facts)</option>
        <option value="full">full pipeline (writes sessions + facts)</option>
      </select>

      <button onClick={run} style={{ padding: "10px 14px" }}>
        Run extract
      </button>

      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{status}</pre>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12 }}>
        {out ? JSON.stringify(out, null, 2) : "No output yet."}
      </pre>
    </main>
  );
}
