"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DotIcon, GitHubIcon, GoogleIcon, TraceIcon, UserIcon } from "@/app/components/icons";
import { sanitizeNextPath } from "@/lib/safe-redirect";

function parseHash(hashValue: string) {
  const raw = hashValue.startsWith("#") ? hashValue.slice(1) : hashValue;
  const params = new URLSearchParams(raw);
  return {
    access_token: params.get("access_token") ?? "",
    refresh_token: params.get("refresh_token") ?? "",
    expires_in: Number(params.get("expires_in") ?? "3600")
  };
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const safeNext = useMemo(() => {
    return sanitizeNextPath(searchParams.get("next"));
  }, [searchParams]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("正在完成身份校验，请稍候...");

  useEffect(() => {
    const run = async () => {
      const { access_token, refresh_token, expires_in } = parseHash(window.location.hash);
      if (!access_token || !refresh_token) {
        setStatus("error");
        setMessage("登录信息缺失，请返回登录页重新发起登录。");
        return;
      }

      const response = await fetch("/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token, refresh_token, expires_in })
      });

      if (!response.ok) {
        setStatus("error");
        setMessage("系统暂时无法建立会话，请稍后重试。");
        return;
      }

      setStatus("success");
      setMessage("登录成功，正在进入评测平台...");
      router.replace(safeNext);
      router.refresh();
    };

    run().catch(() => {
      setStatus("error");
      setMessage("登录过程发生异常，请返回登录页重试。");
    });
  }, [router, safeNext]);

  return (
    <div className="login-wrap">
      <div className="login-gradient" />
      <section className="callback-card">
        <div className={`callback-status-badge ${status}`}>
          <DotIcon width={14} height={14} />
          {status === "loading" ? "登录处理中" : status === "success" ? "即将进入平台" : "登录未完成"}
        </div>
        <h1>{status === "error" ? "登录没有完成" : "正在进入 Agent Benchmark 平台"}</h1>
        <p>{message}</p>

        <div className="callback-steps">
          <div className={`callback-step ${status !== "error" ? "done" : ""}`}>
            <UserIcon width={15} height={15} />
            身份校验
          </div>
          <div className={`callback-step ${status === "success" ? "done" : ""}`}>
            <TraceIcon width={15} height={15} />
            加载工作空间
          </div>
        </div>

        {status === "error" ? (
          <div className="callback-actions">
            <a href={`/auth/login?provider=github&next=${encodeURIComponent(safeNext)}`} className="oauth-btn oauth-btn-github">
              <GitHubIcon width={16} height={16} />
              GitHub 重试
            </a>
            <a href={`/auth/login?provider=google&next=${encodeURIComponent(safeNext)}`} className="oauth-btn oauth-btn-google">
              <GoogleIcon width={16} height={16} />
              Google 重试
            </a>
            <a href="/login" className="ghost-btn">
              返回登录页
            </a>
          </div>
        ) : (
          <div className="callback-note">首次登录可能需要 1-2 秒完成初始化。</div>
        )}
      </section>
    </div>
  );
}
