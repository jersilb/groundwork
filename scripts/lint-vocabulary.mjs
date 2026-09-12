#!/usr/bin/env node
// Fails CI if a banned trademark term (docs/vocabulary.md) appears in a
// tracked, non-exempt file. --self-test proves detection works without
// touching the working tree, by exercising scanContent() directly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB_PATH = path.join(REPO_ROOT, "docs", "vocabulary.md");
const IGNORE_PATH = path.join(REPO_ROOT, ".vocabignore");

function loadBannedTerms() {
  const md = readFileSync(VOCAB_PATH, "utf8");
  const terms = [];
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cols = line.split("|").map((c) => c.trim());
    // ['', 'Never use', 'Use instead', 'Why', '']
    const term = cols[1];
    if (!term || term === "Never use" || /^-+$/.test(term)) continue;
    terms.push(term.replace(/`/g, ""));
  }
  return terms;
}

function loadIgnorePaths() {
  try {
    return readFileSync(IGNORE_PATH, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure, filesystem-independent: scans a string for banned terms.
// Returns [{ term, line, excerpt }, ...].
export function scanContent(content, terms) {
  const hits = [];
  const lines = content.split("\n");
  for (const term of terms) {
    const re = new RegExp(escapeRegex(term), "i");
    lines.forEach((lineText, i) => {
      if (re.test(lineText)) {
        hits.push({ term, line: i + 1, excerpt: lineText.trim().slice(0, 120) });
      }
    });
  }
  return hits;
}

function listTrackedFiles() {
  let out;
  try {
    // stdio: capture stderr (don't echo it) so the failure path below owns
    // the whole message; a raw `fatal: not a git repository` line plus a
    // stack trace is what F5 flagged.
    out = execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // No .git (tarball, CI artifact, copied tree) or no git binary: the
    // file set this lint is defined to scan cannot be enumerated. Fail
    // loudly and legibly — never as a raw stack trace — and stay non-zero.
    const cause = String(err.stderr || err.message || err).trim().split("\n")[0];
    console.error("Vocabulary lint: CANNOT RUN — `git ls-files` failed, so tracked files cannot be enumerated.");
    console.error(`  Repo root: ${REPO_ROOT}`);
    console.error(`  Cause: ${cause}`);
    console.error("  This lint must run inside a git checkout (it scans tracked, non-exempt files).");
    process.exit(2);
  }
  return out.split("\n").filter(Boolean);
}

function isExempt(relPath, ignorePaths) {
  return ignorePaths.some((p) => relPath === p || relPath.startsWith(p.replace(/\/$/, "") + "/"));
}

function scanRepo() {
  const terms = loadBannedTerms();
  const ignorePaths = loadIgnorePaths();
  const files = listTrackedFiles();
  const violations = [];

  for (const relPath of files) {
    if (isExempt(relPath, ignorePaths)) continue;
    const abs = path.join(REPO_ROOT, relPath);
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue; // binary or unreadable — skip
    }
    for (const hit of scanContent(content, terms)) {
      violations.push({ file: relPath, ...hit });
    }
  }
  return violations;
}

function runSelfTest() {
  const terms = loadBannedTerms();
  if (terms.length === 0) {
    console.error("SELF-TEST FAIL: no banned terms loaded from docs/vocabulary.md");
    process.exit(1);
  }
  const plantedTerm = terms[0];

  const dirtyContent = `Some doc text.\nWe used the ${plantedTerm} framework here.\nMore text.`;
  const dirtyHits = scanContent(dirtyContent, terms);

  const cleanContent = `Some doc text.\nWe used our own strategic clarity process here.\nMore text.`;
  const cleanHits = scanContent(cleanContent, terms);

  console.log(`Self-test: planted term = "${plantedTerm}"`);

  let ok = true;
  if (dirtyHits.length > 0) {
    console.log(`  PASS: lint correctly flagged the planted term (line ${dirtyHits[0].line}).`);
  } else {
    console.log(`  FAIL: lint did NOT flag the planted term. The lint is broken.`);
    ok = false;
  }
  if (cleanHits.length === 0) {
    console.log(`  PASS: lint correctly left clean text alone (no false positive).`);
  } else {
    console.log(`  FAIL: lint flagged clean text — false positive.`);
    ok = false;
  }

  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  runSelfTest();
} else {
  const violations = scanRepo();
  if (violations.length === 0) {
    console.log("Vocabulary lint: clean. No banned terms found in tracked files.");
    process.exit(0);
  }
  console.error(`Vocabulary lint: FAILED — ${violations.length} violation(s) found.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.term}]  ${v.excerpt}`);
  }
  console.error(`\nSee docs/vocabulary.md for the banned-term list and .vocabignore for exemptions.`);
  process.exit(1);
}
