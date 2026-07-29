"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const pluginName = "longform-fiction-director";
const home = process.env.USERPROFILE || os.homedir();
const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");
const pluginPath = path.join(home, "plugins", pluginName);

function ensureMarketplace() {
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  let payload;
  if (fs.existsSync(marketplacePath)) {
    payload = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  } else {
    payload = {
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: []
    };
  }
  if (!payload.interface || typeof payload.interface !== "object") {
    payload.interface = { displayName: "Personal" };
  }
  if (!Array.isArray(payload.plugins)) payload.plugins = [];

  const entry = {
    name: pluginName,
    source: { source: "local", path: "./plugins/" + pluginName },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Productivity"
  };
  const idx = payload.plugins.findIndex((p) => p && p.name === pluginName);
  if (idx >= 0) payload.plugins[idx] = entry;
  else payload.plugins.push(entry);

  fs.writeFileSync(marketplacePath, JSON.stringify(payload, null, 2) + String.fromCharCode(10), "utf8");
  return { marketplacePath, pluginPath, entry, pluginExists: fs.existsSync(pluginPath) };
}

if (require.main === module) {
  const result = ensureMarketplace();
  console.log(JSON.stringify(result, null, 2));
  if (!result.pluginExists) {
    console.error("[warn] plugin path missing:", result.pluginPath);
    process.exitCode = 2;
  }
}

module.exports = { ensureMarketplace };
