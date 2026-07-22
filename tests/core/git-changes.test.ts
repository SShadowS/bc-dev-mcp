import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitChanges, parseUnifiedAlDiff, validateGitRef } from "../../src/core/git-changes";

describe("Git AL changes", () => {
  test("parses added ranges and anchors pure deletions", () => {
    const parsed = parseUnifiedAlDiff([
      "diff --git a/src/Foo.al b/src/Foo.al",
      "--- a/src/Foo.al",
      "+++ b/src/Foo.al",
      "@@ -10,2 +10,3 @@",
      "+x",
      "@@ -30,2 +31,0 @@",
      "-x",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
    ].join("\n"));
    expect(parsed).toEqual([{
      relativeFile: "src/Foo.al",
      ranges: [{ start: 10, end: 12 }, { start: 30, end: 31 }],
    }]);
  });

  test("ignores deleted AL files because no current procedure remains", () => {
    expect(parseUnifiedAlDiff([
      "diff --git a/Gone.al b/Gone.al",
      "--- a/Gone.al",
      "+++ /dev/null",
      "@@ -1,8 +0,0 @@",
    ].join("\n"))).toEqual([]);
  });

  test("rejects blank and option-shaped refs", () => {
    for (const ref of ["", "   ", "--output=/tmp/x", "main\nother"]) {
      expect(() => validateGitRef(ref)).toThrow(/coverageAgainst/);
    }
    expect(validateGitRef(" origin/main ")).toBe("origin/main");
  });

  test("collects committed, staged, unstaged, untracked, and nested-project AL changes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bcmcp-git-"));
    const project = join(repo, "apps", "Main App");
    mkdirSync(project, { recursive: true });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    const committed = join(project, "Committed.al");
    const staged = join(project, "Staged.al");
    const unstaged = join(project, "Unstaged.al");
    writeFileSync(committed, "line 1\nline 2\n");
    writeFileSync(staged, "line 1\nline 2\n");
    writeFileSync(unstaged, "line 1\nline 2\n");
    writeFileSync(join(repo, "Outside.al"), "outside\n");
    run("add", ".");
    run("commit", "-qm", "base");
    const base = run("rev-parse", "HEAD").toString().trim();

    writeFileSync(committed, "line 1\ncommitted\n");
    run("add", ".");
    run("commit", "-qm", "branch change");
    writeFileSync(staged, "line 1\nstaged\n");
    run("add", "apps/Main App/Staged.al");
    writeFileSync(unstaged, "line 1\nunstaged\n");
    writeFileSync(join(project, "New File.al"), "new\nfile\n");
    run("mv", "apps/Main App/Committed.al", "apps/Main App/Renamed File.al");
    writeFileSync(join(repo, "Outside.al"), "outside changed\n");

    const changes = await collectGitChanges(project, base);
    expect(changes.mergeBase).toBe(base);
    expect(changes.files.map((file) => file.relativeFile)).toEqual([
      "New File.al",
      "Renamed File.al",
      "Staged.al",
      "Unstaged.al",
    ]);
    expect(changes.files.find((file) => file.relativeFile === "New File.al")).toMatchObject({
      untracked: true,
      ranges: [{ start: 1, end: 3 }],
    });
  });
});
