import Link from "next/link";
import { PAGE_SIZES, type PageSize } from "@/lib/pagination";

function buildHref(basePath: string, query: Record<string, string>, page: number, pageSize: PageSize) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function PaginationControls({
  basePath,
  query,
  total,
  page,
  pageSize,
  position,
  variant = "full"
}: {
  basePath: string;
  query: Record<string, string>;
  total: number;
  page: number;
  pageSize: PageSize;
  position: "top" | "bottom";
  variant?: "compact" | "full";
}) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const prevPage = page > 1 ? page - 1 : 1;
  const nextPage = page < totalPages ? page + 1 : totalPages;
  const isCompact = variant === "compact";

  return (
    <section className={`pagination-row pagination-${position} pagination-${variant}`}>
      <div className="pagination-info">
        {!isCompact ? <span className="muted">{`共 ${total} 条`}</span> : null}
        <span className="muted">{`第 ${page}/${totalPages} 页`}</span>
      </div>
      <div className="pagination-actions">
        {!isCompact ? (
          page > 1 ? (
            <Link href={buildHref(basePath, query, 1, pageSize)} className="text-btn pagination-jump">
              首页
            </Link>
          ) : (
            <span className="text-btn pagination-jump pagination-disabled">首页</span>
          )
        ) : null}
        {page > 1 ? (
          <Link href={buildHref(basePath, query, prevPage, pageSize)} className="ghost-btn">
            上一页
          </Link>
        ) : (
          <span className="ghost-btn pagination-disabled">上一页</span>
        )}
        {page < totalPages ? (
          <Link href={buildHref(basePath, query, nextPage, pageSize)} className="ghost-btn">
            下一页
          </Link>
        ) : (
          <span className="ghost-btn pagination-disabled">下一页</span>
        )}
        {!isCompact ? (
          <>
            {page < totalPages ? (
              <Link href={buildHref(basePath, query, totalPages, pageSize)} className="text-btn pagination-jump">
                末页
              </Link>
            ) : (
              <span className="text-btn pagination-jump pagination-disabled">末页</span>
            )}
            <div className="pagination-size-group">
              {PAGE_SIZES.map((size) => (
                <Link
                  key={size}
                  href={buildHref(basePath, query, 1, size)}
                  className={`text-btn pagination-size ${pageSize === size ? "active" : ""}`}
                >
                  {`${size}/页`}
                </Link>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
