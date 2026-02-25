import { NextResponse } from "next/server";
import { fetchSupabaseUser } from "@/lib/supabase-auth";

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

  const user = await fetchSupabaseUser(accessToken);
  if (!user) {
    return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set("sb-access-token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Number.isFinite(expiresIn) ? Math.max(60, expiresIn) : 3600
  });
  response.cookies.set("sb-refresh-token", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("sb-access-token");
  response.cookies.delete("sb-refresh-token");
  return response;
}
