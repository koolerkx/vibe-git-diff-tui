#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';

// 手動進入 Alternate Screen Buffer
// 這是 Warp/iTerm2/大部分終端機識別「全螢幕應用」的標準方式
process.stdout.write('\x1b[?1049h'); // Enter alternate screen
process.stdout.write('\x1b[2J');      // Clear screen
process.stdout.write('\x1b[H');       // Move cursor to home

// 確保 stdin 進入 raw mode
if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
}

// 渲染
const { waitUntilExit, clear } = render(<App />, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
});

// 退出時恢復 Main Screen Buffer
waitUntilExit().then(() => {
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
    }
    process.exit(0);
});
