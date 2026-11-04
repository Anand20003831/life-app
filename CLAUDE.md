# life-app

Front end of a personal organiser. Plain ES modules, no build step; GitHub Pages
serves `main` as-is, so a push is a deploy. **This repo is public: never add
personal data, names, keys or tokens.**

All data lives in the private repo `Anand20003831/life-data`. Its `docs/` folder
(README, APP, ARCHITECTURE, RUNBOOK, TRAPS) explains the system; read it if this
session can see that repo.

- `app.js` screens · `gh.js` GitHub API · `ai.js` Gemini chat + tools · `md.js` renderer · `sw.js` offline cache.
- Bump `CACHE` in `sw.js` whenever any shipped file changes.
- Test locally with a mock: set `localStorage.apiBase` to a local server that mimics
  the GitHub contents API (see TRAPS: never paste real tokens into a test browser).
- `node --check` every changed .js file before pushing.
- Commit messages end with: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
