# Documentation localization

This guide is for documentation maintainers. English is the source of truth;
Simplified Chinese translations follow the same page paths. All languages share
one VitePress project, dependency set, theme, and static assets.

## Directory structure and URLs

```text
docs/
├── package.json
├── .vitepress/
│   ├── config.ts          # Shared config, locales, and English path rewrites
│   ├── config/
│   │   ├── en.ts          # English navigation, sidebars, and UI text
│   │   └── zh.ts          # Simplified Chinese navigation, sidebars, and UI text
│   └── theme/             # Shared theme
├── public/                # Shared static assets
├── en/                    # English source pages
│   ├── index.md
│   └── guide/
└── zh/                    # Simplified Chinese source pages
    ├── index.md
    └── guide/
```

The site configuration rewrites the `en/` source prefix so English URLs remain
at the site root:

| Source file | Site URL | Path in the npm package |
| --- | --- | --- |
| `docs/en/guide/quickstart.md` | `/guide/quickstart` | `node_modules/void/docs/guide/quickstart.md` |
| `docs/zh/guide/quickstart.md` | `/zh/guide/quickstart` | `node_modules/void/docs/zh/guide/quickstart.md` |

`packages/void/scripts/sync-docs.mjs` maps source paths to published package paths.
Edit `docs/en/` and `docs/zh/` directly; `packages/void/docs/` is generated.

The language menu switches between translations of the current page and preserves
the section anchor. The logo links to the current language's homepage: `/` for
English and `/zh/` for Simplified Chinese.

The shared theme currently hardcodes logo links to `/`. A Vite transform in the
site configuration updates only the two links in its Header component. Review
this compatibility code when upgrading the theme, and remove it once the theme
supports language-specific home links.

## Translation status

| English source | Simplified Chinese source | Status |
| --- | --- | --- |
| `en/index.md` | `zh/index.md` | Shared homepage components, layout, and assets; Chinese text translated and reviewed |
| `en/guide/*.md` | `zh/guide/*.md` | All 28 pages directly in this directory translated and reviewed |
| `en/guide/platform/**/*.md` | `zh/guide/platform/**/*.md` | All 18 installation, administration, and development pages translated and reviewed |
| `en/guide/pages-routing/*.md` | `zh/guide/pages-routing/*.md` | All 8 pages and the layout diagram translated and reviewed |
| `en/guide/database/*.md` | `zh/guide/database/*.md` | All 3 database pages (D1, PostgreSQL, and MySQL) translated and reviewed |
| `en/guide/edge/*.md` | `zh/guide/edge/*.md` | All 6 edge routing, caching, and prerendering pages translated and reviewed |
| `en/guide/email/*.md` | `zh/guide/email/*.md` | All 3 sending, receiving, and domain configuration pages translated and reviewed |
| `en/reference/*.md` | `zh/reference/*.md` | All 5 pages directly in this directory translated and reviewed |
| `en/reference/api/*.md` | `zh/reference/api/*.md` | All 12 API reference pages translated and reviewed |
| `en/reference/cli/*.md` | `zh/reference/cli/*.md` | All 17 CLI command pages translated and reviewed |
| `en/integrations/*.md` | `zh/integrations/*.md` | All 4 pages covering Cloudflare, Hono, Node.js/Bun/Deno, and coding agents translated and reviewed |
| `en/integrations/frameworks/*.md` | `zh/integrations/frameworks/*.md` | The overview, 6 framework guides, and relationship diagram translated and reviewed |

`zh/` mirrors the page and image paths in `en/`. All pages in `guide/` (66),
`reference/` (34), and `integrations/` (11) have been translated. Recheck the
corresponding Chinese pages whenever the English source changes. After each
translation batch, update this table and the Chinese navigation in the same PR.

## Adding or translating pages

- Translate the matching file in `zh/` paragraph by paragraph against `en/`. For new pages, copy the source and supporting assets first.
- Preserve frontmatter settings that affect page behavior; translate titles, descriptions, and body text.
- Maintain localized homepage component text and links in the homepage frontmatter's `homeI18n` field.
- Keep the original English heading anchors in Chinese pages, for example `## 快速开始 {#quick-start}`, so fragment links remain stable.
- Preserve runnable commands, imports, package names, filenames, API names, and paths in code examples.
- Link translated pages to the same language. Keep relative links consistent with the source directory structure.
- Link untranslated destinations to their English site paths, such as `/guide/deployment`, and mark Chinese navigation entries with “英文”.
- Add navigation or sidebar entries in `.vitepress/config/zh.ts`; maintain English navigation in `en.ts`.
- Chinese sidebars inherit the English presentation configuration. Keep translation entries in the same order and hierarchy, localizing only text and links. Maintain icons, collapse state, and grouping in `en.ts`.
- Place shared assets such as images in `docs/public/` and reference them from the site root.
- Update the status table above and check page titles, anchors, internal links, and code examples.

## Keeping translations up to date

When changing an English page, review the Chinese page at the same relative path
in the same PR. Update untranslated English copies directly; review existing
translations paragraph by paragraph and incorporate the source changes.

Start with the English diff, then check the corresponding translated passages,
especially steps, defaults, configuration options, APIs, and examples. When adding
or removing sections, also review the translated table of contents, explicit
anchors, cross-references, and language navigation.

PR descriptions should list the affected English pages, their translations, and
the review result. Briefly note the review even when a source change does not
affect the Chinese meaning. If translation work remains, name the specific pages
and passages rather than treating an existing translation as current.

Keep maintenance notes in the PR or this guide. User-facing pages should focus on
what developers need to use Void.
