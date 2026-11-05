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
| `organise.js` | suggestions (accept / dismiss / edit, press-and-hold for a reason), your choices with an offline outbox, and Mail's "Need to know" |
| `icons.js` | the one icon set (inline SVG, follows the theme) |
| `ui.js` | toasts (with Undo) and the reduced-motion check |
| `sw.js` | offline shell, cache first; bump `CACHE` when any file changes, and the app offers "A new version is ready · Reload" |
| `offline.html` | shown only if the app itself can't load with no signal |

Every screen has a loading state (skeletons), an empty state that says what will appear,
and a problem state: offline shows the saved copy with when it was saved; an error has Retry.
Links into the app: `#today`, `#today/tasks`, `#uni/<deadlines|lectures|group|modules|jobs>`, `#mail/<important|forum|noise>`, `#chat`, `#settings`.

`localStorage.apiBase` points the app at a local mock of the GitHub API for testing. Leave it unset in real use.
