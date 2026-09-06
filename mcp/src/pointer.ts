import { pyList, pyRepr, pySorted } from "./pyformat.js";

/** Resolve an RFC 6901 JSON pointer ('/components/schemas/Order') in a
 * parsed document. '~1' escapes '/' and '~0' escapes '~', so an OpenAPI
 * path key looks like '/paths/~1orders~1{order_id}'. A miss raises with
 * the keys available at the deepest level that did resolve.
 *
 * YAML keys that parse as numbers (an unquoted `200:` response code)
 * become string object keys, so a pointer like '/responses/200'
 * resolves.
 */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    throw new Error(
      `section must be a JSON pointer starting with '/': ${pyRepr(pointer)}`,
    );
  }
  let node: unknown = doc;
  let resolved = "";
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isRecord(node) && token in node) {
      node = node[token];
    } else if (Array.isArray(node) && /^\d+$/.test(token) && Number(token) < node.length) {
      node = node[Number(token)];
    } else {
      let available: string[];
      if (isRecord(node)) available = pySorted(Object.keys(node));
      else if (Array.isArray(node)) available = [`indexes 0..${node.length - 1}`];
      else available = [];
      throw new Error(
        `${pyRepr(token)} not found at ${pyRepr(resolved || "/")} in this artifact. ` +
          `Available there: ${pyList(available)}`,
      );
    }
    resolved += "/" + rawToken;
  }
  return node;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
