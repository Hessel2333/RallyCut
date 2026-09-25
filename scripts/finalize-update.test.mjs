import { test } from "node:test";
import assert from "node:assert/strict";
import { directDownloadManifest } from "./finalize-update.mjs";
const repo = "Hessel2333/RallyCut";
const asset = { url: `https://api.github.com/repos/${repo}/releases/assets/1`, browser_download_url: `https://github.com/${repo}/releases/download/v0.2.0/setup.exe` };
const manifest = { version: "0.2.0", notes: "更新说明", platforms: { "windows-x86_64": { url: asset.url, signature: "signed-payload" } } };
test("uses public downloads without changing version, notes or signature and is idempotent", () => {
  const result = directDownloadManifest(manifest, [asset], repo);
  assert.equal(result.platforms["windows-x86_64"].url, asset.browser_download_url);
  assert.equal(result.platforms["windows-x86_64"].signature, "signed-payload");
  assert.equal(result.notes, manifest.notes);
  assert.equal(result.version, manifest.version);
  assert.deepEqual(directDownloadManifest(result, [asset], repo), result);
});
test("rejects unknown assets and a different repository", () => {
  assert.throws(() => directDownloadManifest(manifest, [], repo));
  assert.throws(() => directDownloadManifest(manifest, [asset], "someone/else"));
});
