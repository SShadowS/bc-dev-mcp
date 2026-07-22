import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BcDevError } from "./agent-errors";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface ChangedAlFile {
  relativeFile: string;
  ranges: ChangedLineRange[];
  untracked?: boolean;
}

export interface GitChangeSet {
  baseRef: string;
  mergeBase: string;
  head: "workingTree";
  files: ChangedAlFile[];
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

function gitFailure(message: string, details: Record<string, string> = {}, cause?: unknown): BcDevError {
  return new BcDevError("GIT_ERROR", message, "configuration", false, details, cause === undefined ? undefined : { cause });
}

export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const suffix = stderr === "" ? "" : `: ${stderr}`;
    throw gitFailure(`Git command failed${suffix}`, {}, error);
  }
};

export function validateGitRef(baseRef: string): string {
  const trimmed = baseRef.trim();
  if (trimmed === "" || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    throw new BcDevError(
      "INVALID_ARGUMENT",
      "coverageAgainst must be a nonblank Git ref and must not begin with '-'",
      "validation",
    );
  }
  return trimmed;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function parseDiffPath(line: string): string | null {
  // `git diff` separates the path from its (usually empty) timestamp with a tab. The caller
  // forces a/b prefixes; fail closed if configuration or a future Git version violates that.
  const value = line.slice(4).split("\t", 1)[0]!;
  if (value === "/dev/null") return null;
  if (!value.startsWith("b/")) {
    throw gitFailure("Git diff returned an unexpected destination path prefix", { path: value });
  }
  return value.slice(2);
}

function mergeRanges(ranges: ChangedLineRange[]): ChangedLineRange[] {
  const sorted = ranges
    .filter((range) => range.start > 0 && range.end >= range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ChangedLineRange[] = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (previous && current.start <= previous.end + 1) previous.end = Math.max(previous.end, current.end);
    else merged.push({ ...current });
  }
  return merged;
}

export function parseUnifiedAlDiff(diff: string): ChangedAlFile[] {
  const byFile = new Map<string, ChangedLineRange[]>();
  let currentFile: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      currentFile = parseDiffPath(line);
      if (currentFile && !currentFile.toLowerCase().endsWith(".al")) currentFile = null;
      if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, []);
      continue;
    }
    if (!currentFile || !line.startsWith("@@ ")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const newStart = Number(match[1]);
    const newCount = match[2] === undefined ? 1 : Number(match[2]);
    // A deletion has no new-side lines. Anchor both sides of the deletion so a surviving
    // procedure still intersects when code was removed immediately before its `end;`.
    const range = newCount === 0
      ? { start: Math.max(1, newStart - 1), end: Math.max(1, newStart) }
      : { start: newStart, end: newStart + newCount - 1 };
    byFile.get(currentFile)!.push(range);
  }
  return [...byFile.entries()]
    .map(([relativeFile, ranges]) => ({ relativeFile, ranges: mergeRanges(ranges) }))
    .filter((entry) => entry.ranges.length > 0)
    .sort((a, b) => a.relativeFile.localeCompare(b.relativeFile));
}

function projectPrefix(repoRoot: string, project: string): string {
  const rel = normalizeRelativePath(relative(repoRoot, project));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw gitFailure("The AL project directory is outside its Git repository root", { project });
  }
  return rel;
}

function stripProjectPrefix(path: string, prefix: string): string | null {
  const normalized = normalizeRelativePath(path);
  if (prefix === "") return normalized;
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : null;
}

async function untrackedFile(relativeFile: string, project: string): Promise<ChangedAlFile> {
  const source = await readFile(resolve(project, relativeFile), "utf8");
  const lineCount = Math.max(1, source.split(/\r?\n/).length);
  return { relativeFile, ranges: [{ start: 1, end: lineCount }], untracked: true };
}

export async function collectGitChanges(
  projectDir: string,
  baseRefInput: string,
  git: GitRunner = runGit,
): Promise<GitChangeSet> {
  const project = resolve(projectDir);
  const baseRef = validateGitRef(baseRefInput);
  let repoRoot: string;
  try {
    repoRoot = resolve((await git(project, ["rev-parse", "--show-toplevel"])).trim());
  } catch (error) {
    if (error instanceof BcDevError) throw error;
    throw gitFailure("The AL project is not inside a readable Git repository", { project }, error);
  }
  const prefix = projectPrefix(repoRoot, project);
  let mergeBase: string;
  try {
    mergeBase = (await git(project, ["merge-base", baseRef, "HEAD"])).trim();
  } catch (error) {
    if (error instanceof BcDevError) throw error;
    throw gitFailure(`Unable to resolve a merge base for '${baseRef}' and HEAD`, { baseRef }, error);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
    throw gitFailure(`Git returned an invalid merge base for '${baseRef}'`, { baseRef });
  }

  let rawDiff: string;
  let rawUntracked: string;
  try {
    const alPathspec = prefix === "" ? ":(glob)**/*.al" : `:(glob)${prefix}/**/*.al`;
    [rawDiff, rawUntracked] = await Promise.all([
      git(repoRoot, [
        "-c", "core.quotePath=false",
        "diff", "--unified=0", "--no-ext-diff", "--no-color", "--no-renames",
        "--src-prefix=a/", "--dst-prefix=b/",
        mergeBase, "--", alPathspec,
      ]),
      git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", alPathspec]),
    ]);
  } catch (error) {
    if (error instanceof BcDevError) throw error;
    throw gitFailure(`Unable to read AL changes against '${baseRef}'`, { baseRef }, error);
  }

  const tracked = parseUnifiedAlDiff(rawDiff)
    .map((entry) => {
      const relativeFile = stripProjectPrefix(entry.relativeFile, prefix);
      return relativeFile === null ? null : { ...entry, relativeFile };
    })
    .filter((entry): entry is ChangedAlFile => entry !== null);
  const known = new Set(tracked.map((entry) => entry.relativeFile));
  const untrackedPaths = rawUntracked
    .split("\0")
    .filter((path) => path !== "" && path.toLowerCase().endsWith(".al"))
    .map((path) => stripProjectPrefix(path, prefix))
    .filter((path): path is string => path !== null && !known.has(path));
  let untracked: ChangedAlFile[];
  try {
    untracked = await Promise.all(untrackedPaths.map((path) => untrackedFile(path, project)));
  } catch (error) {
    throw gitFailure("Unable to read untracked AL files from the working tree", { project }, error);
  }

  return {
    baseRef,
    mergeBase,
    head: "workingTree",
    files: [...tracked, ...untracked].sort((a, b) => a.relativeFile.localeCompare(b.relativeFile)),
  };
}
