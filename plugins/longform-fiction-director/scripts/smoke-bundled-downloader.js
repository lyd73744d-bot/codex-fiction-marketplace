"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManagedDownloadProvider } = require("../server/managed-download-provider");

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiction-downloader-smoke-"));
  const provider = createManagedDownloadProvider({ dataDir, startupTimeoutMs: 30_000 });
  try {
    const service = await provider.start();
    const items = await service.search(process.env.FICTION_DOWNLOADER_SMOKE_QUERY || "大明");
    if (!items.length) throw new Error("The bundled downloader started, but live Fanqie search returned no books.");
    console.log(`PASS bundled downloader started and live search returned ${items.length} books from ${provider.binaryPath}`);
  } finally {
    await provider.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
