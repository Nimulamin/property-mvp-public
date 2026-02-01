import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Load env vars from .env.local
dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;

if (!email || !password) {
  console.error("Set TEST_EMAIL and TEST_PASSWORD before running.");
  process.exit(1);
}

const supabase = createClient(url, anon);

const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if (error) {
  console.error("Login failed:", error.message);
  process.exit(1);
}

if (!data?.session?.access_token) {
  console.error("No session/token returned. Check Supabase Auth settings (email confirmation, etc).");
  process.exit(1);
}

console.log(data.session.access_token);
