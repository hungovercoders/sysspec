import { parse } from "yaml";
import { ArtifactMissingError, Manifest, ServiceEntry, SpecSource } from "./types.js";

/** The JSON written by scripts/bundle-specs.mjs: raw file text keyed by
 * declared artifact path, per service, in sorted-directory order. Raw YAML
 * (not pre-parsed) so both sources go through the identical parse path.
 */
export interface SpecsBundle {
  services: {
    dir: string;
    manifestYaml: string;
    files: Record<string, string>;
  }[];
}

export class BundledSpecSource implements SpecSource {
  private readonly services = new Map<string, ServiceEntry>();
  private readonly files = new Map<string, Record<string, string>>();

  constructor(bundle: SpecsBundle) {
    for (const svc of bundle.services) {
      const manifest = (parse(svc.manifestYaml) ?? {}) as Manifest;
      const name = manifest.name || svc.dir;
      this.services.set(name, { name, dir: svc.dir, manifest });
      this.files.set(name, svc.files);
    }
  }

  async loadServices(): Promise<Map<string, ServiceEntry>> {
    return new Map(this.services);
  }

  async readFile(service: ServiceEntry, relPath: string): Promise<string> {
    const text = this.files.get(service.name)?.[relPath];
    if (text === undefined) {
      throw new ArtifactMissingError(`Declared but missing: ${relPath}`);
    }
    return text;
  }
}
