import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase-auth";
import { AppShell } from "./components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Benchmark Platform",
  description: "Benchmark 管理/运行平台"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="zh-CN">
      <body>
        <AppShell user={user}>{children}</AppShell>
      </body>
    </html>
  );
}
