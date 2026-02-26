import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </BaseIcon>
  );
}

export function DatasetIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </BaseIcon>
  );
}

export function JudgeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3v15" />
      <path d="M6 7h12" />
      <path d="m7.5 7-2.8 4.8h5.6L7.5 7Z" />
      <path d="m16.5 7-2.8 4.8h5.6L16.5 7Z" />
      <path d="M8 21h8" />
    </BaseIcon>
  );
}

export function TraceIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 12h4l2-5 4 10 2-5h4" />
      <path d="M4 5h16" />
      <path d="M4 19h16" />
    </BaseIcon>
  );
}

export function FlaskIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M10 3h4" />
      <path d="M10 3v5l-5.5 9a3 3 0 0 0 2.6 4.5h10.8A3 3 0 0 0 20.5 17L15 8V3" />
      <path d="M8.5 14h7" />
    </BaseIcon>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="6" y="7" width="12" height="10" rx="2" />
      <path d="M12 3v3" />
      <circle cx="9.5" cy="12" r="1" />
      <circle cx="14.5" cy="12" r="1" />
      <path d="M10 15h4" />
    </BaseIcon>
  );
}

export function DotIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="2.6" />
    </BaseIcon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </BaseIcon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M20 5v5h-5" />
      <path d="M4 19v-5h5" />
      <path d="M19 10a7 7 0 0 0-12-3" />
      <path d="M5 14a7 7 0 0 0 12 3" />
    </BaseIcon>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </BaseIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </BaseIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m6 9 6 6 6-6" />
    </BaseIcon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </BaseIcon>
  );
}

export function OpenInNewIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M14 5h5v5" />
      <path d="m19 5-8 8" />
      <path d="M19 13v5a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1h5" />
    </BaseIcon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </BaseIcon>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .6a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2c-3.4.7-4.1-1.4-4.1-1.4a3.2 3.2 0 0 0-1.3-1.8c-1.1-.7.1-.7.1-.7a2.5 2.5 0 0 1 1.8 1.2 2.5 2.5 0 0 0 3.4 1 2.5 2.5 0 0 1 .7-1.6c-2.7-.3-5.5-1.4-5.5-6a4.7 4.7 0 0 1 1.2-3.2 4.4 4.4 0 0 1 .1-3.1s1-.3 3.3 1.2a11.2 11.2 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2a4.4 4.4 0 0 1 .1 3.1 4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.9 5.7-5.6 6a2.8 2.8 0 0 1 .8 2.2v3.3c0 .4.2.8.8.6A12 12 0 0 0 12 .6Z" />
    </svg>
  );
}

export function GoogleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path fill="#EA4335" d="M12 10.2v4.3h6c-.2 1.4-1.7 4.2-6 4.2a6.6 6.6 0 0 1 0-13.2c2.5 0 4.2 1 5.1 1.9l3.5-3.4A11.4 11.4 0 0 0 12 1 11 11 0 0 0 1 12a11 11 0 0 0 11 11c6.3 0 10.4-4.4 10.4-10.6 0-.7-.1-1.2-.2-1.7H12Z" />
      <path fill="#34A853" d="M1 12c0 1.8.4 3.5 1.4 5l4.2-3.3a6.5 6.5 0 0 1 0-3.4L2.4 7A11 11 0 0 0 1 12Z" />
      <path fill="#FBBC05" d="M12 23c3 0 5.6-1 7.4-2.8L15.8 17a6.7 6.7 0 0 1-3.8 1.1 6.6 6.6 0 0 1-6.2-4.4L1.5 17A11 11 0 0 0 12 23Z" />
      <path fill="#4285F4" d="M22.4 12.4c0-.8-.1-1.4-.2-2H12v4.3h6c-.3 1.6-1.2 2.9-2.6 3.8l4 3.1c2.3-2.1 3.6-5.2 3.6-9.2Z" />
    </svg>
  );
}
