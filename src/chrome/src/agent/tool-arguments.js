function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * JSON Schema equality for `enum` and `const`: structural, key-order
 * independent. A tool argument arrives as separately parsed JSON, so reference
 * identity can never match an object- or array-valued member even when it is
 * exactly the value the schema asked for. Exported so the cloud output
 * validator compares the same way — the two must agree on every schema they
 * both see, or a result one accepts gets rejected by the other.
 */
export function jsonDeepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && jsonDeepEqual(a[key], b[key]));
}

function valueMatchesType(value, type) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validationFailure(toolName, invalidArguments, detail) {
  const fields = [...new Set(invalidArguments.map(String))];
  return {
    ok: false,
    result: {
      success: false,
      invalidArguments: true,
      invalidToolArguments: true,
      noDispatch: true,
      dispatched: false,
      errorCode: 'invalid_tool_arguments',
      invalidArgumentNames: fields,
      error: `${toolName || 'Tool'} could not run because its arguments do not match the advertised schema. Re-emit the call with only declared, valid arguments; do not assume the action happened.`,
      detail,
    },
  };
}

function validateValue(value, schema, path, failures) {
  if (!schema || typeof schema !== 'object') return;
  const acceptedTypes = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (acceptedTypes.length && !acceptedTypes.some(type => valueMatchesType(value, type))) {
    failures.push(path);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => jsonDeepEqual(candidate, value))) {
    failures.push(path);
    return;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isFinite(schema.minLength) && length < schema.minLength) failures.push(path);
    if (Number.isFinite(schema.maxLength) && length > schema.maxLength) failures.push(path);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) failures.push(path);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) failures.push(path);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, failures));
  }
  if (!isPlainObject(value)) return;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const required of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) failures.push(`${path}.${required}`);
  }
  // A schema that declares no properties places no constraints on the object's
  // keys: `{}` and `{ type: 'object' }` mean "any object", not "empty object".
  // Only an explicit `additionalProperties: false` closes such a schema. Without
  // this, a caller-supplied free-form object (a cloud run's output_schema, say)
  // would reject every key it carries.
  const closed = schema.additionalProperties === false
    || (schema.additionalProperties === undefined && isPlainObject(schema.properties));
  if (closed) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) failures.push(`${path}.${key}`);
    }
  }
  const additionalPropertiesSchema = isPlainObject(schema.additionalProperties)
    ? schema.additionalProperties
    : null;
  for (const [key, child] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      validateValue(child, properties[key], `${path}.${key}`, failures);
    } else if (additionalPropertiesSchema) {
      validateValue(child, additionalPropertiesSchema, `${path}.${key}`, failures);
    }
  }
}

function normalizeClickTargetDefaults(args) {
  const next = { ...args };
  if (typeof next.text === 'string' && next.text.trim() === '') delete next.text;
  if (typeof next.selector === 'string' && next.selector.trim() === '') delete next.selector;
  if (typeof next.capture_id === 'string' && next.capture_id.trim() === '') delete next.capture_id;
  if (typeof next.expected_name === 'string' && next.expected_name.trim() === '') delete next.expected_name;
  if (typeof next.expected_role === 'string' && next.expected_role.trim() === '') delete next.expected_role;
  if (Number.isInteger(next.index) && next.index < 0) delete next.index;
  if (next.x === 0 && next.y === 0) {
    delete next.x;
    delete next.y;
  }
  return next;
}

function validateClickTarget(args) {
  const text = typeof args.text === 'string' && args.text.trim() !== '';
  const selector = typeof args.selector === 'string' && args.selector.trim() !== '';
  const index = Number.isInteger(args.index) && args.index >= 0;
  const hasX = typeof args.x === 'number' && Number.isFinite(args.x);
  const hasY = typeof args.y === 'number' && Number.isFinite(args.y);
  const coordinates = hasX && hasY && !(args.x === 0 && args.y === 0);
  const strategies = [text, selector, index, coordinates].filter(Boolean).length;
  const invalidCoordinates = hasX !== hasY || ((hasX && hasY) && args.x === 0 && args.y === 0);
  const screenshotBindingInvalid = args.from_screenshot === true
    && (!coordinates || typeof args.capture_id !== 'string' || !args.capture_id.trim());
  const coordinateAssertionWithoutCoordinates = !coordinates
    && (!!String(args.expected_name || '').trim() || !!String(args.expected_role || '').trim());
  if (strategies !== 1 || invalidCoordinates || screenshotBindingInvalid || coordinateAssertionWithoutCoordinates) {
    return validationFailure('click', ['target'], 'Provide exactly one target strategy: non-empty text, non-empty selector, a non-negative integer index, or a complete non-zero x/y coordinate pair. Screenshot coordinates also require capture_id from the exact capture; expected_name/expected_role are coordinate-only safety assertions.');
  }
  return null;
}

export function closeToolDefinition(tool) {
  if (!tool?.function) return tool;
  const parameters = tool.function.parameters;
  if (!isPlainObject(parameters)) return tool;
  const closeSchema = (schema) => {
    if (!isPlainObject(schema)) return schema;
    const closed = { ...schema };
    if (isPlainObject(schema.properties)) {
      closed.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, closeSchema(child)]));
    }
    if (schema.items) closed.items = closeSchema(schema.items);
    // Only close an object that declares what it accepts. Stamping
    // `additionalProperties: false` onto a free-form `{ type: 'object' }` would
    // advertise "empty object only" and make every value invalid.
    if (schema.type === 'object'
        && schema.additionalProperties === undefined
        && isPlainObject(schema.properties)) {
      closed.additionalProperties = false;
    }
    return closed;
  };
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: closeSchema(parameters),
    },
  };
}

export function closeToolDefinitions(tools) {
  return Array.isArray(tools) ? tools.map(closeToolDefinition) : [];
}

export function validateToolArguments(toolName, args, parameters) {
  if (!isPlainObject(args)) {
    return validationFailure(toolName, ['$'], 'Arguments must be a JSON object.');
  }
  const normalizedArgs = toolName === 'click' ? normalizeClickTargetDefaults(args) : args;
  const closedParameters = isPlainObject(parameters)
    ? { ...parameters, additionalProperties: false }
    : { type: 'object', properties: {}, additionalProperties: false };
  const failures = [];
  validateValue(normalizedArgs, closedParameters, '$', failures);
  if (failures.length) {
    const enumGuidance = Object.entries(closedParameters.properties || {})
      .filter(([key, schema]) => failures.includes(`$.${key}`) && Array.isArray(schema.enum))
      .map(([key, schema]) => `${key} must be one of ${JSON.stringify(schema.enum)}.`).join(' ');
    return validationFailure(toolName, failures, `Invalid or undeclared argument(s): ${[...new Set(failures)].join(', ')}. ${enumGuidance}`.trim());
  }
  if (toolName === 'click') {
    const clickFailure = validateClickTarget(normalizedArgs);
    if (clickFailure) return clickFailure;
  }
  return { ok: true, args: normalizedArgs };
}
