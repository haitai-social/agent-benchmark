type ExpandableTextCellProps = {
  value: unknown;
  previewLength?: number;
  className?: string;
  emptyText?: string;
};

function normalizeText(value: unknown): { inlineText: string; expandedText: string } {
  if (value == null) return { inlineText: "", expandedText: "" };
  if (typeof value === "string") return { inlineText: value, expandedText: value };
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    const text = String(value);
    return { inlineText: text, expandedText: text };
  }
  try {
    return {
      inlineText: JSON.stringify(value),
      expandedText: JSON.stringify(value, null, 2)
    };
  } catch {
    const fallback = String(value);
    return { inlineText: fallback, expandedText: fallback };
  }
}

export function ExpandableTextCell({
  value,
  previewLength = 120,
  className = "",
  emptyText = "-"
}: ExpandableTextCellProps) {
  const { inlineText, expandedText } = normalizeText(value);
  const fullText = inlineText.trim();

  if (!fullText) {
    return <span className={className}>{emptyText}</span>;
  }

  const isLong = fullText.length > previewLength;
  const previewText = isLong ? `${fullText.slice(0, previewLength)}...` : fullText;
  const content = isLong ? previewText : fullText;
  const titleText = fullText || expandedText;

  return (
    <span className={className} title={titleText}>
      {content}
    </span>
  );
}
