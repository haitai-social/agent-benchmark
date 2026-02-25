"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { AuthUser } from "@/lib/supabase-auth";
import { Sidebar } from "./sidebar";

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

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ab.sidebar.collapsed");
      if (saved === "1") setSidebarCollapsed(true);
    } catch {
      // ignore storage read errors
    }
  }, []);

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
      <section key={pathname} className="content-area page-transition">{children}</section>
    </div>
  );
}
