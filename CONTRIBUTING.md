# Contributing / 參與貢獻

Thanks for helping! 謝謝你的幫忙！

## English

**Testers** (the most useful thing you can do):
- Hit a problem? In the app open *Settings → Bug report → Generate bug-report bundle*, look inside the zip, and open a [bug report](https://github.com/LectorLector/fono-console/issues/new/choose) with it attached. It has no recordings or tokens; device IDs are hashed.
- Measured your room? Use the *Share a measurement* form with before/after screenshots, room, speakers and microphone.
- Questions and ideas: [Discussions](https://github.com/LectorLector/fono-console/discussions).

**Code** (see [AGENTS.md](AGENTS.md) for the full rules):
- Go server + plain ES modules in `web/`; no npm, no new dependencies, no build step. Run it with `go run . --demo`.
- UI text is Traditional Chinese in the code, English in `web/i18n/en.json` (`node tools/i18n-extract.mjs --missing` must print nothing). The Equalizer APO config text must stay ASCII.
- One task = one branch = one pull request. Don't touch DSP maths (`art.js`, `fir.js`, `measure.js`) without a test with before/after numbers.
- Before you push: `go vet ./... && GOOS=windows go vet ./... && go test ./... && node tests/run.mjs` (and `node tests/ui-sweep.mjs` if you changed the UI; it needs Playwright and Chromium), then `sh scripts/build-docs.sh` if `web/` changed.
- Never commit tokens, `settings.json` or measurement recordings.

## 繁體中文

**測試者**（最有幫助的事）：
- 遇到問題？在程式裡開「設定 → 問題回報 → 產生問題回報包」，看過 zip 的內容後，開一個[問題回報](https://github.com/LectorLector/fono-console/issues/new/choose)並附上。裡面沒有錄音或權杖，裝置 ID 已雜湊。
- 量測了你的房間？用「分享量測結果」表單，附上校正前後截圖、房間、喇叭與麥克風。
- 問題與想法：到 [Discussions](https://github.com/LectorLector/fono-console/discussions)。

**程式碼**（完整規則見 [AGENTS.md](AGENTS.md)）：
- Go 伺服器＋`web/` 的純 ES 模組；不用 npm、不加新依賴、沒有建置步驟。用 `go run . --demo` 執行。
- 介面文字在程式裡寫繁體中文，英文放 `web/i18n/en.json`（`node tools/i18n-extract.mjs --missing` 必須沒有輸出）。Equalizer APO 設定檔文字必須維持純 ASCII。
- 一個任務一個分支一個 PR。沒有附前後數字的測試，不要動 DSP 數學（`art.js`、`fir.js`、`measure.js`）。
- 推送前：`go vet ./... && GOOS=windows go vet ./... && go test ./... && node tests/run.mjs`（改了介面再跑 `node tests/ui-sweep.mjs`，需要 Playwright 與 Chromium），改了 `web/` 就執行 `sh scripts/build-docs.sh`。
- 絕不提交權杖、`settings.json` 或量測錄音。
