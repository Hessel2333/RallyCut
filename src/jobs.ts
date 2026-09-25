import type { Asset, Job, Preset, Session } from "./types";
export function jobMatchesCurrent(
  job: Job,
  sessions: Session[],
  assets: Asset[],
  preset: Preset,
) {
  const segment = sessions
    .find((s) => s.id === job.session_id)
    ?.matches.find((m) => m.id === job.segment.id);
  return (
    !!segment &&
    JSON.stringify(segment.ranges) === JSON.stringify(job.segment.ranges) &&
    Object.keys(preset).every(
      (k) => preset[k as keyof Preset] === job.preset[k as keyof Preset],
    ) &&
    job.assets.every((old) =>
      assets.some(
        (a) => a.id === old.id && a.sha256 === old.sha256 && a.available,
      ),
    )
  );
}
export function remaining(job: Job) {
  const speed = Number(job.speed.match(/([\d.]+)x/)?.[1]);
  if (job.status !== "exporting" || !speed || job.progress <= 0) return "";
  const seconds =
    ((job.segment.ranges.reduce((n, r) => n + r.end_us - r.start_us, 0) / 1e6) *
      (1 - job.progress)) /
    speed;
  return `预计剩余 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}
