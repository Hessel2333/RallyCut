import { test } from "node:test";
import assert from "node:assert/strict";
import { directDownloadManifest, addMacUpdate } from "./finalize-update.mjs";
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


test("draft temporary URLs become stable tag URLs before and after publication", () => {
  const temporary = { ...asset, browser_download_url: `https://github.com/${repo}/releases/download/untagged-123/setup.exe` };
  const draft = structuredClone(manifest);
  draft.platforms["windows-x86_64"].url = temporary.browser_download_url;
  const result = directDownloadManifest(draft, [temporary], repo);
  assert.equal(result.platforms["windows-x86_64"].url, asset.browser_download_url);
  assert.equal(result.platforms["windows-x86_64"].signature, "signed-payload");
  assert.deepEqual(directDownloadManifest(draft, [asset], repo), result);
  assert.deepEqual(directDownloadManifest(result, [temporary], repo), result);
});


test("merges a signed Mac archive without losing Windows entries", () => {
  const name = "RallyCut_0.2.0_aarch64.app.tar.gz";
  const mac = { name, browser_download_url: `https://github.com/${repo}/releases/download/untagged-123/${name}` };
  const assets = [asset, mac, { name: `${name}.sig` }];
  const result = addMacUpdate(manifest, assets, repo, "mac-signature\n");
  assert.equal(result.platforms["darwin-aarch64"].signature, "mac-signature");
  assert.equal(result.platforms["darwin-aarch64"].url, `https://github.com/${repo}/releases/download/v0.2.0/${name}`);
  assert.equal(result.platforms["windows-x86_64"].signature, "signed-payload");
  assert.deepEqual(addMacUpdate(result, assets, repo, "mac-signature"), result);
  assert.throws(() => addMacUpdate(manifest, [asset], repo, "mac-signature"));
  assert.throws(() => addMacUpdate(manifest, [asset, mac], repo, "mac-signature"));
  assert.throws(() => addMacUpdate(manifest, assets, repo, "  "));
});
