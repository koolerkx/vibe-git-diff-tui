import { GitService } from './git/GitService.js';

const git = new GitService({ cwd: process.cwd() });

// 1. 取得清單
const unstaged = await git.getUnstagedFiles();
console.log('--- Unstaged Files ---');
unstaged.forEach((f, i) => console.log(`[${i}] ${f.status} \t ${f.path}`));

console.log('\n--- Staged Files ---');
const staged = await git.getStagedFiles();
staged.forEach((f, i) => console.log(`[${i}] ${f.status} \t ${f.path}`));

// 2. 測試：找一個 Untracked 檔案來顯示 Diff (status 為 '??' 或 '?')
const untrackedFile = unstaged.find(f => f.status === '??' || f.status === '?');

if (untrackedFile) {
    console.log(`\n\n=== Testing Diff for Untracked File: ${untrackedFile.path} ===`);
    console.log(await git.getDiff({ 
        staged: false, 
        path: untrackedFile.path, 
        status: untrackedFile.status // <--- 修正點：一定要傳 status！
    }));
} else {
    console.log('\n(No untracked files found to test)');
}

// 3. 測試：找一個 Modified 檔案來顯示 Diff (status 為 'M' 或 ' M')
const modifiedFile = unstaged.find(f => f.status.includes('M'));

if (modifiedFile) {
    console.log(`\n\n=== Testing Diff for Modified File: ${modifiedFile.path} ===`);
    console.log(await git.getDiff({ 
        staged: false, 
        path: modifiedFile.path, 
        status: modifiedFile.status 
    }));
}
