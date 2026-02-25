import { NextResponse } from "next/server";
import { getSupabaseUrl } from "@/lib/supabase-auth";
import { sanitizeNextPath } from "@/lib/safe-redirect";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = (url.searchParams.get("provider") ?? "github").trim();
  const safeNext = sanitizeNextPath(url.searchParams.get("next"));

  const callbackUrl = new URL("/auth/v1/callback", url.origin);
  callbackUrl.searchParams.set("next", safeNext);

  const authorizeUrl = new URL(`${getSupabaseUrl()}/auth/v1/authorize`);
  authorizeUrl.searchParams.set("provider", provider);
  authorizeUrl.searchParams.set("redirect_to", callbackUrl.toString());

  return NextResponse.redirect(authorizeUrl);
}
