export const PAGE_SIZES = [10, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export function parsePage(raw: string | undefined) {
  const value = Number(raw ?? "");
  if (!Number.isInteger(value) || value <= 0) {
    return 1;
  }
  return value;
}

export function parsePageSize(raw: string | undefined): PageSize {
  const value = Number(raw ?? "");
  if (PAGE_SIZES.includes(value as PageSize)) {
    return value as PageSize;
  }
  return 10;
}

export function clampPage(page: number, total: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  return Math.min(Math.max(1, page), totalPages);
}

export function getOffset(page: number, pageSize: number) {
  return (page - 1) * pageSize;
}
