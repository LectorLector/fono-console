# 用多個 AI 一起開發 Fono Console（給初學者）

[English](ai-workflow.en.md) | [繁體中文](ai-workflow.zh-TW.md)

## 先講結論
- **Claude（我）**：規劃、架構、DSP 數學、審查別人寫的程式。
- **Google Antigravity（Gemini 3.1 Pro）**：照計畫檔一項一項實作、改 UI、翻英文版、寫文件。
- **Gemini 聊天（另一個帳號）**：查資料、翻譯、寫發表文案。
- **交接靠 GitHub**：計畫寫在 `docs/plans/*.md`，規則寫在 `AGENTS.md`，每項工作一個分支、一個 Pull Request，我看差異（diff）再決定要不要合併。

## 重要變化（2026 年）
- Google 已在 2026-06-18 停止讓 AI Pro 訂閱者用 **Gemini CLI**，改成 **Antigravity CLI（指令 `agy`）**。Gemini CLI 現在只能用付費 API 金鑰。
- 用第三方工具（代理、包裝程式）去用訂閱額度會被**停權**；用兩個帳號輪流繞過額度限制也違反條款。所以：
  - 不要裝什麼「把 Gemini 接進 Claude」的非官方外掛。
  - 一個帳號寫程式（Antigravity），另一個做聊天研究就好，不要自動輪替。
- 我不能直接呼叫 Gemini，也不碰你的帳號密碼和金鑰。我們之間的「傳話筒」就是 GitHub 上的檔案。

## 三個工具是什麼
| 工具 | 是什麼 | 適合 |
|---|---|---|
| Claude Code | 在終端機（黑色命令視窗）裡的 Claude，能讀改整個資料夾、跑指令 | 大改動、除錯、審查 |
| Antigravity | Google 的 AI 程式編輯器（像 VS Code），左邊檔案、右邊 AI 代理 | 照計畫實作、看畫面改 UI |
| CLI | Command Line Interface，用打字下指令的方式操作 | 自動化、快速執行 |

## 一次標準流程
1. 我在 `docs/plans/phaseN.md` 寫好任務（要改哪些檔、怎麼檢查）。
2. 你在 Antigravity 開啟專案資料夾，跟它說：
   `請閱讀 AGENTS.md 和 docs/plans/phaseN.md，只做 Task 2，開新分支 task2，做完跑檢查並告訴我結果。`
3. 它改完後，你按「提交」（commit）和「推送」（push），在 GitHub 上開 Pull Request。
4. 回來跟我說「看 PR #3」，我讀差異、指出問題或說可以合併。
5. 合併後，GitHub Actions 自動打包新版本、更新教學網站。

## Claude Code 省額度小技巧
- `/model opusplan`：Opus 負責想、Sonnet 負責做，自動切換。
- `/compact`：對話太長時壓縮。
- `/clear`：換新任務時清空，避免舊內容一直被重讀。
- 把固定規則寫在 `CLAUDE.md`／`AGENTS.md`，不用每次重講。

## 常用指令（之後 GitHub 教學會細講）
```sh
git clone https://github.com/你的帳號/fono-console   # 下載別人的專案
git checkout -b task2                              # 開新分支
git add . && git commit -m "說明"                  # 存一個版本
git push                                           # 上傳到 GitHub
```
