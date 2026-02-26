"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { AuthUser } from "@/lib/supabase-auth";
import { Sidebar } from "./sidebar";

const AUTH_TOAST_COOKIE = "ab-auth-toast";

function readCookie(name: string) {
  const entries = document.cookie.split(";").map((item) => item.trim());
  for (const entry of entries) {
    if (!entry) continue;
    const [key, ...rest] = entry.split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function AppShell({
  children,
  user
}: {
  children: React.ReactNode;
  user: AuthUser | null;
}) {
  const pathname = usePathname();
  const hideShell = pathname === "/login" || pathname.startsWith("/auth/");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authToast, setAuthToast] = useState("");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ab.sidebar.collapsed");
      if (saved === "1") setSidebarCollapsed(true);
    } catch {
      // ignore storage read errors
    }
  }, []);

  useEffect(() => {
    if (hideShell) return;
    const code = readCookie(AUTH_TOAST_COOKIE);
    if (code === "network") {
      setAuthToast("认证服务网络异常，当前会话已保留，请稍后重试。");
      clearCookie(AUTH_TOAST_COOKIE);
    }
  }, [hideShell, pathname]);

  useEffect(() => {
    if (!authToast) return;
    const timer = window.setTimeout(() => setAuthToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [authToast]);

  const handleToggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem("ab.sidebar.collapsed", next ? "1" : "0");
    } catch {
      // ignore storage write errors
    }
  };

  if (hideShell) {
    return <section className="content-area page-transition" style={{ width: "100%" }}>{children}</section>;
  }

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <Sidebar user={user} collapsed={sidebarCollapsed} onToggle={handleToggleSidebar} />
      <section key={pathname} className="content-area page-transition">
        {authToast ? (
          <div className="inline-toast" role="status" aria-live="polite">
            {authToast}
          </div>
        ) : null}
        {children}
      </section>
    </div>
  );
}
