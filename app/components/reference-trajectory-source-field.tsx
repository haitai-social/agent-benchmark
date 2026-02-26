"use client";

import { useMemo, useState } from "react";

type Props = {
  traceIds: string[];
  defaultSource: string;
  defaultManual: string;
};

export function ReferenceTrajectorySourceField({ traceIds, defaultSource, defaultManual }: Props) {
  const [source, setSource] = useState(defaultSource);
  const [manualValue, setManualValue] = useState(defaultManual);
  const options = useMemo(() => {
    const base = traceIds.map((traceId) => ({ label: traceId, value: `trace:${traceId}` }));
    if (defaultSource.startsWith("trace:") && !base.some((option) => option.value === defaultSource)) {
      return [{ label: defaultSource.slice("trace:".length), value: defaultSource }, ...base];
    }
    return base;
  }, [traceIds, defaultSource]);
  const isManual = source === "manual";

  return (
    <div className="field-group">
      <label className="field-head">
        <span className="field-title">reference_trajectory</span>
        <span className="type-pill">JSON</span>
      </label>
      <select name="referenceTrajectorySource" value={source} onChange={(event) => setSource(event.target.value)}>
        <option value="">[None]</option>
        <option value="manual">[Mannually]</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {isManual ? (
        <div className="field-stack-gap">
          <textarea
            name="manualReferenceTrajectory"
            placeholder='例如 [{"role":"assistant","tool":"click"}]'
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
          />
        </div>
      ) : (
        <input type="hidden" name="manualReferenceTrajectory" value={manualValue} />
      )}
    </div>
  );
}
