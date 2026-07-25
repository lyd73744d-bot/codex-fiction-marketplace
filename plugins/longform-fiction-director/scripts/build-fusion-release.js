"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const pluginRoot = path.resolve(__dirname, "..");
const packRoot = path.resolve(pluginRoot, "..");
const outRoot = path.join(packRoot, "release");
const version = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
const releaseName = "写小说真的太简单了-融合版-" + version;
const releaseDir = path.join(outRoot, releaseName);

function rimraf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (["node_modules", ".git", "test", "_smoke", "Codex候选"].includes(ent.name)) continue;
    if (ent.name.startsWith("_t_") || ent.name.startsWith("_")) continue;
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// verify first
const verify = spawnSync(process.execPath, [path.join(pluginRoot, "scripts/verify-all.js")], { cwd: pluginRoot, encoding: "utf8" });
process.stdout.write(verify.stdout || "");
process.stderr.write(verify.stderr || "");
if (verify.status) process.exit(verify.status || 1);

rimraf(releaseDir);
fs.mkdirSync(releaseDir, { recursive: true });
copyDir(pluginRoot, path.join(releaseDir, "longform-fiction-director"));
for (const f of ["点我安装.cmd", "安装说明.txt", "使用说明-融合版.md", "需求对照验收.json"]) {
  const from = path.join(packRoot, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(releaseDir, f));
}
// ensure installer version string
let cmd = fs.readFileSync(path.join(releaseDir, "点我安装.cmd"), "utf8");
cmd = cmd.replace(/4\.1\.0-fusion\.\d+/g, version);
fs.writeFileSync(path.join(releaseDir, "点我安装.cmd"), cmd, "utf8");

const zipPath = path.join(outRoot, releaseName + ".zip");
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
const ps = "Compress-Archive -Path '" + releaseDir.replace(/'/g, "''") + "\\*' -DestinationPath '" + zipPath.replace(/'/g, "''") + "' -Force";
const zip = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
if (zip.status) {
  console.error(zip.stdout, zip.stderr);
  process.exit(zip.status || 1);
}
fs.writeFileSync(path.join(outRoot, "LATEST.txt"), releaseDir + "\n" + zipPath + "\n", "utf8");
console.log("releaseDir", releaseDir);
console.log("zip", zipPath, fs.statSync(zipPath).size);
