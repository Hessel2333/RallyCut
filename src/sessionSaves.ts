import type { Session } from "./types";

type Entry = {
  value: Session;
  revision: number;
  acknowledged: number;
  error: string;
  running?: Promise<void>;
};
/** One writer per session. Snapshots contain only acknowledged backend data. */
export class SessionSaves {
  private entries = new Map<string, Entry>();
  constructor(
    private write: (value: Session) => Promise<unknown>,
    private changed: () => void,
  ) {}
  status(id: string) {
    const e = this.entries.get(id);
    return e?.error
      ? "保存失败"
      : e && e.revision !== e.acknowledged
        ? "保存中…"
        : "已保存";
  }
  edit(value: Session) {
    const e = this.entries.get(value.id) ?? {
      value,
      revision: 0,
      acknowledged: 0,
      error: "",
    };
    e.value = structuredClone(value);
    e.revision++;
    e.error = "";
    this.entries.set(value.id, e);
    this.start(e);
    this.changed();
  }
  private start(e: Entry) {
    if (e.running) return;
    e.running = Promise.resolve()
      .then(async () => {
        while (e.acknowledged !== e.revision) {
          const revision = e.revision,
            value = e.value;
          try {
            await this.write(value);
            e.acknowledged = revision;
            e.error = "";
          } catch (error) {
            // A newer revision is a fresh attempt; never report an older failure for it.
            if (revision !== e.revision) continue;
            e.error = String(error);
            break;
          }
          this.changed();
        }
      })
      .finally(() => {
        e.running = undefined;
        this.changed();
      });
  }
  async flush(retry = false) {
    if (retry)
      for (const e of this.entries.values())
        if (e.error) {
          e.error = "";
          this.start(e);
        }
    while ([...this.entries.values()].some((e) => e.running))
      await Promise.all([...this.entries.values()].map((e) => e.running));
    const failed = [...this.entries.values()].find((e) => e.error);
    if (failed) throw Error(`${failed.value.name}：${failed.error}`);
  }
  /** Capture before fetching, so an acknowledgement during the fetch cannot regress edits. */
  checkpoint() {
    return new Map(
      [...this.entries].map(([id, e]) => [
        id,
        e.revision === e.acknowledged ? e.revision : -e.revision,
      ]),
    );
  }
  merge(sessions: Session[], before: Map<string, number>) {
    const result = sessions.map((s) => {
      const e = this.entries.get(s.id);
      return e &&
        (e.revision !== e.acknowledged || before.get(s.id) !== e.revision)
        ? e.value
        : s;
    });
    for (const [id, e] of this.entries)
      if (e.revision !== e.acknowledged && !result.some((s) => s.id === id))
        result.push(e.value);
    return result;
  }
}
