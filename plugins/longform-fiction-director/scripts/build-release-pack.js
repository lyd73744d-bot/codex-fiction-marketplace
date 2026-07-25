const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const src = path.resolve("插件源码");
const releaseParent = path.resolve("发布包");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const releaseDir = path.join(releaseParent, "longform-fiction-director-marketplace-" + stamp);
const zipPath = path.join(releaseParent, "longform-fiction-director-marketplace.zip");
const include = [".codex-plugin", ".mcp.json", "package.json", "package-lock.json", "bin", "skills", "server", "web", "LICENSE"];
if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
for (const item of include) {
  const from = path.join(src, item);
  if (!fs.existsSync(from)) {
    if (item === "LICENSE") continue;
    throw new Error("missing " + item);
  }
  const to = path.join(releaseDir, item);
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.cpSync(from, to, {
      recursive: true,
      filter: (s) => !["node_modules", "test", ".git"].includes(path.basename(s))
    });
  } else {
    fs.copyFileSync(from, to);
  }
}
fs.writeFileSync(path.join(releaseParent, "LATEST_RELEASE_ROOT.txt"), releaseDir + "\n");
if (fs.existsSync(zipPath)) {
  try { fs.renameSync(zipPath, zipPath + ".bak-" + stamp); } catch {}
}
const ps = "Compress-Archive -Path '" + releaseDir.replace(/'/g, "''") + "\\*' -DestinationPath '" + zipPath.replace(/'/g, "''") + "' -Force";
const zip = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
if (zip.status) {
  console.error(zip.stdout, zip.stderr);
  process.exit(zip.status || 1);
}
const v = spawnSync(process.execPath, ["scripts/verify-package-content.js"], { cwd: src, encoding: "utf8" });
console.log(v.stdout || "");
if (v.status) process.exit(v.status);
console.log("zip", fs.statSync(zipPath).size);
console.log("release", releaseDir);
