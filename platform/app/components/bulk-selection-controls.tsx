"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type BulkSelectionControlsProps = {
  formId: string;
  checkboxName?: string;
  variant?: "compact" | "full";
  confirmText?: string;
  emptyHint?: string;
};

function readCheckboxes(formId: string, checkboxName: string): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${formId}"][name="${checkboxName}"]`));
}

export function BulkSelectionControls({
  formId,
  checkboxName = "selectedIds",
  variant = "full",
  confirmText = "确认批量删除已选数据？",
  emptyHint = "未选择任何数据"
}: BulkSelectionControlsProps) {
  const [selectedCount, setSelectedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const compact = variant === "compact";

  const refresh = useCallback(() => {
    const checkboxes = readCheckboxes(formId, checkboxName);
    setTotalCount(checkboxes.length);
    setSelectedCount(checkboxes.filter((item) => item.checked).length);
  }, [checkboxName, formId]);

  useEffect(() => {
    refresh();
    const listener = () => refresh();
    document.addEventListener("change", listener, true);
    return () => document.removeEventListener("change", listener, true);
  }, [refresh]);

  const allSelected = useMemo(() => totalCount > 0 && selectedCount === totalCount, [selectedCount, totalCount]);

  const handleSelectAll = useCallback(() => {
    const checkboxes = readCheckboxes(formId, checkboxName);
    for (const checkbox of checkboxes) checkbox.checked = true;
    refresh();
  }, [checkboxName, formId, refresh]);

  const handleClear = useCallback(() => {
    const checkboxes = readCheckboxes(formId, checkboxName);
    for (const checkbox of checkboxes) checkbox.checked = false;
    refresh();
  }, [checkboxName, formId, refresh]);

  const handleSubmit = useCallback(() => {
    if (selectedCount <= 0) return;
    if (!window.confirm(confirmText.replace("{count}", String(selectedCount)))) return;
    const form = document.getElementById(formId) as HTMLFormElement | null;
    form?.requestSubmit();
  }, [confirmText, formId, selectedCount]);

  if (selectedCount === 0) {
    return null;
  }

  return (
    <div className={`bulk-toolbar bulk-toolbar-${variant}`}>
      {!compact ? (
        <div className="bulk-actions">
          <button type="button" className="text-btn" onClick={handleSelectAll} disabled={totalCount === 0 || allSelected}>
            全选本页
          </button>
          <button type="button" className="text-btn" onClick={handleClear} disabled={selectedCount === 0}>
            清空选择
          </button>
        </div>
      ) : null}
      <span className="bulk-count">{selectedCount > 0 ? `已选 ${selectedCount} 条` : emptyHint}</span>
      <button
        type="button"
        className={compact ? "ghost-btn bulk-delete-btn bulk-delete-btn-compact" : "danger-btn bulk-delete-btn"}
        onClick={handleSubmit}
        disabled={selectedCount === 0}
      >
        批量删除
      </button>
    </div>
  );
}
