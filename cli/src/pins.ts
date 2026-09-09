/** Single source for the external tool versions the CLI shells out to,
 * and the sysspec-mcp npm version the init scaffold pins in .mcp.json.
 * datacontract-cli is the one Python tool, run via uvx - the reason uv
 * stays in the scaffolded mise.toml. */

export const SYSSPEC_MCP = "sysspec-mcp@1.0.3";

export const ASYNCAPI_CLI = "@asyncapi/cli@5.0.7";
export const DATACONTRACT_CLI = "datacontract-cli==1.1.1";
export const SPECTRAL_CLI = "@stoplight/spectral-cli@6.16.3";
export const GHERKIN_LINT = "gherkin-lint@4.2.4";
export const MERMAID_CLI = "@mermaid-js/mermaid-cli@11.16.0";
