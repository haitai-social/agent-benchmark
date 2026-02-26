"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

type SubmitButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingText?: ReactNode;
};

export function SubmitButton({ children, pendingText = "处理中...", disabled, type, ...rest }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const isDisabled = Boolean(disabled || pending);

  return (
    <button {...rest} type={type ?? "submit"} disabled={isDisabled} aria-disabled={isDisabled} aria-busy={pending}>
      <span className="submit-btn-inner">
        {pending ? <span className="submit-btn-spinner" aria-hidden="true" /> : null}
        <span>{pending ? pendingText : children}</span>
      </span>
    </button>
  );
}
