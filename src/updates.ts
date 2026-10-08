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

export function updateErrorMessage(error: unknown): string {
  const detail = String(error).toLowerCase();
  if (
    /platform.*(not found|were found)|unsupported.*(os|platform)/.test(detail)
  )
    return "当前发布尚未提供适用于此设备的自动更新包，请稍后重试或前往官方下载页。";
  if (/signature|verification|pubkey|public key/.test(detail))
    return "更新包校验失败，已停止更新。请重试或前往官方下载页下载安装。";
  if (/timeout|timed out/.test(detail))
    return "连接更新服务超时，请稍后重试；使用代理时，请确认代理允许访问 GitHub。";
  if (/network|connect|dns|offline|error sending request/.test(detail))
    return "无法连接更新服务，请检查网络或代理设置后重试。";
  if (/json|deserialize|release.*not found|update endpoint/.test(detail))
    return "更新服务暂时不可用，请稍后重试或前往下载页。";
  return "未能完成更新，请重试或前往官方下载页下载安装。";
}
