import type { ReactNode } from "react";

type FormFieldProps = {
  title: string;
  typeLabel: string;
  required?: boolean;
  children: ReactNode;
};

export function FormField({ title, typeLabel, required = false, children }: FormFieldProps) {
  return (
    <div className="field-group">
      <label className="field-head">
        <span className={required ? "field-title required" : "field-title"}>{title}</span>
        <span className="type-pill">{typeLabel}</span>
      </label>
      {children}
    </div>
  );
}
