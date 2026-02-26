import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_TOAST_NETWORK,
  clearAuthCookies,
  fetchSupabaseUser,
  getAuthCookieNames,
  parseSignedProfileCookie,
  refreshSupabaseSession,
  setAuthCookies,
  setAuthToast
} from "@/lib/supabase-auth-core";

const PUBLIC_PATH_PREFIXES = ["/_next", "/favicon.ico", "/login", "/auth", "/api"];

function isPublicPath(pathname: string) {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function redirectToLogin(request: NextRequest, pathname: string, search: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

function readJwtExp(accessToken: string) {
  try {
    const payloadPart = accessToken.split(".")[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payloadPart.length % 4 || 4)) % 4);
    const payload = JSON.parse(atob(base64)) as { exp?: number };
    if (!payload.exp || !Number.isFinite(payload.exp)) return null;
    return payload.exp;
  } catch {
    return null;
  }
}

async function attachSessionFromAccessToken(
  response: NextResponse,
  {
    accessToken,
    refreshToken
  }: {
    accessToken: string;
    refreshToken: string;
  }
) {
  const userCheck = await fetchSupabaseUser(accessToken);
  if (!userCheck.ok) return userCheck;

  const exp = readJwtExp(accessToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = exp ? Math.max(60, exp - now) : 3600;

  await setAuthCookies(response, {
    accessToken,
    refreshToken,
    expiresIn,
    user: userCheck.user
  });

  return userCheck;
}

async function tryRefreshSession(
  response: NextResponse,
  {
    refreshToken
  }: {
    refreshToken: string;
  }
) {
  const refreshed = await refreshSupabaseSession(refreshToken);
  if (!refreshed.ok) {
    return refreshed;
  }

  let nextUser = refreshed.user;
  if (!nextUser) {
    const checked = await fetchSupabaseUser(refreshed.accessToken);
    if (!checked.ok) {
      return checked;
    }
    nextUser = checked.user;
  }

  await setAuthCookies(response, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresIn: refreshed.expiresIn,
    user: nextUser
  });

  return { ok: true as const };
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { access, refresh, profile } = getAuthCookieNames();

  const accessToken = request.cookies.get(access)?.value ?? "";
  const refreshToken = request.cookies.get(refresh)?.value ?? "";
  const profileCookie = request.cookies.get(profile)?.value ?? "";

  const parsedProfile = accessToken
    ? await parseSignedProfileCookie({ rawCookie: profileCookie, accessToken })
    : null;

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && parsedProfile?.user) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!accessToken) {
    return redirectToLogin(request, pathname, search);
  }

  const now = Math.floor(Date.now() / 1000);
  if (parsedProfile && parsedProfile.exp - now > 90) {
    return NextResponse.next();
  }

  if (refreshToken && parsedProfile && parsedProfile.exp - now <= 90) {
    const next = NextResponse.next();
    const refreshed = await tryRefreshSession(next, { refreshToken });
    if (refreshed.ok) {
      return next;
    }
    if (refreshed.reason === "network_error" || refreshed.reason === "auth_server_error") {
      setAuthToast(next, AUTH_TOAST_NETWORK);
      return next;
    }
    const denied = redirectToLogin(request, pathname, search);
    clearAuthCookies(denied);
    return denied;
  }

  const next = NextResponse.next();
  const validated = await attachSessionFromAccessToken(next, { accessToken, refreshToken });
  if (validated.ok) {
    return next;
  }

  if (validated.reason === "network_error" || validated.reason === "auth_server_error") {
    setAuthToast(next, AUTH_TOAST_NETWORK);
    return next;
  }

  if (!refreshToken) {
    const denied = redirectToLogin(request, pathname, search);
    clearAuthCookies(denied);
    return denied;
  }

  const refreshed = await tryRefreshSession(next, { refreshToken });
  if (refreshed.ok) {
    return next;
  }

  if (refreshed.reason === "network_error" || refreshed.reason === "auth_server_error") {
    setAuthToast(next, AUTH_TOAST_NETWORK);
    return next;
  }

  const denied = redirectToLogin(request, pathname, search);
  clearAuthCookies(denied);
  return denied;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
