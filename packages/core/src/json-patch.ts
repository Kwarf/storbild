/** An RFC 6902 operation. Only the operations that `diff` produces are supported. */
export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };

export class JsonPatchError extends Error {
  override name = "JsonPatchError";
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the operations that turn `before` into `after`, at the narrowest paths. Objects are
 * compared key by key. Arrays of equal length are compared index by index; otherwise the whole
 * array is replaced. Properties whose value is `undefined` count as absent, as in JSON.
 */
export function diff(before: unknown, after: unknown, path = ""): JsonPatchOp[] {
  if (before === after) return [];
  if (isObject(before) && isObject(after)) {
    const ops: JsonPatchOp[] = [];
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) continue;
      const childPath = `${path}/${escapePointerToken(key)}`;
      if (after[key] === undefined) ops.push({ op: "remove", path: childPath });
      else ops.push(...diff(value, after[key], childPath));
    }
    for (const [key, value] of Object.entries(after)) {
      if (value !== undefined && before[key] === undefined) {
        ops.push({ op: "add", path: `${path}/${escapePointerToken(key)}`, value });
      }
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((value, i) => diff(value, after[i], `${path}/${i}`));
  }
  return [{ op: "replace", path, value: after }];
}

function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new JsonPatchError(`invalid JSON pointer: ${path}`);
  return path.slice(1).split("/").map(unescapePointerToken);
}

function arrayIndex(array: unknown[], token: string, allowEnd: boolean): number {
  if (allowEnd && token === "-") return array.length;
  const index = /^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : Number.NaN;
  if (!(index < array.length || (allowEnd && index === array.length))) {
    throw new JsonPatchError(`array index out of range: ${token}`);
  }
  return index;
}

/** Applies one operation to `parent` at `tokens`, copying every container on the path. */
function applyAt(parent: unknown, tokens: string[], op: JsonPatchOp): unknown {
  const [token, ...rest] = tokens;
  if (token === undefined) {
    if (op.op === "remove") throw new JsonPatchError("cannot remove the document root");
    return op.value;
  }
  const last = rest.length === 0;
  if (Array.isArray(parent)) {
    const index = arrayIndex(parent, token, last && op.op === "add");
    const copy = [...parent];
    if (!last) copy[index] = applyAt(parent[index], rest, op);
    else if (op.op === "add") copy.splice(index, 0, op.value);
    else if (op.op === "remove") copy.splice(index, 1);
    else copy[index] = op.value;
    return copy;
  }
  if (isObject(parent)) {
    if (!(token in parent) && !(last && op.op === "add")) {
      throw new JsonPatchError(`path not found: ${token}`);
    }
    if (!last) return { ...parent, [token]: applyAt(parent[token], rest, op) };
    if (op.op === "remove") {
      const { [token]: _, ...copy } = parent;
      return copy;
    }
    return { ...parent, [token]: op.value };
  }
  throw new JsonPatchError(`cannot traverse into a non-container at ${token}`);
}

/** Applies `ops` in order and returns the new document. The input is never mutated. */
export function applyPatch<T>(document: T, ops: readonly JsonPatchOp[]): T {
  let result: unknown = document;
  for (const op of ops) result = applyAt(result, parsePointer(op.path), op);
  return result as T;
}
