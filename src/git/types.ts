export type GitChangeStatus =
  | 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B' | '?';

export type GitChange = {
  path: string;
  statusCode: string; // "MM", " M", "??", etc.
  status: string;     // 為了 UI 顯示方便，你可以轉換成單一字母
  oldPath?: string;
};

