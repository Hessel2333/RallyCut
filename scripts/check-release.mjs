import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const notes = JSON.parse(fs.readFileSync("src/release-notes.json", "utf8"));
const cargo = fs
  .readFileSync("src-tauri/Cargo.toml", "utf8")
  .match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/)[1];
if (![config.version, notes.version, cargo].every((v) => v === pkg.version))
  throw Error("Release versions do not match");
if (!notes.notes.trim()) throw Error("Release notes are required");
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${pkg.version}`
)
  throw Error("Tag must match application version");
console.log(`Release v${pkg.version} is consistent`);
if (process.env.GITHUB_OUTPUT)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${pkg.version}\nnotes<<RALLYCUT_NOTES\n${notes.notes}\nRALLYCUT_NOTES\n`,
  );
