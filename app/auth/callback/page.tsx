"use client";

import { useEffect } from "react";

export default function LegacyAuthCallbackPage() {
  useEffect(() => {
    const nextUrl = `/auth/v1/callback${window.location.search}${window.location.hash}`;
    window.location.replace(nextUrl);
  }, []);

  return (
    <div className="login-wrap">
      <div className="login-gradient" />
      <section className="callback-card">
        <div className="callback-status-badge loading">正在升级登录入口</div>
        <h1>正在跳转到新版登录回调</h1>
        <p>如果未自动跳转，请返回登录页重新发起登录。</p>
      </section>
    </div>
  );
}
