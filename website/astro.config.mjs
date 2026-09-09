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
export default defineConfig({
  site: process.env.SYSSPEC_SITE_URL || undefined,
  integrations: [
    starlight({
      title: 'sysspec',
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
