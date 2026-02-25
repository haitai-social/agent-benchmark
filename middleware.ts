import { NextResponse, type NextRequest } from "next/server";
import { fetchSupabaseUser } from "./lib/supabase-auth";

const PUBLIC_PATH_PREFIXES = ["/_next", "/favicon.ico", "/login", "/auth", "/api"];

function isPublicPath(pathname: string) {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    if (pathname === "/login") {
      const token = request.cookies.get("sb-access-token")?.value ?? "";
      if (token) {
        const user = await fetchSupabaseUser(token);
        if (user) {
          return NextResponse.redirect(new URL("/", request.url));
        }
      }
    }
    return NextResponse.next();
  }

  const token = request.cookies.get("sb-access-token")?.value ?? "";
  if (!token) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  const user = await fetchSupabaseUser(token);
  if (!user) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", `${pathname}${search}`);
    const response = NextResponse.redirect(url);
    response.cookies.delete("sb-access-token");
    response.cookies.delete("sb-refresh-token");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
