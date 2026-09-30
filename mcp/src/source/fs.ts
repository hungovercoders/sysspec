import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ArtifactMissingError, Manifest, ServiceEntry, SpecSource } from "./types.js";

export class FsSpecSource implements SpecSource {
  /** Parsed manifests keyed by path, reused while the file's mtime and
   * size are unchanged: edits still show up on the next call, but an
   * untouched suite is not re-parsed on every tool call. */
  private readonly manifestCache = new Map<string, { mtimeMs: number; size: number; manifest: Manifest }>();

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
      const stat = await fs.stat(manifestPath).catch(() => null);
      if (!stat?.isFile()) continue;
      let manifest: Manifest;
      const cached = this.manifestCache.get(manifestPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        manifest = cached.manifest;
      } else {
        let text: string;
        try {
          text = await fs.readFile(manifestPath, "utf-8");
        } catch {
          continue;
        }
        manifest = (parse(text) ?? {}) as Manifest;
        this.manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, manifest });
      }
      const name = manifest.name || dir;
      services.set(name, { name, dir, manifest });
    }
    return services;
  }

  async loadSystem(): Promise<Record<string, unknown> | null> {
    const root = await this.specsDir();
    let text: string;
    try {
      text = await fs.readFile(path.join(root, "system.yaml"), "utf-8");
    } catch {
      return null;
    }
    return (parse(text) ?? null) as Record<string, unknown> | null;
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
