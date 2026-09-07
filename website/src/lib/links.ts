// Every external URL the site links to, in one place.
//
// The live demo (the sysspec-demo Worker: generated spec catalog at /, MCP
// at /mcp) is a separate deployment whose URL is not committed anywhere in
// this repo, so it arrives as build-time environment variables — set as
// GitHub Actions repository variables in the deploy workflows. Until they
// are set, the links fall back to the corresponding place on GitHub so the
// build never breaks and never points at a dead URL.
export const GITHUB_URL = 'https://github.com/hungovercoders/sysspec';
export const NPM_CLI_URL = 'https://www.npmjs.com/package/sysspec';
export const NPM_MCP_URL = 'https://www.npmjs.com/package/sysspec-mcp';

export const DEMO_SITE_URL =
  process.env.SYSSPEC_DEMO_URL || `${GITHUB_URL}/tree/main/specs`;
export const DEMO_MCP_URL =
  process.env.SYSSPEC_DEMO_MCP_URL || `${GITHUB_URL}/blob/main/deploy/README.md`;

// True only when the real demo URLs were provided at build time; pages use
// this to phrase the link honestly ("live demo" vs "specs on GitHub").
export const DEMO_IS_LIVE = Boolean(process.env.SYSSPEC_DEMO_URL);
