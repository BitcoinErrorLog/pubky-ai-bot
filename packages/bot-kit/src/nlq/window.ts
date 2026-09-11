export function formatDayWindow(days: number): string {
  const normalized = Math.max(1, Math.round(days));
  return `last ${normalized} day${normalized === 1 ? "" : "s"}`;
}
