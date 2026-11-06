# Instructions for AI coding agents (Claude Code, Antigravity, Codex…)

Project: Fono Console — Windows audio console on Equalizer APO. Go server (`main.go`, `setup*.go`) + plain ES-module UI in `web/` (no npm, no build step), tutorial site in `docs/` (`docs/app/` is a copy of `web/`, refresh with `scripts/build-docs.sh`).

## Rules
- UI text is Traditional Chinese (zh-TW). Keep the look: low-saturation hardware panels, lit ON/OFF keys, no decorative shapes. Append CSS at the END of `web/style.css`, use existing tokens (`--panel --ink --accent` …).
- No new dependencies (Go modules or JS libraries). No runtime network calls except the existing ones.
- Equalizer APO config text must stay ASCII only.
- Experimental features go behind a `lab: true` entry in `FEATURES` (web/js/app.js), default off.
- Work on a git branch per task; one task = one pull request. Don't touch files outside the task.

## Where tasks come from
`docs/plans/*.md` — each file lists numbered tasks with the files to edit and the checks to run. Do one task, run its checks, report pass/fail in the PR description.

## Checks
```sh
go vet ./... && go build -o /tmp/fono .
node --check web/js/<file>.js
go run . --demo        # UI with simulated devices at http://127.0.0.1:47811
go vet ./... && go test ./... && node tests/run.mjs   # unit tests (no npm deps); same as CI
node tests/ui-sweep.mjs   # optional browser sweep: needs `playwright` (npm i -g playwright) and Chromium; skips if missing
```

## Don't
- Don't change DSP maths in `web/js/art.js`, `fir.js`, `measure.js` without a test showing before/after numbers.
- Don't commit secrets, tokens, `settings.json`, or measurement recordings.
