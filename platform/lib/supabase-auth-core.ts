import { NextResponse } from "next/server";

export type AuthUser = {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
};

export type AuthCheckReason =
  | "missing_token"
  | "invalid_token"
  | "expired_token"
  | "network_error"
  | "auth_server_error"
  | "unknown_error";

export type AuthCheckResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: AuthCheckReason; status?: number };

export type RefreshSessionResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: AuthUser | null;
    }
  | {
      ok: false;
      reason: AuthCheckReason;
      status?: number;
    };

type SessionCookiePayload = {
  v: 2;
  uid: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  exp: number;
};

const ACCESS_COOKIE = "sb-access-token";
const REFRESH_COOKIE = "sb-refresh-token";
const PROFILE_COOKIE = "ab-session";
const DEFAULT_PROFILE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const AUTH_TOAST_COOKIE = "ab-auth-toast";
export const AUTH_TOAST_NETWORK = "network";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function getSessionCookieSecret() {
  return process.env.AUTH_SESSION_COOKIE_SECRET ?? process.env.SESSION_COOKIE_SECRET ?? "";
}

function getProfileCookieMaxAge() {
  const raw = Number(process.env.AUTH_SESSION_MAX_AGE_SECONDS ?? DEFAULT_PROFILE_COOKIE_MAX_AGE);
  if (!Number.isFinite(raw)) return DEFAULT_PROFILE_COOKIE_MAX_AGE;
  return Math.max(60, Math.floor(raw));
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4 || 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeAuthUser(payload: {
  id?: string;
  email?: string;
  user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
}): AuthUser | null {
  if (!payload.id) return null;
  return {
    id: payload.id,
    email: payload.email,
    name: payload.user_metadata?.name ?? payload.user_metadata?.full_name,
    avatarUrl: payload.user_metadata?.avatar_url
  };
}

function normalizeRefreshUser(payload: Record<string, unknown> | null | undefined): AuthUser | null {
  if (!payload || typeof payload !== "object") return null;
  const user = payload as {
    id?: string;
    email?: string;
    user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
  };
  return normalizeAuthUser(user);
}

function classifyAuthFailure(status: number, message: string): AuthCheckReason {
  const msg = message.toLowerCase();
  if (status === 401 || status === 403) {
    return msg.includes("expired") ? "expired_token" : "invalid_token";
  }
  if (status >= 500) {
    return "auth_server_error";
  }
  return "unknown_error";
}


async function signData(data: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function buildSignedProfileCookie({
  user,
  expiresIn
}: {
  user: AuthUser;
  expiresIn: number;
}) {
  const secret = getSessionCookieSecret();
  if (!secret) return null;

  const ttl = Number.isFinite(expiresIn) ? Math.max(60, Math.floor(expiresIn)) : 3600;
  const payload: SessionCookiePayload = {
    v: 2,
    uid: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    exp: Math.floor(Date.now() / 1000) + ttl
  };

  const payloadBase64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signData(payloadBase64, secret);
  return `${payloadBase64}.${toBase64Url(signature)}`;
}

export async function parseSignedProfileCookie({
  rawCookie
}: {
  rawCookie: string;
}) {
  const secret = getSessionCookieSecret();
  if (!secret || !rawCookie) return null;

  const parts = rawCookie.split(".");
  if (parts.length !== 2) return null;

  const [payloadBase64, signatureBase64] = parts;
  const expectedSig = await signData(payloadBase64, secret);
  const actualSig = fromBase64Url(signatureBase64);
  if (!constantTimeEqual(expectedSig, actualSig)) return null;

  try {
    const payload = JSON.parse(decoder.decode(fromBase64Url(payloadBase64))) as SessionCookiePayload;
    if (payload.v !== 2 || !payload.uid) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return {
      user: {
        id: payload.uid,
        email: payload.email,
        name: payload.name,
        avatarUrl: payload.avatarUrl
      },
      exp: payload.exp
    };
  } catch {
    return null;
  }
}

export async function fetchSupabaseUser(accessToken: string): Promise<AuthCheckResult> {
  if (!accessToken) {
    return { ok: false, reason: "missing_token" };
  }

  try {
    const response = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: getSupabasePublishableKey(),
        Authorization: `Bearer ${accessToken}`
      },
      cache: "no-store"
    });

    if (!response.ok) {
      const message = await response.text();
      return { ok: false, reason: classifyAuthFailure(response.status, message), status: response.status };
    }

    const payload = (await response.json()) as {
      id?: string;
      email?: string;
      user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
    };
    const user = normalizeAuthUser(payload);
    if (!user) {
      return { ok: false, reason: "unknown_error" };
    }

    return { ok: true, user };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function refreshSupabaseSession(refreshToken: string): Promise<RefreshSessionResult> {
  if (!refreshToken) {
    return { ok: false, reason: "missing_token" };
  }

  try {
    const response = await fetch(`${getSupabaseUrl()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: getSupabasePublishableKey(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: "no-store"
    });

    if (!response.ok) {
      const message = await response.text();
      return { ok: false, reason: classifyAuthFailure(response.status, message), status: response.status };
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: Record<string, unknown>;
    };

    const nextAccessToken = (payload.access_token ?? "").trim();
    const nextRefreshToken = (payload.refresh_token ?? "").trim();
    const nextExpiresIn = Number(payload.expires_in ?? 3600);

    if (!nextAccessToken || !nextRefreshToken) {
      return { ok: false, reason: "unknown_error" };
    }

    return {
      ok: true,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiresIn: Number.isFinite(nextExpiresIn) ? Math.max(60, Math.floor(nextExpiresIn)) : 3600,
      user: normalizeRefreshUser(payload.user)
    };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function setAuthCookies(
  response: NextResponse,
  {
    accessToken,
    refreshToken,
    expiresIn,
    user
  }: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: AuthUser;
  }
) {
  const secure = process.env.NODE_ENV === "production";
  const maxAge = Number.isFinite(expiresIn) ? Math.max(60, Math.floor(expiresIn)) : 3600;

  response.cookies.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge
  });

  response.cookies.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });

  const profileMaxAge = getProfileCookieMaxAge();
  const profileCookie = await buildSignedProfileCookie({ user, expiresIn: profileMaxAge });
  if (profileCookie) {
    response.cookies.set(PROFILE_COOKIE, profileCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: profileMaxAge
    });
  }
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  response.cookies.delete(PROFILE_COOKIE);
}

export function setAuthToast(response: NextResponse, code: string) {
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(AUTH_TOAST_COOKIE, code, {
    httpOnly: false,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 20
  });
}

export function getAuthCookieNames() {
  return {
    access: ACCESS_COOKIE,
    refresh: REFRESH_COOKIE,
    profile: PROFILE_COOKIE
  };
}
