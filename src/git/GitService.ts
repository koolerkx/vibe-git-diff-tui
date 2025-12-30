import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitChange, GitChangeStatus, CommitItem } from './types.js';

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

  /**
   * 獲取所有 Git 追蹤的檔案
   */
  async getAllTrackedFiles(): Promise<string[]> {
    try {
      const result = await this.runGit(['ls-files']);
      return result
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .sort(); // 排序方便處理
    } catch (error) {
      throw new Error(`Failed to get tracked files: ${error}`);
    }
  }

  /**
   * 獲取所有檔案（包括 untracked），但排除 .gitignore 的檔案
   */
  async getAllFiles(): Promise<string[]> {
    try {
      // 獲取所有追蹤的檔案
      const tracked = await this.runGit(['ls-files']);
      
      // 獲取所有未追蹤的檔案（排除 gitignore）
      const untracked = await this.runGit(['ls-files', '--others', '--exclude-standard']);
      
      const allFiles = [
        ...tracked.trim().split('\n').filter(line => line.length > 0),
        ...untracked.trim().split('\n').filter(line => line.length > 0)
      ];
      
      // 去重並排序
      return Array.from(new Set(allFiles)).sort();
    } catch (error) {
      throw new Error(`Failed to get all files: ${error}`);
    }
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
    opts?: { stripFinalNewline?: boolean; reject?: boolean }
  ): Promise<string> {
    const { stdout } = await execa(this.gitBin, gitArgs, {
      cwd: this.cwd,
      reject: opts?.reject ?? true,
      stripFinalNewline: opts?.stripFinalNewline ?? true,
    });
    return stdout;
  }

  /**
   * 獲取 commit 歷史列表
   * @param limit 限制返回的 commit 數量(預設 50)
   */
  async getCommitHistory(limit: number = 50): Promise<CommitItem[]> {
    try {
      const output = await this.runGit([
        'log',
        `--max-count=${limit}`,
        '--pretty=format:%h|%an|%s|%ad',
        '--date=short'
      ]);
      
      if (!output.trim()) return [];
      
      const lines = output.trim().split('\n');
      return lines.map(line => {
        const [hash, author, message, date] = line.split('|');
        return {
          hash: hash || '',
          author: author || '',
          message: message || '',
          date: date || ''
        };
      });
    } catch (error) {
      console.error('Failed to get commit history:', error);
      return [];
    }
  }

  /**
   * 獲取單個 commit 的 diff
   * @param hash commit hash
   */
  async getCommitDiff(hash: string): Promise<string> {
    try {
      const output = await this.runGit([
        'show',
        '--no-color',
        hash
      ], { reject: false, stripFinalNewline: false });
      return output;
    } catch (error) {
      return `Error: Failed to get diff for commit ${hash}`;
    }
  }

  /**
   * 匯出單個 commit 的 diff
   */
  async exportCommitDiff(options: {
    hash: string;
    message: string;
    outputPath: string;
  }): Promise<void> {
    const { hash, message, outputPath } = options;
    
    const diff = await this.getCommitDiff(hash);
    
    const header = [
      '===================================================================',
      `Commit: ${hash} - ${message}`,
      '===================================================================',
      ''
    ].join('\n');
    
    const content = header + diff;
    
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, content, 'utf-8');
  }

  /**
   * 匯出多個 commit 的 diff(合併到單一檔案)
   */
  async exportMultipleCommits(options: {
    commits: Array<{ hash: string; message: string }>;
    outputPath: string;
  }): Promise<void> {
    const { commits, outputPath } = options;
    
    if (commits.length === 0) {
      await fs.writeFile(outputPath, '', 'utf-8');
      return;
    }
    
    let combinedContent = '';
    
    for (const commit of commits) {
      const diff = await this.getCommitDiff(commit.hash);
      const header = [
        '===================================================================',
        `Commit: ${commit.hash} - ${commit.message}`,
        '===================================================================',
        ''
      ].join('\n');
      
      combinedContent += header + diff + '\n\n';
    }
    
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, combinedContent, 'utf-8');
  }

  // 匯出單一檔案 diff
  async exportDiff(options: {
    path: string;
    staged: boolean;
    outputPath: string;
    status?: string;
  }): Promise<void> {
    const { path, staged, outputPath, status } = options;
    
    const isUntracked = status === '??' || status === '?';
    
    let diffContent: string;
    
    if (!staged && isUntracked) {
      // 處理 Untracked 檔案
      try {
        // 使用 /dev/null 或 NUL (Windows)
        const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const { stdout, exitCode } = await execa(this.gitBin, [
          'diff',
          '--no-color',
          '--no-index',
          '--',
          nullPath,
          path
        ], {
          cwd: this.cwd,
          reject: false,
          stripFinalNewline: false,
        });
        
        // Exit code 0 (無差異) 或 1 (有差異) 都是正常的
        if (exitCode === 0 || exitCode === 1) {
          diffContent = stdout;
        } else {
          throw new Error(`git diff exited with code ${exitCode}`);
        }
      } catch (e) {
        throw new Error(`Error generating untracked diff: ${e}`);
      }
    } else {
      // 一般 Staged / Modified 邏輯
      const args = ['diff', '--no-color'];
      if (staged) {
        args.push('--cached');
      }
      args.push('--', path);
      
      try {
        diffContent = await this.runGit(args, { stripFinalNewline: false });
      } catch (error) {
        throw new Error(`Diff failed: ${error}`);
      }
    }
    
    // 寫入檔案
    await fs.writeFile(outputPath, diffContent, 'utf8');
  }

  // 匯出多檔合併 diff
  async exportMultipleDiffs(options: {
    paths: Array<{ path: string; staged: boolean; status?: string }>;
    outputPath: string;
  }): Promise<void> {
    const { paths, outputPath } = options;
    
    if (paths.length === 0) {
      // 如果沒有檔案，建立空檔案
      await fs.writeFile(outputPath, '', 'utf8');
      return;
    }
    
    // 更智能的分組處理：先分離 tracked 和 untracked
    const untrackedPaths = paths.filter(p => p.status === '??' || p.status === '?');
    const trackedPaths = paths.filter(p => p.status !== '??' && p.status !== '?');
    
    // 從 tracked 中分離 staged 和 unstaged
    const stagedPaths = trackedPaths.filter(p => p.staged).map(p => p.path);
    const unstagedPaths = trackedPaths.filter(p => !p.staged).map(p => p.path);
    
    // 清空輸出檔案
    await fs.writeFile(outputPath, '', 'utf8');
    
    const parts: string[] = [];
    
    // 1. Unstaged tracked files
    if (unstagedPaths.length > 0) {
      try {
        const args = ['diff', '--no-color', '--'];
        args.push(...unstagedPaths);
        const diffContent = await this.runGit(args, { stripFinalNewline: false });
        if (diffContent) {
          parts.push(diffContent);
        }
      } catch (error) {
        parts.push(`(Error exporting unstaged files: ${error})`);
      }
    }
    
    // 2. Staged files
    if (stagedPaths.length > 0) {
      try {
        const args = ['diff', '--no-color', '--cached', '--'];
        args.push(...stagedPaths);
        const diffContent = await this.runGit(args, { stripFinalNewline: false });
        if (diffContent) {
          parts.push(diffContent);
        }
      } catch (error) {
        parts.push(`(Error exporting staged files: ${error})`);
      }
    }
    
    // 3. Untracked files（需要單獨處理，使用 --no-index）
    if (untrackedPaths.length > 0) {
      const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
      for (const { path: filePath } of untrackedPaths) {
        try {
          const { stdout, exitCode } = await execa(this.gitBin, [
            'diff',
            '--no-color',
            '--no-index',
            '--',
            nullPath,
            filePath
          ], {
            cwd: this.cwd,
            reject: false,
            stripFinalNewline: false,
          });
          
          if ((exitCode === 0 || exitCode === 1) && stdout) {
            parts.push(stdout);
          }
        } catch (error) {
          parts.push(`(Error exporting untracked file ${filePath}: ${error})`);
        }
      }
    }
    
    // 合併所有內容
    const finalContent = parts.join('\n\n');
    await fs.writeFile(outputPath, finalContent, 'utf8');
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

