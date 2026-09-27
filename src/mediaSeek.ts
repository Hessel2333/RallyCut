import { useEffect, useRef, useState, type RefObject } from "react";
import type { Asset } from "./types";

export type SeekRequest = {
  id: number;
  sessionId: string;
  assetId: string;
  path: string;
  local: number;
  play: boolean;
};
export function matchesMedia(
  request: SeekRequest,
  sessionId: string,
  assetId: string,
  path: string,
) {
  return (
    request.sessionId === sessionId &&
    request.assetId === assetId &&
    request.path === path
  );
}

export function useMediaSeek(
  video: RefObject<HTMLVideoElement | null>,
  sessionId: string,
  current: Asset | undefined,
  mediaPath: (asset: Asset) => string,
  setPlaying: (playing: boolean) => void,
  setError: (error: string) => void,
) {
  const pending = useRef<SeekRequest | null>(null);
  const requestId = useRef(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const [seekError, setSeekError] = useState("");
  const [switchingSource, setSwitchingSource] = useState(false);
  const beginSeek = (
    local: number,
    play: boolean,
    asset = current,
    path = asset ? mediaPath(asset) : "",
  ) => {
    if (!asset) {
      pending.current = null;
      setSwitchingSource(false);
      return;
    }
    pending.current = {
      id: ++requestId.current,
      sessionId,
      assetId: asset.id,
      path,
      local,
      play,
    };
    setSeekVersion(requestId.current);
    setSeekError("");
    setSwitchingSource(true);
  };
  const validMedia = (v: HTMLVideoElement) =>
    v === video.current &&
    !!pending.current &&
    matchesMedia(
      pending.current,
      v.dataset.sessionId || "",
      v.dataset.assetId || "",
      v.dataset.path || "",
    );
  const failSeek = (message: string) => {
    pending.current = null;
    video.current?.pause();
    setSwitchingSource(false);
    setPlaying(false);
    setSeekError(message);
  };
  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    const timer = window.setTimeout(() => {
      if (pending.current === request)
        failSeek("定位未完成，请重试或生成预览代理。");
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [seekVersion]);
  const finishSeek = (v: HTMLVideoElement) => {
    const target = pending.current;
    if (
      !validMedia(v) ||
      !target ||
      v.dataset.seekRequest !== String(target.id) ||
      v.seeking ||
      v.readyState < 2 ||
      Math.abs(v.currentTime - target.local / 1e6) > 0.15
    )
      return;
    pending.current = null;
    setSwitchingSource(false);
    if (target.play) void v.play().catch((e) => setError(String(e)));
    else {
      v.pause();
      setPlaying(false);
    }
  };

  return {
    pending,
    switchingSource,
    seekError,
    beginSeek,
    validMedia,
    failSeek,
    finishSeek,
  };
}
