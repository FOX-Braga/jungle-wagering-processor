export function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("Page size must be between 1 and 200");
  }
  return limit;
}
