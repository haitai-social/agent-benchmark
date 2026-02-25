import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type AuthUser = {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
};

function env(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getSupabaseUrl() {
  return env("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabasePublishableKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ?? env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export async function fetchSupabaseUser(accessToken: string): Promise<AuthUser | null> {
  if (!accessToken) return null;

  const response = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: getSupabasePublishableKey(),
      Authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    id?: string;
    email?: string;
    user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
  };
  if (!payload.id) return null;

  return {
    id: payload.id,
    email: payload.email,
    name: payload.user_metadata?.name ?? payload.user_metadata?.full_name,
    avatarUrl: payload.user_metadata?.avatar_url
  };
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("sb-access-token")?.value ?? "";
  return fetchSupabaseUser(token);
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
