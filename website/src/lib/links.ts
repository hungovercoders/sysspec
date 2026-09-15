// Every external URL the site links to, in one place.
//
// Both deployments now have permanent homes of their own — this site at
// sysspec.dev, the demo Worker (generated spec catalog at /, MCP at /mcp)
// at demo.sysspec.dev — so the URLs are committed here rather than
// arriving as build-time configuration. The environment variables survive
// as overrides for preview deployments, which serve the same pages from a
// *.workers.dev alias; the deploy workflows pass them through when the
// corresponding repository variables are set.
const trim = (url: string | undefined) => (url ? url.replace(/\/$/, '') : '');

export const SITE_URL = trim(process.env.SYSSPEC_SITE_URL) || 'https://sysspec.dev';
export const DEMO_SITE_URL = trim(process.env.SYSSPEC_DEMO_URL) || 'https://demo.sysspec.dev';
export const DEMO_MCP_URL = trim(process.env.SYSSPEC_DEMO_MCP_URL) || `${DEMO_SITE_URL}/mcp`;

// Source, packages and issues still live on GitHub; everything a reader
// is meant to *use* lives on the two domains above.
export const GITHUB_URL = 'https://github.com/hungovercoders/sysspec';
export const NPM_CLI_URL = 'https://www.npmjs.com/package/sysspec';
export const NPM_MCP_URL = 'https://www.npmjs.com/package/sysspec-mcp';
