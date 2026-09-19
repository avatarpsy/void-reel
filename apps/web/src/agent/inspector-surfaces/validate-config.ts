/**
 * ── A CONFIG THE SURFACE CANNOT READ IS A FAILED CALL, NOT A QUIET ONE ──────
 *
 * Every surface's `apply` walks the config looking for the keys it knows and
 * acts on the ones it finds. That is the right shape for a partial edit ("just
 * the fadeOut") and the wrong shape for a config it understands NONE of: the
 * loop simply never enters, no error is recorded, and the surface returns
 * `ok: true`. The dispatcher counts that as a touched clip and answers
 * `clipsTouched: 1`.
 *
 * Measured, on a real episode: sixteen consecutive calls to
 * `apply_inspector_tool` answered `{ ok: true, clipsTouched: 1 }` and wrote
 * nothing at all, because the caller had sent the surface config under `params`
 * instead of `config`. The MCP schema already said `config` was REQUIRED and
 * `additionalProperties: false`, so the call should have been refused at the
 * door. Nothing enforced it. The mix was re-applied three times and re-rendered
 * four before the empty `note` gave it away — the only visible symptom was a
 * field that should have read "2 volume keyframe(s)" and read "".
 *
 * So this runs BEFORE any target is touched, against the JSON schema the
 * surface already publishes for `get_inspector_tool_schema`. It is deliberately
 * not a general JSON-schema engine: it enforces the four things that make the
 * difference between an edit and a silent no-op, and says what was expected
 * when it refuses, because the caller is usually a model that can correct
 * itself from a good error and cannot correct itself from `ok: true`.
 */

type Schema = {
  properties?: Record<string, unknown>;
  required?: unknown;
  anyOf?: unknown;
  additionalProperties?: unknown;
};

type SurfaceLike = {
  name: string;
  schema?: unknown;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `required` arrays out of `anyOf: [{required:[...]}, ...]`. */
function anyOfGroups(schema: Schema): string[][] {
  if (!Array.isArray(schema.anyOf)) return [];
  const groups: string[][] = [];
  for (const branch of schema.anyOf) {
    if (!isPlainObject(branch)) continue;
    const req = branch.required;
    if (Array.isArray(req) && req.every((k) => typeof k === "string")) {
      groups.push(req as string[]);
    }
  }
  return groups;
}

/**
 * @returns an error string to fail the call with, or null when the config is
 *          something this surface can actually act on.
 */
export function validateSurfaceConfig(
  surface: SurfaceLike,
  config: unknown,
): string | null {
  const where = `surface "${surface.name}"`;

  if (config === undefined || config === null) {
    return `${where}: config is required. Pass the surface config under "config" (not "params"). Fetch its shape with get_inspector_tool_schema.`;
  }
  if (!isPlainObject(config)) {
    return `${where}: config must be an object, got ${
      Array.isArray(config) ? "array" : typeof config
    }.`;
  }

  const schema: Schema = isPlainObject(surface.schema)
    ? (surface.schema as Schema)
    : {};
  const props = isPlainObject(schema.properties) ? schema.properties : undefined;
  const known = props ? Object.keys(props) : [];
  const given = Object.keys(config);

  if (given.length === 0) {
    return `${where}: config is empty${
      known.length ? `. Expected at least one of: ${known.join(", ")}` : "."
    }`;
  }

  // Surfaces declare `additionalProperties: false`, so an unknown key is a
  // typo or a wrong-surface call — both of which used to apply nothing quietly.
  if (props && schema.additionalProperties === false) {
    const unknown = given.filter((k) => !known.includes(k));
    if (unknown.length > 0) {
      return `${where}: unknown config key(s): ${unknown.join(
        ", ",
      )}. Expected: ${known.join(", ")}.`;
    }
  }

  if (Array.isArray(schema.required)) {
    const missing = (schema.required as unknown[])
      .filter((k): k is string => typeof k === "string")
      // `undefined` is absent, not present: it does not survive JSON, and a
      // caller that spread an optional field should get the same answer as
      // one that omitted it.
      .filter((k) => config[k] === undefined);
    if (missing.length > 0) {
      return `${where}: missing required config key(s): ${missing.join(", ")}.`;
    }
  }

  // `anyOf: [{required:["fadeIn"]}, {required:["fadeOut"]}, …]` is how a surface
  // says "one of these, at least". Satisfying none is the empty-edit case.
  const groups = anyOfGroups(schema);
  if (groups.length > 0) {
    const satisfied = groups.some((g) => g.every((k) => config[k] !== undefined));
    if (!satisfied) {
      const options = groups.map((g) => g.join("+")).join(" | ");
      return `${where}: config satisfies none of the required combinations: ${options}.`;
    }
  }

  // Last line of defence, for a surface that publishes no schema: if nothing in
  // the config is a key the surface declares, it cannot do anything with it.
  if (known.length > 0 && !given.some((k) => known.includes(k))) {
    return `${where}: config has no keys this surface reads. Expected at least one of: ${known.join(
      ", ",
    )}.`;
  }

  return null;
}
