"use client";

import { useState } from "react";

type Props = {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  accept?: string;
  rows?: number;
  hint?: string;
};

export function TextareaWithFileUpload({
  name,
  defaultValue = "",
  placeholder,
  required = false,
  accept = ".txt,.json,.jsonl,.md",
  rows,
  hint
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const [filename, setFilename] = useState("");

  async function onFileChange(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setValue(text);
    setFilename(file.name);
  }

  return (
    <div className="textarea-upload-wrap">
      <textarea
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        required={required}
        rows={rows}
      />
      <div className="textarea-upload-row">
        <label className="ghost-btn file-pick-btn">
          导入文件
          <input
            type="file"
            accept={accept}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0] ?? null;
              void onFileChange(file);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {filename ? <span className="muted">{filename}</span> : null}
      </div>
      {hint ? <div className="muted" style={{ fontSize: 12 }}>{hint}</div> : null}
    </div>
  );
}
