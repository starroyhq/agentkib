const referenceName = (field) => field.$ref?.split("/").at(-1);
const quote = (value) => JSON.stringify(value).replaceAll("$", "\\$");
const dartName = (value) => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const dartList = (values) => `const [${values.map(quote).join(", ")}]`;
const fieldAccess = (key) => `fields[${quote(key)}]`;
const primitiveType = { string: "String", integer: "int", boolean: "bool" };

function dartType(schema) {
  if (schema.$ref) return referenceName(schema);
  if (schema.type === "array") return `List<${dartType(schema.items)}>`;
  if (Array.isArray(schema.type) && schema.type.length === 2 && schema.type.includes("null"))
    return `${dartType({ type: schema.type.find((type) => type !== "null") })}?`;
  if (Object.hasOwn(schema, "const")) return typeof schema.const === "number" ? "int" : "String";
  const type = primitiveType[schema.type];
  if (!type) throw new Error(`Unsupported session state Dart type: ${schema.type}`);
  return type;
}

function dartRead(field, value) {
  if (field.$ref) return `${referenceName(field)}.fromJson(${value})`;
  if (field.type === "array") {
    const item = dartRead(field.items, "item");
    return `${dartType(field)}.unmodifiable(\n        (${value} as List<Object?>).map((item) => ${item}),\n      )`;
  }
  if (field.enum) return `_sessionStateString(${value}, ${dartList(field.enum)})`;
  return `${value} as ${dartType(field)}`;
}

function enumSource(name, schema) {
  return `enum ${name} {
${schema.enum.map((value) => `  ${dartName(value)}(${quote(value)})`).join(",\n")};

  const ${name}(this.value);

  final String value;

  static ${name} fromJson(Object? value) {
    for (final option in values) {
      if (option.value == value) return option;
    }
    throw FormatException("Invalid ${name}", value);
  }
}
`;
}

function fieldCheck(name, key, field) {
  const value = fieldAccess(key);
  const conditions = [];
  if (Object.hasOwn(field, "const"))
    conditions.push(`${value} is! ${dartType(field)}`, `${value} != ${quote(field.const)}`);
  if (field.minimum !== undefined) conditions.push(`(${value} as int) < ${field.minimum}`);
  if (field.maximum !== undefined) conditions.push(`(${value} as int) > ${field.maximum}`);
  if (!conditions.length) return "";
  return `    if (${conditions.join(" || ")}) {\n      throw const FormatException("Invalid ${name}.${key}");\n    }\n`;
}

function objectSource(name, schema, union) {
  if (schema.type !== "object" || schema.additionalProperties !== false)
    throw new Error(`${name} must be a closed object.`);
  const entries = Object.entries(schema.properties);
  if (
    entries.length !== schema.required.length ||
    entries.some(([key]) => !schema.required.includes(key))
  )
    throw new Error(`${name} must declare every property required.`);
  const fields = entries.filter(([, field]) => !Object.hasOwn(field, "const"));
  const constructor = !fields.length
    ? `  const ${name}();`
    : `  const ${name}({\n${fields.map(([key]) => `    required this.${key},`).join("\n")}\n  });`;
  const declarations = entries.map(([key, field]) => {
    const override = union?.tag === key ? "  @override\n" : "";
    const constant = Object.hasOwn(field, "const") ? ` = ${quote(field.const)}` : "";
    return `${override}  final ${dartType(field)} ${key}${constant};`;
  });
  const checks = entries.map(([key, field]) => fieldCheck(name, key, field)).join("");
  const argumentsList = fields.map(
    ([key, field]) => `      ${key}: ${dartRead(field, fieldAccess(key))},`,
  );
  const result = fields.length ? `${name}(\n${argumentsList.join("\n")}\n    )` : `const ${name}()`;
  return `final class ${name}${union ? ` extends ${union.name}` : ""} {
${constructor}

${declarations.join("\n")}

  factory ${name}.fromJson(Object? json) {
    final fields = _sessionStateFields(json, ${dartList(schema.required)});
${checks}    return ${result};
  }
${name === "SessionState" ? optionalStateParser : ""}}
`;
}

function unionSource(name, schema) {
  const variants = schema.oneOf;
  const tags = (field) => field?.enum ?? (typeof field?.const === "string" ? [field.const] : []);
  const tag = Object.keys(variants[0].properties).find((key) => {
    const choices = variants.map((variant) => tags(variant.properties[key]));
    return (
      choices.every((values) => values.length > 0) &&
      new Set(choices.flat()).size === choices.flat().length
    );
  });
  if (!tag || variants.some((variant) => !variant.title))
    throw new Error(`${name} must have disjoint, named variants with a string discriminator.`);

  const choices = variants.map(
    (variant) =>
      `${tags(variant.properties[tag])
        .map((value) => `      case ${quote(value)}:`)
        .join("\n")}\n        return ${variant.title}.fromJson(json);`,
  );
  return `sealed class ${name} {
  const ${name}();

  String get ${tag};

  factory ${name}.fromJson(Object? json) {
    if (json is Map<String, Object?>) {
      switch (json[${quote(tag)}]) {
${choices.join("\n")}
      }
    }
    throw FormatException("Invalid ${name}", json);
  }
}

${variants.map((variant) => objectSource(variant.title, variant, { name, tag })).join("\n")}`;
}

const optionalStateParser = `
  /// Returns null for absent, unsupported or invalid state.
  /// The access capability distinguishes legacy hosts from invalid v1 responses.
  static SessionState? tryParse(Object? json) {
    try {
      return SessionState.fromJson(json);
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }
`;

const helpers = `Map<String, Object?> _sessionStateFields(Object? value, List<String> expected) {
  if (value is! Map<String, Object?> ||
      value.length != expected.length ||
      !expected.every(value.containsKey)) {
    throw const FormatException("Invalid session state object fields");
  }
  return value;
}

String _sessionStateString(Object? value, List<String> allowed) {
  if (value is String && allowed.contains(value)) return value;
  throw FormatException("Invalid session state enum value", value);
}
`;

/** Generate only the closed session-state schema. Other contract models stay on their existing path. */
export function sessionStateDart(schema) {
  return (
    Object.entries({ ...schema.$defs, SessionState: schema })
      .map(([name, definition]) => {
        if (definition.oneOf) return unionSource(name, definition);
        if (definition.enum) return enumSource(name, definition);
        return objectSource(name, definition);
      })
      .join("\n") + `\n${helpers}`
  );
}
