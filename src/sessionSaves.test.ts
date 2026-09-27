import { expect, test } from "vitest";
import { SessionSaves } from "./sessionSaves";
import type { Session } from "./types";
const session = (id: string, name: string): Session => ({
  id,
  name,
  date: "",
  asset_ids: [],
  matches: [],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("coalesces pending revisions, retains refresh overlays, isolates errors, and flushes final values", async () => {
  const pending: {
    value: Session;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  const persisted = new Map<string, Session>();
  const saves = new SessionSaves(
    (value) =>
      new Promise<void>((resolve, reject) =>
        pending.push({
          value,
          resolve: () => {
            persisted.set(value.id, value);
            resolve();
          },
          reject,
        }),
      ),
    () => {},
  );
  saves.edit(session("a", "first"));
  await tick();
  saves.edit(session("a", "second"));
  saves.edit(session("a", "final"));
  saves.edit(session("b", "other"));
  await tick();
  const before = saves.checkpoint();
  pending[0].resolve();
  await tick();
  expect(saves.status("a")).toBe("保存中…");
  expect(pending[2].value.name).toBe("final");
  pending[1].reject(Error("disk"));
  await tick();
  expect(saves.status("b")).toBe("保存失败");
  pending[2].resolve();
  await tick();
  expect(saves.merge([session("a", "old")], before)[0].name).toBe("final");
  await expect(saves.flush()).rejects.toThrow("other");
  const flush = saves.flush(true);
  await tick();
  pending[3].resolve();
  await flush;
  expect(persisted.get("a")?.name).toBe("final");
  expect(saves.status("b")).toBe("已保存");
});
test("a failed old revision continues with the latest edit", async () => {
  let reject!: (e: Error) => void;
  const written: string[] = [];
  const saves = new SessionSaves(
    async (v) => {
      written.push(v.name);
      if (written.length === 1) await new Promise((_, r) => (reject = r));
    },
    () => {},
  );
  saves.edit(session("a", "old"));
  await tick();
  saves.edit(session("a", "latest"));
  reject(Error("first failed"));
  await saves.flush();
  expect(written).toEqual(["old", "latest"]);
  expect(saves.status("a")).toBe("已保存");
});
