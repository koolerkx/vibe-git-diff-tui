import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { GitService } from '../git/GitService.js';
import type { GitChange } from '../git/types.js';

// 初始化 Git 服務
const git = new GitService({ cwd: process.cwd() });

// 固定捲動單位（行數）
const SCROLL_LINES = 15;

// 統一列表項目類型
type ListItem = 
  | { type: 'group'; label: string; count: number }
  | { type: 'file'; file: GitChange; group: 'unstaged' | 'staged'; node?: TreeNode }
  | { type: 'directory'; node: TreeNode };

// 顯示模式
type ViewMode = 'flat' | 'tree';

// 輸入模式
type InputMode = 'normal' | 'export-path';

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

// 時間戳檔案名生成函數
function getTimestampedFileName(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    // 格式: diff_20251228_211945.txt (適合排序)
    return `diff_${year}${month}${day}_${hours}${minutes}${seconds}.txt`;
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

    // 列表焦點 index
    const [selectedIndex, setSelectedIndex] = useState(0);

    // 捲動狀態
    const [listScrollTop, setListScrollTop] = useState(0);
    const [diffScrollTop, setDiffScrollTop] = useState(0);

    // 統一多選狀態（用 path 作為 key）
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

    // 顯示模式
    const [viewMode, setViewMode] = useState<ViewMode>('flat');

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
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName());
                }
            } catch {
                // 檔案不存在，檢查是否沒有副檔名
                if (path.extname(resolvedPath) === '') {
                    // ✅ 可能是目錄，使用時間戳檔案名
                    resolvedPath = path.join(resolvedPath, getTimestampedFileName());
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
    }, [selectedIndex]);

    // 載入 Diff
    useEffect(() => {
        const fetchDiff = async () => {
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
        };
        
        fetchDiff();
    }, [currentFile, currentGroup]);

    // 鍵盤操作
    useInput((input, key) => {
        // ============ 路徑輸入模式 ============
        if (inputMode === 'export-path') {
            // ESC: 取消輸入
            if (key.escape) {
                setInputMode('normal');
                setPathInput(''); // ✅ 重置為空
                setCursorPosition(0);
                return;
            }

            // Enter: 確認匯出
            if (key.return) {
                setInputMode('normal');
                // ✅ 使用時間戳檔案名
                const finalPath = pathInput.trim() === '' ? `./${getTimestampedFileName()}` : pathInput;
                handleExportMultiple(finalPath);
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

        // '/' 切換顯示模式
        if (input === '/') {
            setViewMode(prev => prev === 'flat' ? 'tree' : 'flat');
            setSelectedIndex(0);
            setListScrollTop(0);
            return;
        }

        // 上移
        if (key.upArrow) {
            setSelectedIndex(prev => {
                const nextIndex = Math.max(prev - 1, 0);
                // 自動捲動
                if (nextIndex < listScrollTop) {
                    setListScrollTop(nextIndex);
                }
                return nextIndex;
            });
        }

        // 下移
        if (key.downArrow) {
            setSelectedIndex(prev => {
                const nextIndex = Math.min(prev + 1, allItems.length - 1);
                // 自動捲動
                if (nextIndex >= listScrollTop + mainAreaHeight) {
                    setListScrollTop(nextIndex - mainAreaHeight + 1);
                }
                return nextIndex;
            });
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

        // Space: 勾選檔案或分組全選
        if (input === ' ') {
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
            if (selectedPaths.size === 0) {
                setExportStatus('No files selected');
                setTimeout(() => setExportStatus(''), 2000);
                return;
            }
            
            setInputMode('export-path');
            setPathInput(''); // ✅ 空白開始
            setCursorPosition(0); // ✅ 游標在開頭
            return;
        }

        // 'e': 匯出當前檔案 diff（保持原邏輯）
        if (input === 'e') {
            handleExportSingle();
            return;
        }
    });

    // 準備渲染資料 (Slice)
    // 左側清單 Slice
    const visibleItems = allItems.slice(listScrollTop, listScrollTop + mainAreaHeight);

    // 右側 Diff Slice
    const diffLines = diffContent.split('\n');
    const visibleDiff = diffLines.slice(diffScrollTop, diffScrollTop + mainAreaHeight).join('\n');
    const diffProgress = diffLines.length > 0
        ? Math.floor((diffScrollTop / Math.max(1, diffLines.length - mainAreaHeight + 1)) * 100)
        : 0;

    return (
        <Box width="100%" height={adjustedRows} flexDirection="column">
            {inputMode === 'export-path' ? (
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
                        <Text bold color="cyan">Export Diff to File</Text>
                        
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
                                        return (
                                            <>
                                                <Text inverse> </Text>
                                                <Text dimColor> (default: diff_YYYYMMDD_HHMMSS.txt)</Text>
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
                            <Text color="yellow">{selectedPaths.size} file(s) selected</Text>
                        </Box>

                        <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
                            <Text dimColor>
                                Enter: Export  |  Ctrl-V: Paste  |  Ctrl-U: Clear  |  Esc: Cancel
                            </Text>
                        </Box>
                    </Box>
                </Box>
            ) : (
                // ===== 正常瀏覽模式（原有內容） =====
                <Box flexGrow={1} flexDirection="row">
                    {/* 左欄 */}
                    <Box width="50%" borderStyle="single" flexDirection="column">
                        {/* Header */}
                        <Box borderStyle="single" borderColor="blue" paddingX={1}>
                            <Text color="cyan" bold>Files</Text>
                        </Box>

                        {/* Content */}
                        <Box flexGrow={1} flexDirection="column" paddingX={1}>
                            {visibleItems.length === 0 ? (
                                <Text dimColor>No changes.</Text>
                            ) : (
                                visibleItems.map((item, i) => {
                                    const realIndex = listScrollTop + i;
                                    const isFocused = realIndex === selectedIndex;
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

                        {/* Footer */}
                        <Box borderStyle="single" paddingX={1}>
                            <Text>
                                <Text color="cyan">{viewMode === 'flat' ? 'Files' : 'Tree'}</Text>
                                <Text dimColor> | </Text>
                                <Text color="yellow">
                                    Selected: {selectedPaths.size}/{allItems.filter(item => item.type === 'file').length}
                                </Text>
                                <Text dimColor> | </Text>
                                {exportStatus ? (
                                    <Text color="green">{exportStatus}</Text>
                                ) : (
                                    <Text dimColor>
                                        e:Export E:ExportAll Spc:Select a:All /:Mode {viewMode === 'tree' && 'Enter:Toggle'} q:Quit
                                    </Text>
                                )}
                            </Text>
                        </Box>
                    </Box>

                    {/* 右欄 */}
                    <Box width="50%" borderStyle="single" flexDirection="column">
                        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
                            <Text color="yellow" bold>
                                {currentFile?.path || 'No file'}
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
        </Box>
    );
};


