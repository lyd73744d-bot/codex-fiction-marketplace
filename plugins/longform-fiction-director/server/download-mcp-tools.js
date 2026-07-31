"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createManagedDownloadProvider } = require("./managed-download-provider");
const { importSampleBook } = require("./sample-book-service");

function toolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw toolError("INVALID_ARGUMENT", `${name} is required.`);
  }
  return value.trim();
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const definition = Object.freeze({
  name: "fiction_download_book",
  description: "Download a Fanqie book only after the author confirms they own it, it is public domain, or they otherwise have permission. The downloaded text is recorded with source metadata and imported into the current project's sample-book library. This tool never calls a model.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectDir", "authorized"],
    properties: {
      projectDir: { type: "string", maxLength: 1024 },
      title: { type: "string", maxLength: 160 },
      bookId: { type: "string", maxLength: 128 },
      author: { type: "string", maxLength: 160 },
      focus: { type: "string", maxLength: 2000 },
      authorized: { type: "boolean" }
    }
  }
});

function createDownloadMcpTools(options = {}) {
  const provider = options.provider || createManagedDownloadProvider(options.providerOptions || {});

  async function call(name, input = {}) {
    if (name !== definition.name) throw toolError("TOOL_NOT_FOUND", `Unknown downloader tool: ${name}`);
    if (input.authorized !== true) {
      throw toolError("SOURCE_NOT_AUTHORIZED", "Confirm that you own the book, it is public domain, or you otherwise have permission before downloading it.");
    }

    const projectDir = path.resolve(required(input.projectDir, "projectDir"));
    const title = String(input.title || "").trim();
    const bookId = String(input.bookId || "").trim();
    if (!title && !bookId) throw toolError("INVALID_ARGUMENT", "title or bookId is required.");

    const projectStats = await fs.stat(projectDir).catch(() => null);
    if (!projectStats?.isDirectory()) throw toolError("INVALID_ARGUMENT", "projectDir must be an existing directory.");

    const downloaded = await provider.download({
      projectPath: projectDir,
      title,
      bookId,
      author: String(input.author || "").trim(),
      focus: String(input.focus || "").trim(),
      authorized: true
    });
    const relativePath = String(downloaded.relativePath || downloaded.sourceRelativePath || "").replaceAll("\\", "/");
    const segments = relativePath.split("/");
    if (!relativePath.startsWith(".fiction-director/sources/books/")
      || segments.includes("..")
      || path.posix.isAbsolute(relativePath)) {
      throw toolError("DOWNLOAD_RESULT_INVALID", "The downloader returned an unsafe source path.");
    }
    const sourcePath = path.resolve(projectDir, ...segments);
    const imported = await importSampleBook({
      projectDir,
      sourcePath,
      title: downloaded.title || title || bookId
    });

    return result({
      ok: true,
      platform: "fanqie",
      source: downloaded,
      sample: {
        sampleDir: imported.sampleDir,
        relativeDir: imported.relativeDir,
        files: imported.manifest?.files || []
      },
      next: "样书已入库。需要学习时再调用 fiction_sample_book(action=learn)，不会自动把样书写法变成正文限制。"
    });
  }

  async function close() {
    if (typeof provider.stop === "function") await provider.stop();
  }

  return Object.freeze({
    has: (name) => name === definition.name,
    list: () => [{ ...definition }],
    call,
    close
  });
}

module.exports = { createDownloadMcpTools };
