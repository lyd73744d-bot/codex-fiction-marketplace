const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const allowedRoots = new Set([
  '.codex-plugin',
  '.mcp.json',
  'package.json',
  'package-lock.json',
  'bin',
  'assets',
  'skills',
  'server',
  'web',
]);
const forbiddenPath = /(^|\/)(?:test|tests|node_modules|session(?:s)?|projects?|data|downloads?|downloaded-books?|credentials?|secrets?)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|.*(?:credential|secret|api[-_]?key|private[-_]?key|cookie).*)(?:$|\/)/i;

function releaseFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  const entry = fs.lstatSync(absolute);

  if (entry.isFile()) {
    return [relative.replaceAll('\\', '/')];
  }
  if (!entry.isDirectory()) {
    return [];
  }

  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    const childRelative = path.join(relative, child.name);
    return releaseFiles(root, childRelative);
  });
}

function isAllowed(file) {
  const [root] = file.split('/');
  return allowedRoots.has(root);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
const configuredFiles = packageJson.files || [];
const missingConfiguredRoots = [...allowedRoots].filter((root) => !configuredFiles.includes(root));
const unexpectedConfiguredRoots = configuredFiles.filter((root) => !allowedRoots.has(root));
const files = configuredFiles.flatMap((root) => releaseFiles(pluginRoot, root));
const violations = files.filter((file) => !isAllowed(file) || forbiddenPath.test(file));

if (missingConfiguredRoots.length > 0 || unexpectedConfiguredRoots.length > 0 || violations.length > 0) {
  const problems = [
    ...missingConfiguredRoots.map((root) => `missing release root: ${root}`),
    ...unexpectedConfiguredRoots.map((root) => `unexpected release root: ${root}`),
    ...violations.map((file) => `forbidden release file: ${file}`),
  ];
  process.stderr.write(`Package content verification failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Package content verification passed (${files.length} files).\n`);
}
