export function describe(value: string | number | null): string {
  // bug: no narrowing — these calls are type errors on the union.
  return value.toUpperCase() + ":" + value.toFixed(2);
}
