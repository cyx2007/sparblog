# sparsity.tech

## Product

- This is a personal technical blog. MIT 6.004 is a visual reference only.
- The user approved B's traditional two-column layout and serif typography with A's blue/gray palette. This is the final design; do not add style switching or comparison pages.
- The user rejected decorative banners, slogans, bilingual labels, matrix display panels, and document-like frontends. Keep normal blog navigation and articles first. The small sparse wordmark/favicon is enough branding.
- The user explicitly chose to retain the six sample articles, clearly labeled as examples. Do not invent biography, social accounts, contacts, or registration numbers.

## Implementation

- Static Astro + TypeScript + Markdown + native CSS. Do not introduce a UI framework, database, CMS or runtime server unless requested.
- Site configuration is in `src/data/site.ts`; layout in `src/layouts/SiteLayout.astro`; all styles in `src/styles/global.css`.
- Editable site description and About Markdown are in `src/data/settings/site.json`. Preserve this directory on server upgrades; changes follow the same save-then-publish workflow as articles.
- Use `src/lib/notes.ts` for every public content surface. Drafts and future posts must not enter generated routes, search, RSS, or sitemap. Dates become public only after rebuilding.
- Examples may appear on the site but must be labeled and excluded from RSS and sitemap. Example-only pages stay noindex; published articles have canonical and article metadata.
- Keep normal links and server-rendered HTML. Search is a small progressive enhancement on the archive page; never replace readable navigation with a JavaScript-only flow.
- Preserve compatibility redirects from the old preview paths. Update both Caddy configurations if routing changes.
- Do not publish or modify DNS without a deployment request. Prepared deployment files are not evidence of a successful Ubuntu deployment.

## Validation

- `npm run verify`: Astro/TypeScript, build, links/assets, canonical, RSS, sitemap and search.
- `npm run test:publishing`: isolated builds for publishing rules, XML escaping, empty content and safe draft creation.
- `npm run format:check`: source formatting.
- For layout changes, check desktop and 390 px mobile, code contrast, horizontal overflow, keyboard focus, normal navigation and search.
- `npm run release` builds a verified static archive with SHA-256. The server needs only Caddy; Docker Compose is an alternative.
