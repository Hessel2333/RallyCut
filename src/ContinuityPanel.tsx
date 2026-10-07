import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";
import { LocalDialog } from "./EditorControls";
import { totalUs } from "./timeline";
export type BoundaryReview = {
  status: string;
  difference: number;
  tail_image: string;
  head_image: string;
  error?: string;
};
const labels: Record<string, string> = {
  similar: "画面接近，可考虑合并",
  interrupted: "疑似中断，建议分开",
  review: "画面有变化，请核对",
  unknown: "无法判断，请核对",
};
export function useContinuity(sessionId: string, assets: Asset[]) {
  const [reviews, setReviews] = useState<Record<string, BoundaryReview>>({});
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify(
    assets.map((a) => [a.id, a.path, a.sha256, a.available]),
  );
  useEffect(() => {
    let active = true;
    setReviews({});
    void (async () => {
      for (let i = 1; i < assets.length; i++) {
        if (!active) break;
        const key = `${assets[i - 1].id}:${assets[i].id}`;
        try {
          const review = await invoke<BoundaryReview>("analyze_boundary", {
            sessionId,
            leftId: assets[i - 1].id,
            rightId: assets[i].id,
          });
          if (active)
            setReviews((old) => ({
              ...old,
              [key]: review ?? {
                status: "unknown",
                difference: 0,
                tail_image: "",
                head_image: "",
              },
            }));
        } catch (e) {
          if (active)
            setReviews((old) => ({
              ...old,
              [key]: {
                status: "unknown",
                difference: 0,
                tail_image: "",
                head_image: "",
                error: String(e),
              },
            }));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionId, identity, revision]);
  return { reviews, retry: () => setRevision((n) => n + 1) };
}
export function ContinuityPanel({
  assets,
  reviews,
  close,
  seek,
  retry,
  proceed,
  pairs,
}: {
  assets: Asset[];
  reviews: Record<string, BoundaryReview>;
  close: () => void;
  seek: (us: number) => void;
  retry: () => void;
  proceed?: () => void;
  pairs?: string[];
}) {
  return (
    <LocalDialog
      title={proceed ? "确认跨文件合并" : "素材衔接检查"}
      close={close}
    >
      <p>
        停录期间的内容无法恢复。首尾画面相似也可能存在间隔，请核对后决定是否合并。
      </p>
      <div className="boundary-reviews">
        {assets.slice(1).map((right, i) => {
          const left = assets[i],
            key = `${left.id}:${right.id}`,
            review = reviews[key];
          if (pairs && !pairs.includes(key)) return null;
          const boundary = totalUs(assets.slice(0, i + 1));
          return (
            <article className="boundary-review" key={key}>
              <strong>
                {review
                  ? (labels[review.status] ?? labels.unknown)
                  : "正在比对首尾画面…"}
              </strong>
              <div className="boundary-images">
                <button
                  onClick={() => {
                    seek(Math.max(0, boundary - 1e6));
                    close();
                  }}
                >
                  {review?.tail_image && (
                    <img src={review.tail_image} alt={`${left.name}末尾画面`} />
                  )}
                  <span>{left.name} · 末尾</span>
                </button>
                <button
                  onClick={() => {
                    seek(boundary);
                    close();
                  }}
                >
                  {review?.head_image && (
                    <img
                      src={review.head_image}
                      alt={`${right.name}开头画面`}
                    />
                  )}
                  <span>{right.name} · 开头</span>
                </button>
              </div>
              {review?.error && <small role="status">{review.error}</small>}
            </article>
          );
        })}
      </div>
      <footer className="editing-actions">
        <button onClick={retry}>重新检查</button>
        <button onClick={close}>{proceed ? "返回调整" : "关闭"}</button>
        {proceed && (
          <button className="primary" onClick={proceed}>
            仍然合并并继续
          </button>
        )}
      </footer>
    </LocalDialog>
  );
}
