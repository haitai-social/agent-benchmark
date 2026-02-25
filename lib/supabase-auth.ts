import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  type AuthUser,
  fetchSupabaseUser as fetchSupabaseUserRemote,
  getAuthCookieNames,
  parseSignedProfileCookie
} from "@/lib/supabase-auth-core";

export type { AuthUser };

export { getSupabaseUrl, getSupabasePublishableKey } from "@/lib/supabase-auth-core";

export async function fetchSupabaseUser(accessToken: string): Promise<AuthUser | null> {
  const result = await fetchSupabaseUserRemote(accessToken);
  return result.ok ? result.user : null;
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const { access, profile } = getAuthCookieNames();
  const accessToken = cookieStore.get(access)?.value ?? "";
  if (!accessToken) return null;

  const profileCookie = cookieStore.get(profile)?.value ?? "";
  const parsed = await parseSignedProfileCookie({ rawCookie: profileCookie, accessToken });
  if (parsed) return parsed.user;

  const fallback = await fetchSupabaseUserRemote(accessToken);
  return fallback.ok ? fallback.user : null;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
