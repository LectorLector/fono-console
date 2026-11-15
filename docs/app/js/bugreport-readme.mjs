// README.txt inside the bug-report zip: bilingual (zh-TW first, English second), plain text, deliberately kept out of the UI
// dictionary (web/i18n/en.json) because the file carries both languages itself. Pure function; tested in tests/bugreport.test.mjs.
export const FILE_INFO = {
  'README.txt': { zh: '這個壓縮檔裡有什麼', en: 'What is in this zip' },
  'system.json': { zh: '系統資訊、版本、Equalizer APO 狀態', en: 'System info, version, Equalizer APO status' },
  'devices.json': { zh: '音訊裝置清單（裝置 ID 已雜湊）', en: 'Audio device list (device IDs hashed)' },
  'fono_console.txt': { zh: '目前寫給 Equalizer APO 的設定檔（純 ASCII）', en: 'The config currently written for Equalizer APO (ASCII)' },
  'settings.sanitized.json': { zh: '設定（無權杖／密鑰、無聆聽紀錄、無校正曲線、ID 已雜湊）', en: 'Settings (no tokens or secrets, no listening history, no calibration curves, IDs hashed)' },
  'measurements.json': { zh: '最近量測的摘要（電平與濾波器數量；沒有錄音）', en: 'Summaries of the last measurement (levels, filter counts; no audio)' },
  'client-log.txt': { zh: '介面紀錄：警告／錯誤、提示訊息、量測紀錄（最多 500 行）', en: 'UI log: warnings / errors, toasts, measurement log (max 500 lines)' },
  'server-log.txt': { zh: '伺服器紀錄（最後 500 行）', en: 'Server log (last 500 lines)' },
};
export function bugReadme({ version = '', created = '', files = [] } = {}) {
  const list = files.map(f => `  ${f.name.padEnd(26)} ${f.zh}\n  ${''.padEnd(26)} ${f.en}`).join('\n');
  return [
    '﻿Fono Console ' + version + ' - 問題回報包 / bug-report bundle', '='.repeat(72), 'created ' + created, '',
    '【中文】',
    '這個壓縮檔是你按「產生問題回報包」後在這台電腦上產生的；沒有自動上傳到任何地方。',
    '請先打開看看，確認沒有你不想公開的內容，再把檔案附到 GitHub issue（或貼出你覺得相關的部分）。',
    '',
    '保護隱私：沒有任何原始錄音；沒有 Spotify 或其他服務的權杖或密鑰；裝置 ID 已換成固定的雜湊（同一個裝置每次都是同一個代號，但看不出原本的 ID）；',
    'Windows 使用者名稱已換成 <user>。喇叭名稱、房間尺寸、你自己填的文字仍在裡面。',
    '', 'English',
    'This zip was created on your computer when you pressed "Generate bug-report bundle"; nothing was uploaded.',
    'Please look inside, make sure nothing is in it that you do not want to share, then attach it to the GitHub issue (or paste only the parts that matter).',
    '',
    'Privacy: no raw audio; no Spotify / service tokens or secrets; device IDs are replaced by stable hashes (the same device always gets the same code, the real ID cannot be read back);',
    'the Windows user name is replaced by <user>. Speaker names, room size and any text you typed are still there.',
    '', 'Files:', list, '',
  ].join('\n');
}
