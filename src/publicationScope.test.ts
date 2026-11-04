import { describe, expect, it } from "vitest";
import {
  draftSessionIds,
  scopedDrafts,
  scopeSessions,
} from "./publicationScope";
import type { Artifact, PublicationDraft } from "./publicationTypes";
import type { Job, Session } from "./types";

const sessions = [
  { id: "morning", date: "2026-09-26" },
  { id: "evening", date: "2026-09-26" },
  { id: "other-day", date: "2026-09-27" },
] as Session[];
const draft = (id: string, sources?: string[]) =>
  ({ id, session_ids: sources, parts: [] }) as unknown as PublicationDraft;

describe("publication scope", () => {
  it("groups records by shooting date and keeps record drafts separate from whole-day drafts", () => {
    const drafts = [
      draft("morning", ["morning"]),
      draft("day", ["morning", "evening"]),
      draft("other", ["other-day"]),
    ];
    expect(scopeSessions("date:2026-09-26", sessions).map((s) => s.id)).toEqual(
      ["morning", "evening"],
    );
    expect(
      scopedDrafts("date:2026-09-26", sessions, drafts, [], []).map(
        (d) => d.id,
      ),
    ).toEqual(["day", "morning"]);
    expect(
      scopedDrafts("session:morning", sessions, drafts, [], []).map(
        (d) => d.id,
      ),
    ).toEqual(["morning"]);
  });

  it("recovers legacy provenance from artifacts and pending export jobs, without relying on titles", () => {
    const legacy = {
      ...draft("old"),
      title: "手动改名",
      parts: [
        { id: "p1", artifact_id: "a", job_id: null, name: "第一场" },
        { id: "p2", artifact_id: null, job_id: "j", name: "第二场" },
      ],
    };
    const artifacts = [{ id: "a", session_id: "morning" }] as Artifact[];
    const jobs = [{ id: "j", session_id: "evening" }] as Job[];
    expect(draftSessionIds(legacy, artifacts, jobs)).toEqual([
      "morning",
      "evening",
    ]);
    expect(
      scopedDrafts("date:2026-09-26", sessions, [legacy], artifacts, jobs),
    ).toEqual([legacy]);
  });

  it("keeps imported and deleted-record drafts reachable under other drafts", () => {
    const drafts = [
      draft("imported"),
      draft("deleted", ["deleted-session"]),
      draft("known", ["morning"]),
    ];
    expect(
      scopedDrafts("unassigned", sessions, drafts, [], []).map((d) => d.id),
    ).toEqual(["deleted", "imported"]);
  });
});
