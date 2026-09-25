import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function directDownloadManifest(manifest, assets, repository) {
  const result = structuredClone(manifest);
  for (const platform of Object.values(result.platforms)) {
    const asset = assets.find(a => a.url === platform.url || a.browser_download_url === platform.url);
    if (!asset || !asset.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/`)) {
      throw new Error("Update artifact is not a release asset in this repository");
    }
    platform.url = asset.browser_download_url;
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
