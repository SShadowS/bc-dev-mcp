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
      ranges: [{ start: 10, end: 12 }, { start: 31, end: 32 }],
    }]);
  });

  test("anchors a deleted attribute to the surviving procedure below it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bcmcp-git-delete-"));
    const project = join(repo, "app");
    mkdirSync(project, { recursive: true });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    const file = join(project, "Worker.Codeunit.al");
    writeFileSync(file, [
      "codeunit 50100 Worker",
      "{",
      "    [TryFunction]",
      "    procedure Work()",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    run("add", ".");
    run("commit", "-qm", "base");
    const base = run("rev-parse", "HEAD").toString().trim();
    writeFileSync(file, [
      "codeunit 50100 Worker",
      "{",
      "    procedure Work()",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));

    const changes = await collectGitChanges(project, base);
    expect(changes.files[0]?.ranges.some((range) => range.start <= 3 && range.end >= 3)).toBe(true);
  });

  test("ignores deleted AL files because no current procedure remains", () => {
    expect(parseUnifiedAlDiff([
      "diff --git a/Gone.al b/Gone.al",
      "--- a/Gone.al",
      "+++ /dev/null",
      "@@ -1,8 +0,0 @@",
    ].join("\n"))).toEqual([]);
  });

  test("rejects an unexpected diff prefix instead of silently losing the changed file", () => {
    expect(() => parseUnifiedAlDiff([
      "diff --git c/src/Foo.al w/src/Foo.al",
      "--- c/src/Foo.al",
      "+++ w/src/Foo.al",
      "@@ -1 +1 @@",
    ].join("\n"))).toThrow(/unexpected destination path prefix/);
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
    run("config", "diff.mnemonicPrefix", "true");
    const committed = join(project, "Committed.al");
    const staged = join(project, "Staged.al");
    const unstaged = join(project, "Unstaged.al");
    const upperCaseExtension = join(project, "Upper.AL");
    writeFileSync(committed, "line 1\nline 2\n");
    writeFileSync(staged, "line 1\nline 2\n");
    writeFileSync(unstaged, "line 1\nline 2\n");
    writeFileSync(upperCaseExtension, "line 1\nline 2\n");
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
    writeFileSync(upperCaseExtension, "line 1\nchanged\n");
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
      "Upper.AL",
    ]);
    expect(changes.files.find((file) => file.relativeFile === "New File.al")).toMatchObject({
      untracked: true,
      ranges: [{ start: 1, end: 3 }],
    });
  });

  test("fails closed when Git returns a tracked path outside the scoped project prefix", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bcmcp-git-prefix-"));
    const project = join(repo, "apps", "Main");
    mkdirSync(project, { recursive: true });
    const mergeBase = "a".repeat(40);
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return repo;
      if (args[0] === "merge-base") return mergeBase;
      if (args.includes("diff")) {
        return [
          "diff --git a/apps/Other/Foo.al b/apps/Other/Foo.al",
          "--- a/apps/Other/Foo.al",
          "+++ b/apps/Other/Foo.al",
          "@@ -1 +1 @@",
          "+changed",
        ].join("\n");
      }
      if (args[0] === "ls-files") return "";
      throw new Error(`unexpected Git call: ${args.join(" ")}`);
    };

    const error = await collectGitChanges(project, "main", git).catch((caught) => caught);
    expect(error).toMatchObject({ code: "GIT_ERROR" });
    expect(String(error)).toContain("outside the requested project");
  });
});
