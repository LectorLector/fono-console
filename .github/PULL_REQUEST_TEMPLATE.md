## What / 做了什麼

<!-- One task = one pull request. Link the issue or the task in docs/plans. / 一個任務一個 PR，請連結 issue 或 docs/plans 的任務。 -->

## Why / 為什麼

## Checks / 檢查

- [ ] `go vet ./...` and `GOOS=windows go vet ./...`
- [ ] `go test ./...` and `node tests/run.mjs`
- [ ] `node tests/ui-sweep.mjs` (if the UI changed / 有改介面時)
- [ ] `node tools/i18n-extract.mjs --missing` prints nothing (new UI text has an English entry in `web/i18n/en.json`) / 新介面文字都有英文
- [ ] `sh scripts/build-docs.sh` was run if `web/` changed / 改了 `web/` 有執行
- [ ] Equalizer APO config text is still ASCII only / EQ APO 設定檔仍是純 ASCII
- [ ] No tokens, `settings.json` or measurement recordings in the diff / 沒有權杖、設定檔或量測錄音
- [ ] DSP maths (`art.js`, `fir.js`, `measure.js`) unchanged, or a test shows before/after numbers / DSP 數學沒改，或附前後數字測試

## Screenshots / 截圖 (optional)
