export const SEEN_VERSION = "rallycut-seen-version";
export const AUTO_UPDATE = "rallycut-auto-update";

export function shouldShowReleaseNotes(
  previous: string | null,
  current: string,
) {
  return previous !== null && previous !== current;
}

export function downloadPercent(downloaded: number, total?: number) {
  return total && total > 0
    ? Math.min(100, Math.round((downloaded / total) * 100))
    : null;
}
