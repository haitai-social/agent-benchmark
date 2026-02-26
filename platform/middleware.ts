import { NextResponse, type NextRequest } from "next/server";
import { clearAuthCookies, getAuthCookieNames, parseSignedProfileCookie } from "@/lib/supabase-auth-core";

const PUBLIC_PATH_PREFIXES = ["/_next", "/favicon.ico", "/login", "/auth", "/api"];

function isPublicPath(pathname: string) {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function redirectToLogin(request: NextRequest, pathname: string, search: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { profile } = getAuthCookieNames();
  const profileCookie = request.cookies.get(profile)?.value ?? "";
  const parsedProfile = await parseSignedProfileCookie({ rawCookie: profileCookie });

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && parsedProfile?.user) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (parsedProfile?.user) {
    return NextResponse.next();
  }

  const denied = redirectToLogin(request, pathname, search);
  clearAuthCookies(denied);
  return denied;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
