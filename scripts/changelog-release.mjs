// npm `version` lifecycle script: runs AFTER package.json is bumped, BEFORE the version commit.
// Promotes the CHANGELOG "## [Unreleased]" section to "## [<new version>] — <today>", leaves a fresh
// empty "## [Unreleased]" on top, and stages the file so the promotion rides in the SAME version
// commit + tag npm creates — making `npm version` (and the one-button release.yml that calls it)
// fully autonomous: bump → changelog → commit → tag, no manual edit.
//
// Never fails a release by design: a missing version, a missing CHANGELOG, or a missing
// "## [Unreleased]" heading each exit 0 without touching git. Staging lives HERE (not as a fragile
// `&& git add` in the npm script) precisely so an absent CHANGELOG can never fail `git add` and abort
// the release. Works in CI (release.yml) and on a manual local `npm version`.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function resolveVersion() {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  } catch {
    return undefined; // never let a package.json read abort the release
  }
}

const version = resolveVersion();
if (!version) {
  console.error('changelog-release: no version (npm_package_version / package.json) — skipping');
  process.exit(0);
}

const file = process.env.CHANGELOG_FILE ?? 'CHANGELOG.md';
const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC — stable regardless of TZ)

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch {
  console.error(`changelog-release: ${file} not found — skipping`);
  process.exit(0);
}

const marker = '## [Unreleased]';
if (!text.includes(marker)) {
  console.error(`changelog-release: "${marker}" not found in ${file} — skipping`);
  process.exit(0);
}

// Keep a fresh empty [Unreleased] on top; the former [Unreleased] body becomes [version] — date.
// Em-dash matches the existing heading style ("## [0.3.22] — 2026-06-22").
text = text.replace(marker, `## [Unreleased]\n\n## [${version}] — ${date}`);
fs.writeFileSync(file, text);
console.error(`changelog-release: promoted [Unreleased] -> [${version}] — ${date} in ${file}`);

// Stage the promotion so it rides in npm's version commit. Reached only AFTER a successful rewrite,
// so we never `git add` a file that does not exist. Skipped when a CHANGELOG_FILE override signals a
// test / dry-run (don't touch the repo index from a test). A git failure here is logged, not thrown:
// a half-staged changelog must not abort the release.
if (!process.env.CHANGELOG_FILE) {
  try {
    execFileSync('git', ['add', file], { stdio: 'pipe' });
  } catch (err) {
    console.error(`changelog-release: git add ${file} failed (${err.message}) — left unstaged`);
  }
}
