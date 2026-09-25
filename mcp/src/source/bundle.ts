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
  /** Raw text of the suite's system.yaml; absent in older bundles. */
  systemYaml?: string | null;
}

export class BundledSpecSource implements SpecSource {
  private readonly services = new Map<string, ServiceEntry>();
  private readonly files = new Map<string, Record<string, string>>();
  private readonly system: Record<string, unknown> | null;

  constructor(bundle: SpecsBundle) {
    for (const svc of bundle.services) {
      const manifest = (parse(svc.manifestYaml) ?? {}) as Manifest;
      const name = manifest.name || svc.dir;
      this.services.set(name, { name, dir: svc.dir, manifest });
      this.files.set(name, { ...svc.files, "service.yaml": svc.manifestYaml });
    }
    this.system = bundle.systemYaml
      ? ((parse(bundle.systemYaml) ?? null) as Record<string, unknown> | null)
      : null;
  }

  async loadSystem(): Promise<Record<string, unknown> | null> {
    return this.system;
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
