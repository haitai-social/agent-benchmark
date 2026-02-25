"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DatasetIcon, FlaskIcon, HomeIcon, JudgeIcon, TraceIcon } from "./icons";

const nav = [
  { href: "/", label: "总览", icon: HomeIcon },
  { href: "/datasets", label: "评测集", icon: DatasetIcon },
  { href: "/evaluators", label: "评估器", icon: JudgeIcon },
  { href: "/traces", label: "Trace", icon: TraceIcon },
  { href: "/experiments", label: "实验运行", icon: FlaskIcon }
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-badge">AB</div>
        <div>
          <div className="brand-title">Agent Benchmark</div>
          <div className="brand-sub">Control Platform</div>
        </div>
      </div>

      <nav className="side-nav">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} className={active ? "nav-item active" : "nav-item"}>
              <Icon width={16} height={16} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
