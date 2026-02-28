export function parseSelectedIds(formData: FormData, fieldName = "selectedIds"): number[] {
  return Array.from(
    new Set(
      formData
        .getAll(fieldName)
        .map((value) => Number(String(value).trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}
