# Life

The front end of a personal organiser. Plain HTML, CSS and JavaScript modules,
no build step: GitHub Pages serves this folder as-is.

**Nothing personal is in this repo.** All data lives in a separate private repo
(`life-data`), read and written through the GitHub API with a fine-grained token
stored only in the browser on each device. The chat calls Gemini directly with a
key that is also stored only on the device.

| File | Does |
|---|---|
| `app.js` | the screens: Today, Uni, Mail, Chat, Settings, plus the reader and Delegate dialog |
| `gh.js` | every read and write to the private data repo; uploads split big files into chunks |
| `ai.js` | the chat: Gemini with tools, model and effort choice |
| `md.js` | a small, escaping Markdown renderer |
| `sw.js` | offline shell; bump `CACHE` when files change |

`localStorage.apiBase` points the app at a local mock of the GitHub API for testing. Leave it unset in real use.
