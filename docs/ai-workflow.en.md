# Developing Fono Console with several AIs (for beginners)

[English](ai-workflow.en.md) | [繁體中文](ai-workflow.zh-TW.md)

## The short version
- **Claude (me)**: planning, architecture, DSP maths, reviewing code written by others.
- **Google Antigravity (Gemini 3.1 Pro)**: implements the plan file one item at a time, edits the UI, writes the English version, writes documentation.
- **Gemini chat (a separate account)**: research, translation, writing announcement copy.
- **GitHub is the hand-off**: plans live in `docs/plans/*.md`, rules in `AGENTS.md`, one branch and one Pull Request per task, and I read the diff before deciding whether to merge.

## What changed in 2026
- On 2026-06-18 Google stopped letting AI Pro subscribers use **Gemini CLI** and moved to **Antigravity CLI (command `agy`)**. Gemini CLI now only works with a paid API key.
- Using subscription quota through third-party tools (proxies, wrappers) can get your account **suspended**, and alternating between two accounts to get around quota limits also breaks the terms. So:
  - Do not install unofficial plugins that "plug Gemini into Claude".
  - Use one account for coding (Antigravity) and the other for chat research; do not rotate them automatically.
- I cannot call Gemini directly, and I never touch your passwords or keys. The "messenger" between us is files on GitHub.

## What the three tools are
| Tool | What it is | Good for |
|---|---|---|
| Claude Code | Claude in the terminal (the black command window); can read and edit a whole folder and run commands | Big changes, debugging, review |
| Antigravity | Google's AI code editor (like VS Code): files on the left, the AI agent on the right | Implementing from a plan, tweaking the UI while looking at the screen |
| CLI | Command Line Interface: operating by typing commands | Automation, quick runs |

## A standard round
1. I write the tasks in `docs/plans/phaseN.md` (which files to change, how to check).
2. You open the project folder in Antigravity and tell it:
   `Read AGENTS.md and docs/plans/phaseN.md, do only Task 2, create a new branch task2, and tell me the check results when done.`
3. When it finishes, you press "Commit" and "Push", then open a Pull Request on GitHub.
4. Come back and tell me "look at PR #3". I read the diff and point out problems or say it can be merged.
5. After merging, GitHub Actions builds the new release and updates the tutorial site automatically.

## Tips to save Claude Code quota
- `/model opusplan`: Opus plans, Sonnet does the work, switching automatically.
- `/compact`: compress a long conversation.
- `/clear`: empty the context when starting a new task so old content is not re-read again and again.
- Put fixed rules in `CLAUDE.md` / `AGENTS.md` so you do not repeat them every time.

## Common commands (the GitHub tutorial will cover them later)
```sh
git clone https://github.com/your-account/fono-console   # download someone's project
git checkout -b task2                                    # create a new branch
git add . && git commit -m "description"                 # save a version
git push                                                 # upload to GitHub
```
