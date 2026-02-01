// lib/supabaseServer.ts
import { createClient } from "@supabase/supabase-js";

export function supabaseAuthClient() {
  // Used only to validate JWT via auth.getUser(token)
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

export function supabaseServiceClient() {
  // Used to read/write DB safely on the server
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
