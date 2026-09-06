import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ArtifactMissingError, Manifest, ServiceEntry, SpecSource } from "./types.js";

export class FsSpecSource implements SpecSource {
  constructor(private readonly rawSpecsDir: string | undefined) {}

  private async specsDir(): Promise<string> {
    if (!this.rawSpecsDir) {
      throw new Error(
        "SPECS_DIR is not set. In a plugin this is wired up in " +
          ".mcp.json as ${CLAUDE_PLUGIN_ROOT}/specs.",
      );
    }
    const root = path.resolve(this.rawSpecsDir);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`SPECS_DIR does not exist: ${root}`);
    }
    return root;
  }

  async loadServices(): Promise<Map<string, ServiceEntry>> {
    const root = await this.specsDir();
    const services = new Map<string, ServiceEntry>();
    const entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const dir of entries) {
      const manifestPath = path.join(root, dir, "service.yaml");
      let text: string;
      try {
        text = await fs.readFile(manifestPath, "utf-8");
      } catch {
        continue;
      }
      const manifest = (parse(text) ?? {}) as Manifest;
      const name = manifest.name || dir;
      services.set(name, { name, dir, manifest });
    }
    return services;
  }

  async readFile(service: ServiceEntry, relPath: string): Promise<string> {
    const root = await this.specsDir();
    const serviceRoot = path.join(root, service.dir);
    const candidate = path.resolve(serviceRoot, relPath);
    const rel = path.relative(path.resolve(serviceRoot), candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Refusing to read outside ${service.name}: ${relPath}`);
    }
    try {
      return await fs.readFile(candidate, "utf-8");
    } catch {
      throw new ArtifactMissingError(`Declared but missing: ${relPath}`);
    }
  }
}
