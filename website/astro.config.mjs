// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The sysspec website: docs for the tool itself (CLI, MCP server, plugin,
// the spec model). Distinct from docs-site/, which renders a spec suite.
// Served at the root of its own Cloudflare Worker (sysspec-site), so no
// base-path handling is needed.
//
// SYSSPEC_SITE_URL (a repository variable, like SYSSPEC_DEMO_URL) is the
// deployed URL: with it set, builds emit a sitemap and canonical/og:url
// tags; without it (local builds) Astro simply skips them.
const siteUrl = (process.env.SYSSPEC_SITE_URL || '').replace(/\/$/, '');

export default defineConfig({
  site: siteUrl || undefined,
  integrations: [
    starlight({
      title: 'sysspec',
      customCss: ['./src/styles/fonts.css', './src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Footer: './src/components/Footer.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light'],
        styleOverrides: { borderRadius: '10px', codeFontFamily: 'var(--ss-font-mono)', codeFontSize: '0.8125rem' },
      },
      head: [
        // og:image must be absolute, so the social card is only advertised
        // when the deployed origin is known (local/preview builds omit it).
        ...(siteUrl
          ? [
              { tag: 'meta', attrs: { property: 'og:image', content: `${siteUrl}/og.png` } },
              { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
            ]
          : []),
        { tag: 'meta', attrs: { name: 'theme-color', content: '#2456e6' } },
      ],
      description:
        'System specs first: AsyncAPI, OpenAPI, ODCS data contracts and Gherkin as enforceable system intent, with deterministic gates.',
      pagefind: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/hungovercoders/sysspec',
        },
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Getting started', link: '/getting-started/' },
        {
          label: 'The model',
          items: [
            { label: 'Services and artifacts', link: '/model/' },
            { label: 'Conventions', link: '/conventions/' },
            { label: 'Gates and CI', link: '/gates-and-ci/' },
          ],
        },
        {
          label: 'Journeys',
          items: [
            { label: 'Implement or consume a service', link: '/implement-and-consume/' },
            { label: 'contracts.lock & .contracts/', link: '/contracts-lock/' },
            { label: 'The live demo', link: '/demo/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI (sysspec)', link: '/cli/' },
            { label: 'MCP server (sysspec-mcp)', link: '/mcp/' },
            { label: 'Claude Code plugin & skills', link: '/plugin-and-skills/' },
            { label: 'Mock example files', link: '/mocks-examples/' },
          ],
        },
      ],
    }),
  ],
});
