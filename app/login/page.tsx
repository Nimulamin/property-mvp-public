// app/login/page.tsx
"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [status, setStatus] = useState<string>("");

  async function signIn() {
    setStatus("Signing in...");
    const { error } = await supabaseBrowser.auth.signInWithPassword({ email, password });
    if (error) return setStatus(`Error: ${error.message}`);
    setStatus("Signed in. Redirecting...");
    router.push("/extract");
  }

  async function signUp() {
    setStatus("Signing up...");
    const { error } = await supabaseBrowser.auth.signUp({ email, password });
    if (error) return setStatus(`Error: ${error.message}`);
    setStatus("Signed up. If email confirmation is enabled, confirm your email, then sign in.");
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>HomeFinder Login</h1>
      <p>Use the same email/password as your Supabase Auth user.</p>

      <label>Email</label>
      <input
        style={{ width: "100%", padding: 10, margin: "6px 0 14px" }}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />

      <label>Password</label>
      <input
        style={{ width: "100%", padding: 10, margin: "6px 0 14px" }}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
        type="password"
      />

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={signIn} style={{ padding: "10px 14px" }}>Sign in</button>
        <button onClick={signUp} style={{ padding: "10px 14px" }}>Sign up</button>
      </div>

      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{status}</pre>
    </main>
  );
}
