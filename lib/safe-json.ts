export function parseJsonOrWrap(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return { raw: input };
  }
}

export function parseJsonOrArray(input: string) {
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ raw: input }];
  }
}
