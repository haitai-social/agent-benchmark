"use client";

import { useEffect, useState } from "react";

type RunExperimentButtonProps = {
  experimentId: number;
  label?: string;
  blockedReason?: string | null;
};

type ToastState = {
  type: "success" | "error";
  text: string;
};

export function DevToastButton({ experimentId, label = "启动实验", blockedReason = null }: RunExperimentButtonProps) {
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onRun() {
    if (loading) return;
    if (blockedReason) {
      setToast({
        type: "error",
        text: blockedReason
      });
      return;
    }

    setLoading(true);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12000);
      const response = await fetch(`/api/experiments/${experimentId}/run`, {
        method: "POST",
        signal: controller.signal
      });
      window.clearTimeout(timer);

      let result: { ok?: boolean; error?: string; queueMessageId?: string; runCaseCount?: number } = {};
      try {
        result = (await response.json()) as { ok?: boolean; error?: string; queueMessageId?: string; runCaseCount?: number };
      } catch {
        result = { ok: false, error: `HTTP ${response.status}` };
      }
      if (!response.ok || !result.ok) {
        setToast({
          type: "error",
          text: result.error || "启动失败"
        });
        return;
      }
      if (!result.runCaseCount || result.runCaseCount <= 0 || !result.queueMessageId) {
        setToast({
          type: "error",
          text: "未发送MQ：当前实验的 Dataset 没有可运行的 DataItems"
        });
        return;
      }
      setToast({
        type: "success",
        text: `已入队 ${result.runCaseCount ?? 0} 条，消息 ${result.queueMessageId ?? ""}`
      });
      window.location.reload();
    } catch (error) {
      setToast({
        type: "error",
        text: error instanceof Error && error.name === "AbortError" ? "启动超时，请检查 RabbitMQ 配置" : error instanceof Error ? error.message : "启动失败"
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className="primary-btn" onClick={onRun} disabled={loading}>
        {loading ? "启动中..." : label}
      </button>
      {toast ? (
        <div className="dev-toast-overlay" role="status" aria-live="polite">
          <div className="dev-toast-card">
            <span className={`dev-toast-dot ${toast.type}`} aria-hidden="true" />
            <span>{toast.text}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
