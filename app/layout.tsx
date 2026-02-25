import type { Metadata } from "next";
import { Sidebar } from "./components/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Benchmark Platform",
  description: "Benchmark 管理/运行平台"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-shell">
          <Sidebar />
          <section className="content-area">{children}</section>
        </div>
      </body>
    </html>
  );
}
