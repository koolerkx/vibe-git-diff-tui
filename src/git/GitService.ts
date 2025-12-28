import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitChange, GitChangeStatus } from './types.js';

type GitServiceOptions = {
  cwd: string;           // repo 路徑
  gitBin?: string;       // 預設 'git'
};

export class GitService {
  private readonly cwd: string;
  private readonly gitBin: string;

  constructor(opts: GitServiceOptions) {
    this.cwd = opts.cwd;
    this.gitBin = opts.gitBin ?? 'git';
  }

  // 取得所有變更（Raw Data）
  private async getStatusFiles(): Promise<GitChange[]> {
    // -z: NUL 分隔
    // -u: 顯示 untracked files
    const out = await this.runGit(['status', '--porcelain', '-z', '-u']);
    return parsePorcelainZ(out);
  }

  async getUnstagedFiles(): Promise<GitChange[]> {
    const all = await this.getStatusFiles();
    return all.filter(f => {
      // Porcelain 格式：XY PATH
      // X = index status, Y = worktree status
      // Unstaged 的情況：
      // Y = 'M' (modified), 'D' (deleted), '?' (untracked)
      // 注意：如果 X='M' Y='M'，則同時存在 staged 與 unstaged 變更
      const y = f.statusCode[1];
      return y === 'M' || y === 'D' || y === '?' || y === 'A'; // 'A' 出現在 untracked ??
    });
  }

  async getStagedFiles(): Promise<GitChange[]> {
    const all = await this.getStatusFiles();
    return all.filter(f => {
      // Staged 的情況：
      // X = 'M', 'A', 'D', 'R', 'C'
      // 且不能是 '?' (untracked)
      const x = f.statusCode[0];
      return x !== ' ' && x !== '?';
    });
  }

  async getDiff(args: { staged: boolean; path: string; status?: string }): Promise<string> {
    const isUntracked = args.status === '?' || args.status === '??';

    // 針對 Untracked 檔案，使用 --no-index 產生 "New File" 的標準 Diff
    if (!args.staged && isUntracked) {
      try {
        // /dev/null 在 Windows 的 Git Bash/CMD 環境下通常也能被 Git 識別
        // 注意：必須加 --no-index 才能比對非 git 追蹤的路徑
        // git diff 在有差異時會返回 exit code 1，這是正常行為，不是錯誤
        const { stdout, exitCode } = await execa(this.gitBin, [
          'diff',
          '--no-color',
          '--no-index',
          '--',
          '/dev/null',
          args.path
        ], {
          cwd: this.cwd,
          reject: false, // 允許 exit code 1 (有差異時的正常行為)
          stripFinalNewline: false,
        });

        // Exit code 0 (無差異) 或 1 (有差異) 都是正常的
        if (exitCode === 0 || exitCode === 1) {
          return stdout;
        }
        return `(Error: git diff exited with code ${exitCode})`;
      } catch (e) {
        return `(Error generating untracked diff: ${e})`;
      }
    }

    // 一般 Staged / Modified 邏輯
    const base = ['diff', '--no-color'];
    const cmd = args.staged ? [...base, '--cached'] : base;

    // 這裡加上容錯，避免有些詭異狀態下 git diff 報錯
    try {
      return await this.runGit([...cmd, '--', args.path], { stripFinalNewline: false });
    } catch (error) {
      return `(Diff failed: ${error})`;
    }
  }

  private async runGit(
    gitArgs: string[],
    opts?: { stripFinalNewline?: boolean }
  ): Promise<string> {
    const { stdout } = await execa(this.gitBin, gitArgs, {
      cwd: this.cwd,
      reject: true,
      stripFinalNewline: opts?.stripFinalNewline ?? true,
    });
    return stdout;
  }
}

// ---- parser ----

// git status --porcelain -z：以 NUL 分隔每筆，格式為 "XY path"
function parsePorcelainZ(output: string): GitChange[] {
  if (!output) return [];
  const entries = output.split('\0').filter(Boolean);
  const results: GitChange[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 3) continue; // 至少需要 "XY " 或 "XY\0"

    const statusCode = entry.slice(0, 2);
    const path = entry.slice(3); // porcelain 格式: "XY path"

    // 處理 Rename: "R  newpath\0oldpath" 在 -z 模式下會分兩筆 entry 存
    // 但 git status --porcelain -z 的 rename 格式是：
    // R  newpath\0oldpath
    if (statusCode[0] === 'R' || statusCode[1] === 'R') {
      const oldPath = entries[++i]; // 下一筆是 oldPath
      if (oldPath) {
        results.push({
          path,
          statusCode,
          status: 'R',
          oldPath
        });
      }
    } else {
      results.push({
        path,
        statusCode,
        status: statusCode.trim(), // " M" -> "M", "??" -> "??"
      });
    }
  }
  return results;
}

