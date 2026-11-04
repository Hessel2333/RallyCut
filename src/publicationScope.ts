import type { Artifact, PublicationDraft } from "./publicationTypes";
import type { Job, Session } from "./types";

export function draftSessionIds(
  draft: PublicationDraft,
  artifacts: Artifact[],
  jobs: Job[],
) {
  if (draft.session_ids?.length) return draft.session_ids;
  return [
    ...new Set(
      draft.parts.flatMap((part) => {
        const source =
          artifacts.find((a) => a.id === part.artifact_id)?.session_id ||
          jobs.find((j) => j.id === part.job_id)?.session_id;
        return source ? [source] : [];
      }),
    ),
  ];
}

export function scopeSessions(key: string, sessions: Session[]) {
  return sessions.filter(
    (s) => key === `session:${s.id}` || key === `date:${s.date}`,
  );
}

export function scopedDrafts(
  key: string,
  sessions: Session[],
  drafts: PublicationDraft[],
  artifacts: Artifact[],
  jobs: Job[],
) {
  const ids = new Set(scopeSessions(key, sessions).map((s) => s.id));
  return drafts
    .filter((d) => {
      const sources = draftSessionIds(d, artifacts, jobs);
      return key === "unassigned"
        ? !sources.some((id) => sessions.some((s) => s.id === id))
        : sources.length > 0 && sources.every((id) => ids.has(id));
    })
    .reverse();
}
