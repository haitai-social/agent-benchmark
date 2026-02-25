"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AuthUser } from "@/lib/supabase-auth";
import { DatasetIcon, FlaskIcon, HomeIcon, JudgeIcon, TraceIcon } from "./icons";

const nav = [
  { href: "/", label: "总览", icon: HomeIcon },
  { href: "/datasets", label: "评测集", icon: DatasetIcon },
  { href: "/evaluators", label: "评估器", icon: JudgeIcon },
  { href: "/traces", label: "Trace", icon: TraceIcon },
  { href: "/experiments", label: "实验运行", icon: FlaskIcon }
];

function getUserDisplay(user: AuthUser | null) {
  const primary = user?.name?.trim() || user?.email?.trim() || `${user?.id.slice(0, 8)}...`;
  const secondary = user?.email ? `${user.id.slice(0, 8)}...` : "已登录";
  const initials = (user?.name?.slice(0, 1) || user?.email?.slice(0, 1) || user?.id.slice(0, 1) || "U").toUpperCase();
  return { primary, secondary, initials, avatarUrl: user?.avatarUrl };
}

export function Sidebar({
  user,
  collapsed,
  onToggle
}: {
  user: AuthUser | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const profile = getUserDisplay(user);

  return (
    <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <div className="brand">
        <div className="brand-badge">AB</div>
        <div className="brand-copy">
          <div className="brand-title">Agent Benchmark</div>
          <div className="brand-sub">Control Platform</div>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          onClick={onToggle}
        >
          {collapsed ? ">>" : "<<"}
        </button>
      </div>

      <nav className="side-nav">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} className={active ? "nav-item active" : "nav-item"} title={item.label}>
              <Icon width={16} height={16} />
              <span className="nav-item-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="account-stack">
          {collapsed ? (
            <div className="account-chip account-chip-collapsed" title={profile.primary}>
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="profile-avatar profile-avatar-img" src={profile.avatarUrl} alt={profile.primary} />
              ) : (
                <div className="profile-avatar">{profile.initials}</div>
              )}
            </div>
          ) : (
            <div className="account-chip">
              <div className="account-chip-main">
                {profile.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="profile-avatar profile-avatar-img" src={profile.avatarUrl} alt={profile.primary} />
                ) : (
                  <div className="profile-avatar">{profile.initials}</div>
                )}
                <div className="account-text">
                  <div className="profile-primary">{profile.primary}</div>
                  <div className="profile-secondary">{profile.secondary}</div>
                </div>
              </div>
              <a href="/auth/logout" className="logout-inline-in-card">
                退出
              </a>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
