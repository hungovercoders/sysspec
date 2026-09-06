/** Where the specs come from. Everything the tools read goes through this
 * interface: a filesystem tree locally (stdio / node HTTP), or a bundle
 * baked at build time (the Cloudflare Worker adapter, or anywhere else a
 * filesystem is awkward). The declared-artifact check — the primary
 * confinement guard — lives in core, which owns its error wording; a
 * source only enforces "stay inside the service directory" and "the file
 * actually exists".
 */

export interface ArtifactMeta {
  kind: string;
  path: string;
  version?: string;
  gated?: boolean;
  summary?: string;
  [key: string]: unknown;
}

export interface Manifest {
  name?: string;
  title?: string;
  domain?: string;
  owner?: string;
  summary?: string;
  produces?: string[];
  consumes?: string[];
  artifacts?: ArtifactMeta[];
  [key: string]: unknown;
}

export interface ServiceEntry {
  /** manifest.name, falling back to the directory name. */
  name: string;
  /** The directory name under the specs root. */
  dir: string;
  manifest: Manifest;
}

/** A declared artifact whose file is absent — search skips these. */
export class ArtifactMissingError extends Error {}

export interface SpecSource {
  /** All services keyed by name, in sorted-directory order (the order the
   * Python server's sorted glob produced). Filesystem sources re-read on
   * every call so spec edits show up without a server restart. */
  loadServices(): Promise<Map<string, ServiceEntry>>;
  /** Raw text of a file under a service's directory. */
  readFile(service: ServiceEntry, relPath: string): Promise<string>;
}
