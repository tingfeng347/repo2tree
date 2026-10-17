# Local syntax highlighting

- Source: [highlight.js](https://github.com/highlightjs/highlight.js), installed version 11.12.0; exact dependencies in package-lock.json.
- License: BSD-3-Clause, copied to highlight.LICENSE.
- Build: `npm ci && npm run build:syntax` bundles scripts/highlight-entry.mjs with esbuild into highlight.js (browser ESM). Rebuild the Rust binary afterward because assets are embedded.
- Registered languages: Python, JavaScript/JSX, TypeScript/TSX, HTML/XML, CSS, JSON, Rust, Go, Java and Shell. No automatic language detection, CDN or external runtime requests.
- web/syntax.js handles escaping, bounded caching, multiline state and full plain-text fallback for large source. Highlighting is presentation only, not control-flow language support.
