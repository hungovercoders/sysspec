// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// The sysspec website: docs for the tool itself (CLI, MCP server, plugin,
// the spec model). Distinct from docs-site/, which renders a spec suite.
// Served at the root of its own Cloudflare Worker (sysspec-site), so no
// base-path handling is needed.
//
// The site's permanent home (kept in step with src/lib/links.ts, which
// astro.config cannot import). SYSSPEC_SITE_URL overrides it for preview
// deployments served from a *.workers.dev alias, so their canonical tags
// and sitemap point at themselves rather than at production.
const siteUrl = (process.env.SYSSPEC_SITE_URL || 'https://sysspec.dev').replace(/\/$/, '');

export default defineConfig({
  site: siteUrl,
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
        // og:image must be absolute, hence the known origin above.
        { tag: 'meta', attrs: { property: 'og:image', content: `${siteUrl}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
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
