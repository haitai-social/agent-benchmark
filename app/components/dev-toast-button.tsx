"use client";

import { useEffect, useState } from "react";

export function DevToastButton({ label = "启动实验" }: { label?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), 2000);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <>
      <button type="button" className="primary-btn" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div className="dev-toast-overlay" role="status" aria-live="polite">
          <div className="dev-toast-card">
            <span className="dev-toast-dot" aria-hidden="true" />
            <span>启动能力开发中</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
