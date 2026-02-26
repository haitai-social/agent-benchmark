import { NextResponse } from "next/server";
import {
  clearAuthCookies,
  fetchSupabaseUser,
  setAuthCookies
} from "@/lib/supabase-auth-core";

type SessionPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

export async function POST(request: Request) {
  const body = (await request.json()) as SessionPayload;
  const accessToken = (body.access_token ?? "").trim();
  const refreshToken = (body.refresh_token ?? "").trim();
  const expiresIn = Number(body.expires_in ?? 3600);

  if (!accessToken || !refreshToken) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
  }

  const userCheck = await fetchSupabaseUser(accessToken);
  if (!userCheck.ok) {
    if (userCheck.reason === "network_error" || userCheck.reason === "auth_server_error") {
      return NextResponse.json({ ok: false, error: "auth service unavailable" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  await setAuthCookies(response, {
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(expiresIn) ? Math.max(60, Math.floor(expiresIn)) : 3600,
    user: userCheck.user
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
