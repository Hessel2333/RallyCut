import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function directDownloadManifest(manifest, assets, repository) {
  const result = structuredClone(manifest);
  const prefix = `https://github.com/${repository}/releases/download/`;
  const tag = `v${manifest.version.replace(/^v/, "")}`;
  const canonical = (asset) => {
    if (!asset.browser_download_url.startsWith(prefix)) return null;
    const name = asset.name ?? decodeURIComponent(new URL(asset.browser_download_url).pathname.split("/").at(-1));
    return `${prefix}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  };
  const normalizeDraft = (url) => {
    if (!url.startsWith(prefix)) return url;
    const parts = url.slice(prefix.length).split("/");
    return parts.length === 2 && parts[0].startsWith("untagged-")
      ? `${prefix}${encodeURIComponent(tag)}/${parts[1]}` : url;
  };
  for (const platform of Object.values(result.platforms)) {
    const asset = assets.find(a => a.url === platform.url || a.browser_download_url === platform.url || canonical(a) === normalizeDraft(platform.url));
    if (!asset || !canonical(asset)) {
      throw new Error("Update artifact is not a release asset in this repository");
    }
    // Draft browser_download_url can contain an ephemeral untagged-* ref.
    // Publish the stable version URL, retaining the asset's exact signature.
    platform.url = canonical(asset);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  const id = process.env.RELEASE_ID;
  if (!repo || !id) throw new Error("GITHUB_REPOSITORY and RELEASE_ID are required");
  const gh = process.env.GH_BIN || "gh";
  const release = JSON.parse(execFileSync(gh, ["api", `repos/${repo}/releases/${id}`], { encoding: "utf8" }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rallycut-manifest-"));
  const file = path.join(directory, "latest.json");
  execFileSync(gh, ["release", "download", release.tag_name, "--repo", repo, "--pattern", "latest.json", "--dir", directory]);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(directDownloadManifest(manifest, release.assets, repo), null, 2));
  execFileSync(gh, ["release", "upload", release.tag_name, file, "--repo", repo, "--clobber"]);
  console.log("Public updater download URLs verified and uploaded");
}
