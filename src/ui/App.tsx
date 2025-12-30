import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { GitService } from '../git/GitService.js';
import type { GitChange, CommitItem } from '../git/types.js';

// 初始化 Git 服務
const git = new GitService({ cwd: process.cwd() });

// 固定捲動單位（行數）
const SCROLL_LINES = 15;

// C++ 副檔名定義（僅用於合併）
const HEADER_EXTENSIONS = ['.h', '.hpp', '.hxx', '.hh'];
const SOURCE_EXTENSIONS = ['.cpp', '.cxx', '.cc', '.c'];

// 檔案配對類型
type FilePair = {
    baseName: string;
    dirPath: string;
    header: string | null;
    source: string | null;
};

// 統一列表項目類型
type ListItem = 
  | { type: 'group'; label: string; count: number }
  | { type: 'file'; file: GitChange; group: 'unstaged' | 'staged'; node?: TreeNode }
  | { type: 'directory'; node: TreeNode };

// 顯示模式
type ViewMode = 'flat' | 'tree';

// 程式碼 dump 輸出模式
type DumpMode = 'tree' | 'flat';

// 輸入模式
type InputMode = 'normal' | 'export-path' | 'export-overview' | 'export-code-dump';

// 焦點面板
type FocusPane = 'files' | 'commits';

// 樹狀節點型別
type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  file?: GitChange;  // 只有檔案節點才有
  group?: 'unstaged' | 'staged';  // 只有檔案節點才有
  depth: number;  // 縮排層級
};

// 剪貼簿工具函數（跨平台）
async function getClipboardContent(): Promise<string> {
    try {
        const { execSync } = await import('child_process');
        
        if (process.platform === 'darwin') {
            // macOS
            return execSync('pbpaste', { encoding: 'utf8' }).trim();
        } else if (process.platform === 'linux') {
            // Linux (需要 xclip 或 xsel)
            try {
                return execSync('xclip -selection clipboard -o', { encoding: 'utf8' }).trim();
            } catch {
                return execSync('xsel --clipboard --output', { encoding: 'utf8' }).trim();
            }
        } else if (process.platform === 'win32') {
            // Windows
            return execSync('powershell.exe -command "Get-Clipboard"', { encoding: 'utf8' }).trim();
        }
        
        return '';
    } catch (error) {
        throw new Error('Clipboard access failed');
    }
}

// 生成帶時間戳的檔案名
function getTimestampedFileName(prefix: string = 'diff'): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    // 格式: prefix_20251228_212945.txt
    return `${prefix}_${year}${month}${day}_${hours}${minutes}${seconds}.txt`;
}

// 生成 commit 專用的檔案名
function getCommitFileName(commitHash: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    // 格式: diff_{commit_hash}_{date}_{time}.txt
    const date = `${year}${month}${day}`;
    const time = `${hours}${minutes}${seconds}`;
    return `diff_${commitHash}_${date}_${time}.txt`;
}

// 生成帶時間戳的目錄名
function getTimestampedDirName(prefix: string = 'code_dump'): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    // 格式: code_dump_20251228_215530
    return `${prefix}_${year}${month}${day}_${hours}${minutes}${seconds}`;
}

// 檔案大小格式化函數
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// 生成檔案概覽（所有檔案，包括 untracked）
async function generateFileOverview(): Promise<string> {
    const path = await import('path');
    const fs = await import('fs');
    
    // ✅ 獲取所有檔案（包括 untracked，排除 gitignore）
    const allFiles = await git.getAllFiles();
    
    // 按目錄分組
    const grouped = new Map<string, Array<{ name: string; size: number }>>();
    
    for (const filePath of allFiles) {
        const dir = path.dirname(filePath);
        const name = path.basename(filePath);
        
        // 獲取檔案大小
        let size = 0;
        try {
            const fullPath = path.join(process.cwd(), filePath);
            const stat = fs.statSync(fullPath);
            size = stat.size;
        } catch (error) {
            // 檔案不存在或無法訪問，使用 0
            size = 0;
        }
        
        if (!grouped.has(dir)) {
            grouped.set(dir, []);
        }
        grouped.get(dir)!.push({ name, size });
    }
    
    // 排序目錄
    const sortedDirs = Array.from(grouped.keys()).sort();
    
    // 生成輸出
    let output = '';
    
    for (const dir of sortedDirs) {
        const files = grouped.get(dir)!;
        
        // 排序檔案
        files.sort((a, b) => a.name.localeCompare(b.name));
        
        // 目錄標題
        const displayDir = dir === '.' ? '[.]' : `[${dir}]`;
        output += `${displayDir}\n`;
        
        // 列出檔案
        for (const file of files) {
            output += `  - ${file.name} (${formatFileSize(file.size)})\n`;
        }
        
        output += '\n';
    }
    
    return output;
}

// 生成合併的程式碼庫
async function generateMergedCodebase(mode: DumpMode): Promise<Map<string, string>> {
    const path = await import('path');
    const fs = await import('fs');
    
    // ✅ 獲取所有檔案（包括 untracked，排除 gitignore）
    const allFiles = await git.getAllFiles();
    
    // 分類檔案
    const headers: string[] = [];
    const sources: string[] = [];
    const otherFiles: string[] = [];
    
    for (const file of allFiles) {
        const ext = path.extname(file).toLowerCase();
        
        if (HEADER_EXTENSIONS.includes(ext)) {
            headers.push(file);
        } else if (SOURCE_EXTENSIONS.includes(ext)) {
            sources.push(file);
        } else {
            // ✅ 所有其他檔案都保留（js, ts, hlsl, txt, 等等）
            otherFiles.push(file);
        }
    }
    
    // 建立檔案配對映射
    const pairMap = new Map<string, FilePair>();
    
    // 處理 headers
    for (const headerPath of headers) {
        const dir = path.dirname(headerPath);
        const baseName = path.basename(headerPath, path.extname(headerPath));
        const key = `${dir}|${baseName}`;
        
        if (!pairMap.has(key)) {
            pairMap.set(key, {
                baseName,
                dirPath: dir,
                header: headerPath,
                source: null,
            });
        }
    }
    
    // 配對 sources
    const unmatchedSources: string[] = [];
    for (const sourcePath of sources) {
        const dir = path.dirname(sourcePath);
        const baseName = path.basename(sourcePath, path.extname(sourcePath));
        const key = `${dir}|${baseName}`;
        
        if (pairMap.has(key)) {
            pairMap.get(key)!.source = sourcePath;
        } else {
            // ✅ 獨立的 .cpp 也要匯出（沒有對應 header）
            unmatchedSources.push(sourcePath);
        }
    }
    
    // 生成合併檔案內容
    const outputFiles = new Map<string, string>();
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    // 處理配對的 C++ 檔案
    for (const [key, pair] of pairMap) {
        const { baseName, dirPath, header, source } = pair;
        
        const outputFileName = mode === 'flat'
            ? `${dirPath === '.' ? '' : dirPath.replace(/[/\\]/g, '_') + '_'}${baseName}_merged.cpp`
            : `${dirPath}/${baseName}_merged.cpp`;
        
        let content = '';
        content += '// ============================================================================\n';
        content += `// 合併檔案: ${baseName}\n`;
        content += `// 原始路徑: ${dirPath}\n`;
        content += `// 合併時間: ${timestamp}\n`;
        content += `// 輸出模式: ${mode === 'flat' ? '扁平化' : '目錄結構'}\n`;
        
        if (header && source) {
            // 合併 header 和 source
            content += `// Header: ${path.basename(header)}\n`;
            content += `// Source: ${path.basename(source)}\n`;
            content += '// ============================================================================\n\n';
            content += `// -------------------- Header File: ${path.basename(header)} --------------------\n\n`;
            
            try {
                const headerContent = fs.readFileSync(path.join(process.cwd(), header), 'utf8');
                content += headerContent;
            } catch (error) {
                content += `// Error reading header: ${error}\n`;
            }
            
            content += '\n\n';
            content += `// -------------------- Source File: ${path.basename(source)} --------------------\n\n`;
            
            try {
                const sourceContent = fs.readFileSync(path.join(process.cwd(), source), 'utf8');
                content += sourceContent;
            } catch (error) {
                content += `// Error reading source: ${error}\n`;
            }
        } else if (header) {
            // 只有 header
            content += `// Header: ${path.basename(header)}\n`;
            content += '// Source: (無對應的 source 檔案)\n';
            content += '// ============================================================================\n\n';
            
            try {
                const headerContent = fs.readFileSync(path.join(process.cwd(), header), 'utf8');
                content += headerContent;
            } catch (error) {
                content += `// Error reading header: ${error}\n`;
            }
        } else if (source) {
            // 只有 source
            content += `// Header: (無對應的 header 檔案)\n`;
            content += `// Source: ${path.basename(source)}\n`;
            content += '// ============================================================================\n\n';
            
            try {
                const sourceContent = fs.readFileSync(path.join(process.cwd(), source), 'utf8');
                content += sourceContent;
            } catch (error) {
                content += `// Error reading source: ${error}\n`;
            }
        }
        
        outputFiles.set(outputFileName, content);
    }
    
    // ✅ 處理獨立的 source 檔案（沒有對應 header 的 .cpp）
    for (const sourcePath of unmatchedSources) {
        const dir = path.dirname(sourcePath);
        const baseName = path.basename(sourcePath);
        
        const outputFileName = mode === 'flat'
            ? `${dir === '.' ? '' : dir.replace(/[/\\]/g, '_') + '_'}${baseName}`
            : `${dir}/${baseName}`;
        
        let content = '';
        content += '// ============================================================================\n';
        content += `// 獨立檔案: ${baseName}\n`;
        content += `// 原始路徑: ${dir}\n`;
        content += `// 匯出時間: ${timestamp}\n`;
        content += '// ============================================================================\n\n';
        
        try {
            const fileContent = fs.readFileSync(path.join(process.cwd(), sourcePath), 'utf8');
            content += fileContent;
        } catch (error) {
            content += `// Error reading file: ${error}\n`;
        }
        
        outputFiles.set(outputFileName, content);
    }
    
    // ✅ 處理所有其他檔案（js, ts, hlsl, txt, json, 等等）
    for (const filePath of otherFiles) {
        const dir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        
        const outputFileName = mode === 'flat'
            ? `${dir === '.' ? '' : dir.replace(/[/\\]/g, '_') + '_'}${fileName}`
            : `${dir}/${fileName}`;
        
        let content = '';
        
        try {
            const fileContent = fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
            content = fileContent;
        } catch (error) {
            content = `// Error reading file: ${error}\n`;
        }
        
        outputFiles.set(outputFileName, content);
    }
    
    return outputFiles;
}

// 生成匯出摘要
function generateDumpSummary(files: Map<string, string>, outputDir: string, mode: DumpMode): string {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    let summary = '';
    summary += '='.repeat(80) + '\n';
    summary += 'Code Dump Summary\n';
    summary += '='.repeat(80) + '\n\n';
    summary += `Export Time: ${timestamp}\n`;
    summary += `Source Directory: ${process.cwd()}\n`;
    summary += `Output Directory: ${outputDir}\n`;
    summary += `Output Mode: ${mode === 'flat' ? 'Flattened' : 'Directory Tree'}\n\n`;
    summary += `Statistics:\n`;
    summary += `  - Total Files: ${files.size}\n\n`;
    summary += '='.repeat(80) + '\n';
    summary += 'File List\n';
    summary += '='.repeat(80) + '\n\n';
    
    const sortedFiles = Array.from(files.keys()).sort();
    for (const fileName of sortedFiles) {
        summary += `  ${fileName}\n`;
    }
    
    summary += '\n' + '='.repeat(80) + '\n';
    if (mode === 'flat') {
        summary += 'Note: In flat mode, path information is encoded in filenames\n';
        summary += '      Path separators \'/\' and \'\\\' are replaced with \'_\'\n';
    } else {
        summary += 'Note: Directory structure is preserved\n';
    }
    summary += '='.repeat(80) + '\n';
    
    return summary;
}

// 自製 Hook：取得終端機寬高
function useWindowSize() {
    const [size, setSize] = useState({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
    });

    useEffect(() => {
        function onResize() {
            setSize({
                columns: process.stdout.columns || 80,
                rows: process.stdout.rows || 24,
            });
        }

        process.stdout.on('resize', onResize);
        return () => {
            process.stdout.off('resize', onResize);
        };
    }, []);

    return [size.columns, size.rows] as const;
}

// 建立檔案樹結構
const buildFileTree = (files: GitChange[], group: 'unstaged' | 'staged'): TreeNode[] => {
    const root: Map<string, TreeNode> = new Map();
    
    files.forEach(file => {
        const parts = file.path.split('/').filter(p => p.length > 0);
        let currentPath = '';
        
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part) continue;
            
            const parentPath = currentPath;
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            
            const isFile = i === parts.length - 1;
            const depth = i;
            
            if (!root.has(currentPath)) {
                const node: TreeNode = {
                    name: part,
                    path: currentPath,
                    type: isFile ? 'file' : 'directory',
                    depth,
                    ...(isFile && { file, group }),
                    ...(!isFile && { children: [] }),
                };
                root.set(currentPath, node);
                
                // 連結到父節點
                if (parentPath && root.has(parentPath)) {
                    const parent = root.get(parentPath);
                    if (parent?.children) {
                        parent.children.push(node);
                    }
                }
            }
        }
    });
    
    // 只返回頂層節點
    return Array.from(root.values()).filter(node => !node.path.includes('/'));
};

// 扁平化樹狀結構（用於渲染）
const flattenTree = (nodes: TreeNode[], collapsed: Set<string> = new Set()): TreeNode[] => {
    const result: TreeNode[] = [];
    
    const traverse = (nodes: TreeNode[]) => {
        nodes.forEach(node => {
            result.push(node);
            
            // 如果是目錄且未收合，繼續遍歷子節點
            if (node.type === 'directory' && !collapsed.has(node.path) && node.children) {
                traverse(node.children);
            }
        });
    };
    
    traverse(nodes);
    return result;
};

export const App = () => {
    const { exit } = useApp();
    const [columns, rows] = useWindowSize();

    const [stagedFiles, setStagedFiles] = useState<GitChange[]>([]);
    const [unstagedFiles, setUnstagedFiles] = useState<GitChange[]>([]);

    // Commit 相關狀態
    const [commits, setCommits] = useState<CommitItem[]>([]);
    const [commitFocusIndex, setCommitFocusIndex] = useState(0);
    const [commitScrollOffset, setCommitScrollOffset] = useState(0);
    const [selectedCommits, setSelectedCommits] = useState<Set<string>>(new Set());
    const [focusPane, setFocusPane] = useState<FocusPane>('files');

    // 列表焦點 index
    const [selectedIndex, setSelectedIndex] = useState(0);

    // 捲動狀態
    const [listScrollTop, setListScrollTop] = useState(0);
    const [diffScrollTop, setDiffScrollTop] = useState(0);

    // 統一多選狀態（用 path 作為 key）
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

    // 顯示模式
    const [viewMode, setViewMode] = useState<ViewMode>('flat');

    // 程式碼 dump 輸出模式
    const [dumpMode, setDumpMode] = useState<DumpMode>('tree');

    // 追蹤目錄收合狀態
    const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

    // Diff 內容
    const [diffContent, setDiffContent] = useState('');

    // 匯出狀態提示
    const [exportStatus, setExportStatus] = useState<string>('');

    // 輸入模式
    const [inputMode, setInputMode] = useState<InputMode>('normal');

    // 路徑輸入緩衝
    const [pathInput, setPathInput] = useState('./diff.txt');

    // 游標位置（用於編輯體驗）
    const [cursorPosition, setCursorPosition] = useState(0);

    // 建立統一列表（支援兩種模式）
    const allItems: ListItem[] = useMemo(() => {
        const items: ListItem[] = [];
        
        if (viewMode === 'flat') {
            // 原有的扁平模式
            if (unstagedFiles.length > 0) {
                items.push({ type: 'group', label: 'Changes', count: unstagedFiles.length });
                unstagedFiles.forEach(file => {
                    items.push({ type: 'file', file, group: 'unstaged' });
                });
            }
            
            if (stagedFiles.length > 0) {
                items.push({ type: 'group', label: 'Staged Changes', count: stagedFiles.length });
                stagedFiles.forEach(file => {
                    items.push({ type: 'file', file, group: 'staged' });
                });
            }
        } else {
            // 樹狀模式
            if (unstagedFiles.length > 0) {
                items.push({ type: 'group', label: 'Changes', count: unstagedFiles.length });
                const tree = buildFileTree(unstagedFiles, 'unstaged');
                const flatTree = flattenTree(tree, collapsedDirs);
                items.push(...flatTree.map(node => {
                    if (node.type === 'file') {
                        return { 
                            type: 'file' as const,
                            file: node.file!,
                            group: node.group!,
                            node
                        };
                    } else {
                        return {
                            type: 'directory' as const,
                            node
                        };
                    }
                }));
            }
            
            if (stagedFiles.length > 0) {
                items.push({ type: 'group', label: 'Staged Changes', count: stagedFiles.length });
                const tree = buildFileTree(stagedFiles, 'staged');
                const flatTree = flattenTree(tree, collapsedDirs);
                items.push(...flatTree.map(node => {
                    if (node.type === 'file') {
                        return { 
                            type: 'file' as const,
                            file: node.file!,
                            group: node.group!,
                            node
                        };
                    } else {
                        return {
                            type: 'directory' as const,
                            node
                        };
                    }
                }));
            }
        }
        
        return items;
    }, [unstagedFiles, stagedFiles, viewMode, collapsedDirs]);

    // 載入清單
    useEffect(() => {
        const load = async () => {
            try {
                const u = await git.getUnstagedFiles();
                const s = await git.getStagedFiles();
                setUnstagedFiles(u);
                setStagedFiles(s);
            } catch (error) {
                // 簡單錯誤顯示，實際可做更漂亮的 ErrorBoundary
                setDiffContent(`Error loading files: ${error}`);
            }
        };
        load();
    }, []);

    // 載入 commits
    const loadCommits = async () => {
        try {
            const commitHistory = await git.getCommitHistory(100);
            setCommits(commitHistory);
        } catch (e) {
            setDiffContent(`Error loading commits: ${e}`);
        }
    };

    useEffect(() => {
        loadCommits();
    }, []);

    // 計算當前選中項
    const currentItem = allItems[selectedIndex];
    const currentFile = currentItem?.type === 'file' ? currentItem.file : null;
    const currentGroup = currentItem?.type === 'file' ? currentItem.group : null;

    // 匯出單一檔案 diff
    const handleExportSingle = async () => {
        if (!currentFile || !currentGroup) {
            setExportStatus('No file selected');
            setTimeout(() => setExportStatus(''), 2000);
            return;
        }
        
        try {
            const outputPath = './diff.txt';
            const fs = await import('fs/promises');
            
            // 檢查檔案是否存在
            try {
                await fs.access(outputPath);
                // 檔案已存在，直接覆蓋（可以改為提示用戶）
                // 這裡選擇直接覆蓋，因為是簡單的 TUI 工具
            } catch {
                // 檔案不存在，繼續匯出
            }
            
            await git.exportDiff({
                path: currentFile.path,
                staged: currentGroup === 'staged',
                outputPath,
                status: currentFile.status,
            });
            setExportStatus(`Exported to ${outputPath}`);
            setTimeout(() => setExportStatus(''), 2000);
        } catch (error) {
            setExportStatus(`Export failed: ${error}`);
            setTimeout(() => setExportStatus(''), 3000);
        }
    };

    // 匯出多檔合併 diff（現在接受參數）
    const handleExportMultiple = async (outputPath: string) => {
        if (selectedPaths.size === 0) {
            setExportStatus('No files selected');
            setTimeout(() => setExportStatus(''), 2000);
            return;
        }

        try {
            const filesToExport = allItems
                .filter((item): item is Extract<ListItem, { type: 'file' }> =>
                    item.type === 'file' && selectedPaths.has(item.file.path)
                )
                .map(item => ({
                    path: item.file.path,
                    staged: item.group === 'staged',
                    status: item.file.status,
                }));

            const path = await import('path');
            const fs = await import('fs');
            const fsPromises = await import('fs/promises');
            
            // 解析路徑
            let resolvedPath = path.isAbsolute(outputPath) 
                ? outputPath 
                : path.resolve(process.cwd(), outputPath);
            
            // ✅ 檢查是否為目錄
            try {
                const stat = fs.statSync(resolvedPath);
                if (stat.isDirectory()) {
                    // ✅ 如果是目錄，使用時間戳檔案名
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName('diff'));
                }
            } catch {
                // 檔案不存在，檢查是否沒有副檔名
                if (path.extname(resolvedPath) === '') {
                    // ✅ 可能是目錄，使用時間戳檔案名
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName('diff'));
                }
            }
            
            // 確保目錄存在
            const dir = path.dirname(resolvedPath);
            await fsPromises.mkdir(dir, { recursive: true });

            await git.exportMultipleDiffs({
                paths: filesToExport,
                outputPath: resolvedPath,
            });

            setExportStatus(`✓ Exported to ${path.basename(resolvedPath)}`);
            setTimeout(() => setExportStatus(''), 3000);
        } catch (error) {
            setExportStatus(`✗ Export failed: ${error}`);
            setTimeout(() => setExportStatus(''), 3000);
        }
    };

    // 匯出檔案概覽（支援自訂路徑）
    const handleExportOverview = async (outputPath: string) => {
        try {
            const path = await import('path');
            const fs = await import('fs');
            const fsPromises = await import('fs/promises');
            
            // 解析路徑
            let resolvedPath = path.isAbsolute(outputPath) 
                ? outputPath 
                : path.resolve(process.cwd(), outputPath);
            
            // 檢查是否為目錄
            try {
                const stat = fs.statSync(resolvedPath);
                if (stat.isDirectory()) {
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName('files_overview'));
                }
            } catch {
                if (path.extname(resolvedPath) === '') {
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName('files_overview'));
                }
            }
            
            // 確保目錄存在
            const dir = path.dirname(resolvedPath);
            await fsPromises.mkdir(dir, { recursive: true });
            
            // 顯示處理中狀態
            setExportStatus('Generating overview...');
            
            // 生成概覽內容
            const overview = await generateFileOverview();
            
            // 寫入檔案
            await fsPromises.writeFile(resolvedPath, overview, 'utf8');

            setExportStatus(`✓ Overview exported to ${path.basename(resolvedPath)}`);
            setTimeout(() => setExportStatus(''), 3000);
        } catch (error) {
            setExportStatus(`✗ Export failed: ${error}`);
            setTimeout(() => setExportStatus(''), 3000);
        }
    };

    // 導出選中的 commits
    const handleExportCommits = async (outputPath: string) => {
        const selected = Array.from(selectedCommits);
        if (selected.length === 0) {
            // 導出當前焦點的 commit
            const currentCommit = commits[commitFocusIndex];
            if (!currentCommit) {
                setExportStatus('❌ No commit selected');
                setTimeout(() => setExportStatus(''), 2000);
                return;
            }
            
            try {
                const path = await import('path');
                const fs = await import('fs');
                const fsPromises = await import('fs/promises');
                
                // 解析路徑
                let resolvedPath = outputPath 
                    ? (path.isAbsolute(outputPath) 
                        ? outputPath 
                        : path.resolve(process.cwd(), outputPath))
                    : path.resolve(process.cwd(), getCommitFileName(currentCommit.hash));
                
                // ✅ 檢查是否為目錄
                try {
                    const stat = fs.statSync(resolvedPath);
                    if (stat.isDirectory()) {
                        // ✅ 如果是目錄，使用 commit 檔名格式
                        resolvedPath = path.join(resolvedPath, getCommitFileName(currentCommit.hash));
                    }
                } catch {
                    // 檔案不存在，檢查是否沒有副檔名
                    if (path.extname(resolvedPath) === '') {
                        // ✅ 可能是目錄，使用 commit 檔名格式
                        resolvedPath = path.join(resolvedPath, getCommitFileName(currentCommit.hash));
                    }
                }
                
                // 確保目錄存在
                const dir = path.dirname(resolvedPath);
                await fsPromises.mkdir(dir, { recursive: true });
                
                await git.exportCommitDiff({
                    hash: currentCommit.hash,
                    message: currentCommit.message,
                    outputPath: resolvedPath
                });
                setExportStatus(`✅ Exported to ${resolvedPath}`);
                setTimeout(() => setExportStatus(''), 3000);
            } catch (e) {
                setExportStatus(`❌ Export failed: ${e}`);
                setTimeout(() => setExportStatus(''), 3000);
            }
        } else {
            // 導出多個 commits
            try {
                const path = await import('path');
                const fs = await import('fs');
                const fsPromises = await import('fs/promises');
                
                // 解析路徑
                let resolvedPath = outputPath 
                    ? (path.isAbsolute(outputPath) 
                        ? outputPath 
                        : path.resolve(process.cwd(), outputPath))
                    : path.resolve(process.cwd(), getTimestampedFileName('commits'));
                
                // ✅ 檢查是否為目錄
                try {
                    const stat = fs.statSync(resolvedPath);
                    if (stat.isDirectory()) {
                        // ✅ 如果是目錄，使用時間戳檔案名
                        resolvedPath = path.join(resolvedPath, getTimestampedFileName('commits'));
                    }
                } catch {
                    // 檔案不存在，檢查是否沒有副檔名
                    if (path.extname(resolvedPath) === '') {
                        // ✅ 可能是目錄，使用時間戳檔案名
                        resolvedPath = path.join(resolvedPath, getTimestampedFileName('commits'));
                    }
                }
                
                // 確保目錄存在
                const dir = path.dirname(resolvedPath);
                await fsPromises.mkdir(dir, { recursive: true });
                
                const commitsToExport = commits
                    .filter(c => selected.includes(c.hash))
                    .map(c => ({ hash: c.hash, message: c.message }));
                
                await git.exportMultipleCommits({
                    commits: commitsToExport,
                    outputPath: resolvedPath
                });
                
                setExportStatus(`✅ Exported ${commitsToExport.length} commits to ${resolvedPath}`);
                setSelectedCommits(new Set());
                setTimeout(() => setExportStatus(''), 3000);
            } catch (e) {
                setExportStatus(`❌ Export failed: ${e}`);
                setTimeout(() => setExportStatus(''), 3000);
            }
        }
    };

    // 匯出合併的程式碼庫
    const handleExportCodeDump = async (outputPath: string, mode: DumpMode) => {
        try {
            const path = await import('path');
            const fs = await import('fs');
            const fsPromises = await import('fs/promises');
            
            // ✅ 解析基礎路徑
            let basePath = '';
            if (outputPath.trim() === '') {
                // 空路徑：使用當前目錄
                basePath = process.cwd();
            } else {
                // 有輸入路徑
                basePath = path.isAbsolute(outputPath) 
                    ? outputPath 
                    : path.resolve(process.cwd(), outputPath);
            }
            
            // ✅ 建立帶時間戳的目錄（兩種模式都一樣，不再建立額外的 dump 子資料夾）
            const timestampedDir = getTimestampedDirName('code_dump');
            const resolvedPath = path.join(basePath, timestampedDir);
            
            // 確保目錄存在
            await fsPromises.mkdir(resolvedPath, { recursive: true });
            
            // 顯示處理中狀態
            setExportStatus('Generating code dump...');
            
            // 生成合併檔案
            const mergedFiles = await generateMergedCodebase(mode);
            
            // 寫入所有檔案
            let count = 0;
            for (const [fileName, content] of mergedFiles) {
                const filePath = path.join(resolvedPath, fileName);
                
                // 確保子目錄存在（目錄結構模式需要）
                const fileDir = path.dirname(filePath);
                await fsPromises.mkdir(fileDir, { recursive: true });
                
                await fsPromises.writeFile(filePath, content, 'utf8');
                count++;
            }
            
            // ✅ 生成摘要檔案（直接放在時間戳目錄的根目錄）
            const summaryPath = path.join(resolvedPath, 'dump_summary.txt');
            const summary = generateDumpSummary(mergedFiles, resolvedPath, mode);
            await fsPromises.writeFile(summaryPath, summary, 'utf8');
            
            // 顯示相對路徑
            const displayPath = path.relative(process.cwd(), resolvedPath);
            setExportStatus(`✓ Dumped ${count} files to ${displayPath}/`);
            setTimeout(() => setExportStatus(''), 3000);
        } catch (error) {
            setExportStatus(`✗ Export failed: ${error}`);
            setTimeout(() => setExportStatus(''), 3000);
        }
    };

    // 計算版面高度 (扣除 Header/Footer/Borders)
    const isWarp = process.env.TERM_PROGRAM === 'WarpTerminal';
    const adjustedRows = isWarp ? Math.max(10, (rows || 24) - 1) : (rows || 24);
    const mainAreaHeight = Math.max(3, adjustedRows - 8);


    // 當列表變化時，確保選中索引有效
    useEffect(() => {
        // 如果當前選中的索引超出範圍，調整到有效範圍
        if (selectedIndex >= allItems.length) {
            const lastIndex = Math.max(0, allItems.length - 1);
            setSelectedIndex(lastIndex);
            setListScrollTop(Math.max(0, lastIndex - mainAreaHeight + 1));
        } else if (allItems.length === 0) {
            setSelectedIndex(0);
            setListScrollTop(0);
        }
    }, [allItems.length, selectedIndex, mainAreaHeight]);

    // 切換檔案時重置 Diff Scroll
    useEffect(() => {
        setDiffScrollTop(0);
    }, [selectedIndex, commitFocusIndex, focusPane]);

    // 載入 Diff
    useEffect(() => {
        const fetchDiff = async () => {
            if (focusPane === 'commits') {
                // 顯示 commit diff
                const currentCommit = commits[commitFocusIndex];
                if (!currentCommit) {
                    setDiffContent('');
                    return;
                }
                
                try {
                    const txt = await git.getCommitDiff(currentCommit.hash);
                    setDiffContent(txt);
                } catch (e) {
                    setDiffContent('(Error loading commit diff)');
                }
            } else {
                // 顯示文件 diff
                if (!currentFile || !currentGroup) {
                    setDiffContent('');
                    return;
                }
                
                try {
                    const txt = await git.getDiff({
                        staged: currentGroup === 'staged',
                        path: currentFile.path,
                        status: currentFile.status,
                    });
                    setDiffContent(txt);
                } catch (e) {
                    setDiffContent('(Error loading diff)');
                }
            }
        };
        
        fetchDiff();
    }, [currentFile, currentGroup, focusPane, commits, commitFocusIndex]);

    // 鍵盤操作
    useInput((input, key) => {
        // ============ 路徑輸入模式 ============
        if (inputMode === 'export-path' || inputMode === 'export-overview' || inputMode === 'export-code-dump') {
            // ESC: 取消輸入
            if (key.escape) {
                setInputMode('normal');
                setPathInput(''); // ✅ 重置為空
                setCursorPosition(0);
                return;
            }

            // ✅ Tab: 切換 dump 模式（僅在 code-dump 模式）
            if (key.tab && inputMode === 'export-code-dump') {
                setDumpMode(prev => prev === 'flat' ? 'tree' : 'flat');
                return;
            }

            // Enter: 確認匯出
            if (key.return) {
                setInputMode('normal');
                
                if (inputMode === 'export-path') {
                    // 匯出 diff
                    if (focusPane === 'commits') {
                        let finalPath = pathInput.trim();
                        if (finalPath === '') {
                            // 使用預設檔名格式
                            const currentCommit = commits[commitFocusIndex];
                            if (currentCommit) {
                                finalPath = `./${getCommitFileName(currentCommit.hash)}`;
                            } else {
                                finalPath = `./${getTimestampedFileName('commit')}`;
                            }
                        }
                        handleExportCommits(finalPath);
                    } else {
                        const finalPath = pathInput.trim() === '' 
                            ? `./${getTimestampedFileName('diff')}` 
                            : pathInput;
                        if (selectedPaths.size === 0) {
                            handleExportSingle();
                        } else {
                            handleExportMultiple(finalPath);
                        }
                    }
                } else if (inputMode === 'export-overview') {
                    // 匯出概覽
                    const finalPath = pathInput.trim() === '' 
                        ? `./${getTimestampedFileName('files_overview')}` 
                        : pathInput;
                    handleExportOverview(finalPath);
                } else if (inputMode === 'export-code-dump') {
                    // 匯出程式碼 dump
                    const finalPath = pathInput.trim();
                    handleExportCodeDump(finalPath, dumpMode);
                }
                
                setPathInput(''); // ✅ 重置為空
                setCursorPosition(0);
                return;
            }

            // Backspace: 刪除字元
            if (key.backspace || key.delete) {
                if (cursorPosition > 0) {
                    const newPath = 
                        pathInput.slice(0, cursorPosition - 1) + 
                        pathInput.slice(cursorPosition);
                    setPathInput(newPath);
                    setCursorPosition(cursorPosition - 1);
                }
                return;
            }

            // Ctrl+V: 貼上剪貼簿
            if (key.ctrl && input === 'v') {
                (async () => {
                    try {
                        const clipboardContent = await getClipboardContent();
                        // ✅ 移除換行符，確保單行
                        const sanitized = clipboardContent.replace(/[\r\n]+/g, '');
                        const newPath =
                            pathInput.slice(0, cursorPosition) +
                            sanitized +
                            pathInput.slice(cursorPosition);
                        setPathInput(newPath);
                        setCursorPosition(cursorPosition + sanitized.length);
                    } catch (error) {
                        setExportStatus('✗ Clipboard paste failed');
                        setTimeout(() => setExportStatus(''), 2000);
                    }
                })();
                return;
            }

            // Ctrl+U: 清空輸入
            if (key.ctrl && input === 'u') {
                setPathInput('');
                setCursorPosition(0);
                return;
            }

            // Left Arrow: 移動游標
            if (key.leftArrow) {
                setCursorPosition(Math.max(0, cursorPosition - 1));
                return;
            }

            // Right Arrow: 移動游標
            if (key.rightArrow) {
                setCursorPosition(Math.min(pathInput.length, cursorPosition + 1));
                return;
            }

            // Home: 移到開頭
            if (key.home) {
                setCursorPosition(0);
                return;
            }

            // End: 移到結尾
            if (key.end) {
                setCursorPosition(pathInput.length);
                return;
            }

            // 一般字元輸入
            if (input && !key.ctrl && !key.meta) {
                const newPath = 
                    pathInput.slice(0, cursorPosition) + 
                    input + 
                    pathInput.slice(cursorPosition);
                setPathInput(newPath);
                setCursorPosition(cursorPosition + input.length);
                return;
            }

            return; // 在輸入模式下，不處理其他按鍵
        }

        // ============ 正常瀏覽模式 ============
        
        // 退出
        if (input === 'q') {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                process.stdin.setRawMode(false);
            }
            exit();
            return;
        }

        // Tab 或左右箭头: 切換焦點面板
        if (key.tab) {
            setFocusPane(prev => prev === 'files' ? 'commits' : 'files');
            return;
        }
        
        // 左箭头: 切换到文件列表
        if (key.leftArrow) {
            setFocusPane('files');
            return;
        }
        
        // 右箭头: 切换到 commit 列表
        if (key.rightArrow) {
            setFocusPane('commits');
            return;
        }

        // '/' 切換顯示模式
        if (input === '/') {
            setViewMode(prev => prev === 'flat' ? 'tree' : 'flat');
            setSelectedIndex(0);
            setListScrollTop(0);
            return;
        }

        // 上移
        if (key.upArrow || input === 'k') {
            if (focusPane === 'files') {
                setSelectedIndex(prev => {
                    const nextIndex = Math.max(prev - 1, 0);
                    // 自動捲動
                    const filesPaneHeight = Math.floor(mainAreaHeight * 2 / 4);
                    if (nextIndex < listScrollTop) {
                        setListScrollTop(nextIndex);
                    }
                    return nextIndex;
                });
            } else {
                setCommitFocusIndex(prev => {
                    const nextIndex = Math.max(prev - 1, 0);
                    if (nextIndex < commitScrollOffset) {
                        setCommitScrollOffset(nextIndex);
                    }
                    return nextIndex;
                });
            }
            return;
        }

        // 下移
        if (key.downArrow || input === 'j') {
            if (focusPane === 'files') {
                setSelectedIndex(prev => {
                    const nextIndex = Math.min(prev + 1, allItems.length - 1);
                    // 自動捲動
                    const filesPaneHeight = Math.floor(mainAreaHeight * 2 / 4);
                    if (nextIndex >= listScrollTop + filesPaneHeight) {
                        setListScrollTop(nextIndex - filesPaneHeight + 1);
                    }
                    return nextIndex;
                });
            } else {
                setCommitFocusIndex(prev => {
                    const nextIndex = Math.min(prev + 1, commits.length - 1);
                    const commitPaneHeight = Math.floor(mainAreaHeight / 4);
                    if (nextIndex >= commitScrollOffset + commitPaneHeight) {
                        setCommitScrollOffset(nextIndex - commitPaneHeight + 1);
                    }
                    return nextIndex;
                });
            }
            return;
        }

        // Diff 捲動 (PageUp/PageDown)
        if (key.pageDown) {
            setDiffScrollTop(prev => {
                const diffLines = diffContent.split('\n');
                const maxScroll = Math.max(0, diffLines.length - mainAreaHeight);
                return Math.min(prev + SCROLL_LINES, maxScroll);
            });
        }
        if (key.pageUp) {
            setDiffScrollTop(prev => Math.max(0, prev - SCROLL_LINES));
        }

        // Space: 切換選擇
        if (input === ' ') {
            if (focusPane === 'commits') {
                const commit = commits[commitFocusIndex];
                if (commit) {
                    setSelectedCommits(prev => {
                        const next = new Set(prev);
                        if (next.has(commit.hash)) {
                            next.delete(commit.hash);
                        } else {
                            next.add(commit.hash);
                        }
                        return next;
                    });
                }
            } else {
                const currentItem = allItems[selectedIndex];
                
                if (currentItem?.type === 'group') {
                    // 在分組標題上：全選/取消該分組
                    const newSet = new Set(selectedPaths);
                    
                    // 找出該分組的所有檔案
                    const groupLabel = currentItem.label;
                    const isStaged = groupLabel === 'Staged Changes';
                    const groupFiles = (isStaged ? stagedFiles : unstagedFiles);
                    
                    // 檢查是否已全選
                    const allSelected = groupFiles.every(f => newSet.has(f.path));
                    
                    if (allSelected) {
                        // 取消該分組所有選擇
                        groupFiles.forEach(f => newSet.delete(f.path));
                    } else {
                        // 全選該分組
                        groupFiles.forEach(f => newSet.add(f.path));
                    }
                    
                    setSelectedPaths(newSet);
                } else if (currentItem?.type === 'file') {
                    // 在檔案上：切換單個檔案選擇
                    const newSet = new Set(selectedPaths);
                    const path = currentItem.file.path;
                    if (newSet.has(path)) {
                        newSet.delete(path);
                    } else {
                        newSet.add(path);
                    }
                    setSelectedPaths(newSet);
                }
            }
            return;
        }

        // Enter: 在樹狀模式下展開/收合目錄
        if (key.return && viewMode === 'tree') {
            const currentItem = allItems[selectedIndex];
            if (currentItem?.type === 'directory') {
                const dirPath = currentItem.node.path;
                const newCollapsed = new Set(collapsedDirs);
                if (newCollapsed.has(dirPath)) {
                    newCollapsed.delete(dirPath);
                } else {
                    newCollapsed.add(dirPath);
                }
                setCollapsedDirs(newCollapsed);
            }
        }

        // 'a': 智能全選
        if (input === 'a') {
            const newSet = new Set(selectedPaths);
            
            // 如果焦點在某個分組內，只全選該分組
            if (currentItem?.type === 'file') {
                const targetGroup = currentItem.group;
                const groupFiles = allItems
                    .filter((item): item is Extract<ListItem, { type: 'file' }> => 
                        item.type === 'file' && item.group === targetGroup
                    )
                    .map(item => item.file);
                
                const allSelected = groupFiles.every(f => newSet.has(f.path));
                if (allSelected) {
                    groupFiles.forEach(f => newSet.delete(f.path));
                } else {
                    groupFiles.forEach(f => newSet.add(f.path));
                }
            } else {
                // 在分組標題上，全選所有檔案
                const allFiles = allItems
                    .filter((item): item is Extract<ListItem, { type: 'file' }> => 
                        item.type === 'file'
                    )
                    .map(item => item.file);
                
                const allSelected = allFiles.every(f => newSet.has(f.path));
                if (allSelected) {
                    allFiles.forEach(f => newSet.delete(f.path));
                } else {
                    allFiles.forEach(f => newSet.add(f.path));
                }
            }
            
            setSelectedPaths(newSet);
        }

        // 'E' (Shift+e): 進入路徑輸入模式
        if (input === 'E') {
            if (focusPane === 'commits') {
                // Commits 模式：允許導出當前或選中的 commits
                setInputMode('export-path');
                setPathInput('');
                setCursorPosition(0);
            } else {
                // Files 模式：需要選中文件
                if (selectedPaths.size === 0) {
                    setExportStatus('No files selected');
                    setTimeout(() => setExportStatus(''), 2000);
                    return;
                }
                
                setInputMode('export-path');
                setPathInput(''); // ✅ 空白開始
                setCursorPosition(0); // ✅ 游標在開頭
            }
            return;
        }

        // 'f' (小寫): 快速匯出檔案概覽到當前目錄
        if (input === 'f') {
            handleExportOverview(`./${getTimestampedFileName('files_overview')}`);
            return;
        }

        // 'F' (大寫): 匯出檔案概覽並選擇路徑
        if (input === 'F') {
            setInputMode('export-overview');
            setPathInput('');
            setCursorPosition(0);
            return;
        }

        // 'D': 匯出程式碼 dump
        if (input === 'D') {
            setInputMode('export-code-dump');
            setDumpMode('tree'); // ✅ 預設為目錄結構模式
            setPathInput('');
            setCursorPosition(0);
            return;
        }

        // 'e': 快速匯出
        if (input === 'e') {
            if (focusPane === 'commits') {
                const commit = commits[commitFocusIndex];
                if (commit) {
                    handleExportCommits(getCommitFileName(commit.hash));
                }
            } else {
                handleExportSingle();
            }
            return;
        }
    });

    // 準備渲染資料 (Slice)
    // 左側清單 Slice (文件列表高度為 mainAreaHeight * 2/4)
    const filesPaneHeight = Math.floor(mainAreaHeight * 2 / 4);
    const visibleItems = allItems.slice(listScrollTop, listScrollTop + filesPaneHeight);

    // 右側 Diff Slice
    const diffLines = diffContent.split('\n');
    const visibleDiff = diffLines.slice(diffScrollTop, diffScrollTop + mainAreaHeight).join('\n');
    const diffProgress = diffLines.length > 0
        ? Math.floor((diffScrollTop / Math.max(1, diffLines.length - mainAreaHeight + 1)) * 100)
        : 0;

    return (
        <Box width="100%" height={adjustedRows} flexDirection="column">
            {(inputMode === 'export-path' || inputMode === 'export-overview' || inputMode === 'export-code-dump') ? (
                // ===== 路徑輸入模式（全屏替換） =====
                <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
                    <Box
                        flexDirection="column"
                        borderStyle="round"
                        borderColor="cyan"
                        paddingX={2}
                        paddingY={1}
                        width={Math.min(80, columns - 4)}
                    >
                        <Text bold color="cyan">
                            {inputMode === 'export-path' && 'Export Diff to File'}
                            {inputMode === 'export-overview' && 'Export File Overview'}
                            {inputMode === 'export-code-dump' && 'Export Code Dump'}
                        </Text>
                        
                        {/* ✅ 顯示當前 dump 模式 */}
                        {inputMode === 'export-code-dump' && (
                            <Box marginTop={1}>
                                <Text dimColor>Mode: </Text>
                                <Text color="yellow">
                                    {dumpMode === 'flat' ? '扁平化 (Flat)' : '目錄結構 (Tree)'}
                                </Text>
                                <Text dimColor> - Press Tab to switch</Text>
                            </Box>
                        )}
                        
                        {/* ✅ 完全重寫：使用單一 Text 組件 */}
                        <Box marginTop={1}>
                            <Text dimColor>Path: </Text>
                            <Text>
                                {(() => {
                                    // 建立完整字串，不使用嵌套 Text
                                    const before = pathInput.slice(0, cursorPosition);
                                    const cursorChar = cursorPosition < pathInput.length 
                                        ? pathInput[cursorPosition] 
                                        : ' ';
                                    const after = pathInput.slice(cursorPosition + 1);
                                    
                                    // 如果路徑為空，顯示提示
                                    if (pathInput.length === 0) {
                                        let defaultName = '';
                                        if (inputMode === 'export-path') {
                                            // 需要檢查 focusPane，但這裡無法訪問，所以用通用提示
                                            defaultName = 'diff_YYYYMMDD_HHMMSS.txt';
                                        }
                                        else if (inputMode === 'export-overview') defaultName = 'files_overview_YYYYMMDD_HHMMSS.txt';
                                        else if (inputMode === 'export-code-dump') {
                                            // ✅ 兩種模式都是同一個目錄，只是內部結構不同
                                            defaultName = './code_dump_YYYYMMDD_HHMMSS/';
                                        }
                                        
                                        return (
                                            <>
                                                <Text inverse> </Text>
                                                <Text dimColor> (default: {defaultName})</Text>
                                            </>
                                        );
                                    }
                                    
                                    return (
                                        <>
                                            {before}
                                            <Text inverse>{cursorChar}</Text>
                                            {after}
                                        </>
                                    );
                                })()}
                            </Text>
                        </Box>

                        <Box marginTop={1}>
                            <Text color="yellow">
                                {inputMode === 'export-path' && focusPane === 'commits' && 
                                    (selectedCommits.size > 0 
                                        ? `${selectedCommits.size} commit(s) selected` 
                                        : 'Current commit')}
                                {inputMode === 'export-path' && focusPane === 'files' && 
                                    `${selectedPaths.size} file(s) selected`}
                                {inputMode === 'export-overview' && 'All Git tracked files'}
                                {inputMode === 'export-code-dump' && 'Merge C++ & export all files'}
                            </Text>
                        </Box>

                        {/* ✅ 額外提示：會建立時間戳子目錄 */}
                        {inputMode === 'export-code-dump' && pathInput.length > 0 && (
                            <Box marginTop={1}>
                                <Text dimColor>
                                    → Will create: {pathInput}/code_dump_YYYYMMDD_HHMMSS/
                                </Text>
                            </Box>
                        )}

                        <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                            <Text dimColor>
                                Enter: Export  |  
                                {inputMode === 'export-code-dump' && ' Tab: Switch Mode  |  '}
                                Ctrl-V: Paste  |  Ctrl-U: Clear  |  Esc: Cancel
                            </Text>
                        </Box>
                    </Box>
                </Box>
            ) : (
                // ===== 正常瀏覽模式（原有內容） =====
                <Box flexGrow={1} flexDirection="row">
                    {/* 左欄: 1/3 寬度，分為文件列表(2/3)、commit列表(1/3)、Footer(hug content) */}
                    <Box width="33%" borderStyle="single" borderColor="gray" flexDirection="column">
                        {/* 上半部: 文件列表 (2/3 剩餘高度) */}
                        <Box flexDirection="column" flexGrow={2}>
                            {/* Header */}
                            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                                <Text bold color="cyan">
                                    Files [{focusPane === 'files' ? '●' : '○'}]
                                </Text>
                                <Text color="gray"> ({viewMode}) </Text>
                                <Text color="yellow">
                                    {selectedPaths.size > 0 ? `[${selectedPaths.size} selected]` : ''}
                                </Text>
                            </Box>
                            
                            {/* Content */}
                            <Box flexDirection="column" paddingX={1} flexGrow={1}>
                                {visibleItems.length === 0 ? (
                                    <Text dimColor>No changes.</Text>
                                ) : (
                                    visibleItems.map((item, i) => {
                                        const realIndex = listScrollTop + i;
                                        const isFocused = focusPane === 'files' && realIndex === selectedIndex;
                                        const bgColor = isFocused ? 'blue' : undefined;

                                        if (item.type === 'group') {
                                            return (
                                                <Box key={`group-${item.label}`}>
                                                    <Text {...(bgColor ? { backgroundColor: bgColor } : {})} bold>
                                                        ▼ {item.label} ({item.count})
                                                    </Text>
                                                </Box>
                                            );
                                        } else if (item.type === 'directory') {
                                            const isCollapsed = collapsedDirs.has(item.node.path);
                                            const indent = '  '.repeat(item.node.depth);
                                            const icon = isCollapsed ? '▶' : '▼';

                                            return (
                                                <Box key={item.node.path}>
                                                    <Text {...(bgColor ? { backgroundColor: bgColor } : {})} color="cyan">
                                                        {indent}{icon} {item.node.name}/
                                                    </Text>
                                                </Box>
                                            );
                                        } else {
                                            const { file, group } = item;
                                            const isSelected = selectedPaths.has(file.path);
                                            const checkMark = isSelected ? '✓' : ' ';
                                            const indent = viewMode === 'tree' && item.node
                                                ? '  '.repeat(item.node.depth)
                                                : '';

                                            let statusColor = 'white';
                                            if (file.status === '?' || file.status === '??') statusColor = 'green';
                                            if (file.status.includes('M')) statusColor = 'yellow';
                                            if (file.status.includes('D')) statusColor = 'red';

                                            return (
                                                <Box key={file.path}>
                                                    <Text {...(bgColor ? { backgroundColor: bgColor } : {})}>
                                                        {indent}
                                                        <Text color={isSelected ? 'green' : 'gray'}>[{checkMark}]</Text>
                                                        <Text color={statusColor}> {file.status.trim().padEnd(2)} </Text>
                                                        <Text>{viewMode === 'tree' ? file.path.split('/').pop() || file.path : file.path}</Text>
                                                    </Text>
                                                </Box>
                                            );
                                        }
                                    })
                                )}
                            </Box>
                        </Box>
                        
                        {/* 中間部: Commit 列表 (1/3 剩餘高度) */}
                        <Box flexDirection="column" flexGrow={1}>
                            {/* Header */}
                            <Box borderStyle="single" borderColor="magenta" paddingX={1}>
                                <Text bold color="magenta">
                                    Commits [{focusPane === 'commits' ? '●' : '○'}]
                                </Text>
                                <Text color="yellow">
                                    {selectedCommits.size > 0 ? `[${selectedCommits.size} selected]` : ''}
                                </Text>
                            </Box>
                            
                            {/* Content */}
                            <Box flexDirection="column" paddingX={1} flexGrow={1}>
                                {commits
                                    .slice(
                                        commitScrollOffset,
                                        commitScrollOffset + Math.floor(mainAreaHeight / 4)
                                    )
                                    .map((commit, idx) => {
                                        const actualIndex = commitScrollOffset + idx;
                                        const isFocused = focusPane === 'commits' && actualIndex === commitFocusIndex;
                                        const isSelected = selectedCommits.has(commit.hash);
                                        
                                        // 計算可用寬度（左側面板 33%，減去 padding 和 hash 等）
                                        const availableWidth = Math.floor((columns * 0.33) - 20); // 預留空間給 hash、選擇標記等
                                        const truncatedMessage = commit.message.length > availableWidth
                                            ? commit.message.slice(0, availableWidth - 3) + '...'
                                            : commit.message;
                                        
                                        return (
                                            <Box key={commit.hash}>
                                                <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
                                                    {isFocused ? '>' : ' '}
                                                    {isSelected ? '[✓] ' : '[ ] '}
                                                </Text>
                                                <Text color={isFocused ? 'yellow' : 'gray'}>
                                                    {commit.hash}
                                                </Text>
                                                <Text color={isFocused ? 'white' : 'gray'}>
                                                    {' '}
                                                    {truncatedMessage}
                                                </Text>
                                            </Box>
                                        );
                                    })}
                            </Box>
                        </Box>
                        
                        {/* 底部: Footer 鍵位映射 (hug content) */}
                        <Box borderStyle="single" borderColor="gray" paddingX={0} paddingY={0}>
                            <Text color="gray" dimColor>
                                ↑↓:Nav Space:Select E:Export e:Quick r:Refresh /:Toggle Tab:Switch q:Quit
                            </Text>
                        </Box>
                    </Box>

                    {/* 右欄: Diff 預覽 (2/3 寬度) */}
                    <Box width="67%" borderStyle="single" flexDirection="column">
                        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
                            <Text color="yellow" bold>
                                {focusPane === 'commits' 
                                    ? (commits[commitFocusIndex] ? `${commits[commitFocusIndex].hash} - ${commits[commitFocusIndex].message}` : 'No commit')
                                    : (currentFile?.path || 'No file')}
                            </Text>
                            {diffLines.length > mainAreaHeight && (
                                <Text dimColor> {diffProgress}%</Text>
                            )}
                        </Box>

                        <Box flexGrow={1} paddingX={1}>
                            <Text>{visibleDiff}</Text>
                        </Box>

                        <Box borderStyle="single" paddingX={1}>
                            <Text dimColor>PgUp/PgDn: Scroll Diff</Text>
                        </Box>
                    </Box>
                </Box>
            )}
            
            {exportStatus && (
                <Box paddingX={1} paddingY={1}>
                    <Text>{exportStatus}</Text>
                </Box>
            )}
        </Box>
    );
};


