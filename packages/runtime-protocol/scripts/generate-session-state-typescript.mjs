export const sessionStateTypeScript = `
type SessionStateSchema = {
  $ref?: string;
  const?: unknown;
  enum?: readonly unknown[];
  oneOf?: readonly SessionStateSchema[];
  anyOf?: readonly SessionStateSchema[];
  allOf?: readonly SessionStateSchema[];
  not?: SessionStateSchema;
  if?: SessionStateSchema;
  then?: SessionStateSchema;
  else?: SessionStateSchema;
  type?: string | readonly string[];
  items?: SessionStateSchema;
  contains?: SessionStateSchema;
  required?: readonly string[];
  properties?: Readonly<Record<string, SessionStateSchema>>;
  additionalProperties?: false;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
};

const { schema } = REMOTE_SESSION_STATE_CONTRACT;
const definitions: Readonly<Record<string, SessionStateSchema>> = schema.$defs;

function matchesSessionStateSchema(schema: SessionStateSchema, value: unknown): boolean {
  if (schema.$ref) {
    const definition = definitions[schema.$ref.slice("#/$defs/".length)];
    return definition !== undefined && matchesSessionStateSchema(definition, value);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter((variant) => matchesSessionStateSchema(variant, value)).length !== 1)
    return false;
  if (schema.anyOf && !schema.anyOf.some((variant) => matchesSessionStateSchema(variant, value))) return false;
  if (schema.allOf && !schema.allOf.every((rule) => matchesSessionStateSchema(rule, value))) return false;
  if (schema.not && matchesSessionStateSchema(schema.not, value)) return false;
  if (schema.if) {
    const consequence = matchesSessionStateSchema(schema.if, value) ? schema.then : schema.else;
    if (consequence && !matchesSessionStateSchema(consequence, value)) return false;
  }

  const array = Array.isArray(value);
  const object = value !== null && typeof value === "object" && !array;
  const type = array ? "array" : value === null ? "null" : typeof value;
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  } else if (typeof schema.type === "string") {
    if (schema.type !== type) return false;
  } else if (schema.type && !schema.type.includes(type)) return false;

  if (
    typeof value === "number" &&
    (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
  )
    return false;
  if (schema.minLength !== undefined && typeof value === "string" && [...value].length < schema.minLength)
    return false;
  if (array) {
    const { items, contains, maxItems, uniqueItems } = schema;
    if (maxItems !== undefined && value.length > maxItems) return false;
    if (uniqueItems && new Set(value).size !== value.length) return false;
    if (items && !value.every((item) => matchesSessionStateSchema(items, item))) return false;
    if (contains && !value.some((item) => matchesSessionStateSchema(contains, item))) return false;
  }
  if (object) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, entry] of Object.entries(value)) {
      const property =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      if (property ? !matchesSessionStateSchema(property, entry) : schema.additionalProperties === false)
        return false;
    }
  }
  return true;
}

/** An advertised state is usable only when its shape and all contract invariants agree. */
export function parseSessionState(value: unknown): SessionState | null {
  if (!matchesSessionStateSchema(schema, value)) return null;
  const state = value as SessionState;
  const targets: Partial<Record<SessionRecoveryAction, keyof SessionStateControls>> =
    REMOTE_SESSION_STATE_CONTRACT.recoveryActionControls;
  for (const control of Object.values(state.controls)) {
    if (control.state !== "disabled" || control.recovery.kind !== "action") continue;
    const target = targets[control.recovery.action];
    if (target && state.controls[target].state !== "enabled") return null;
  }
  return state;
}
`;
