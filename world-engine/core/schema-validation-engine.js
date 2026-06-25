'use strict';

const SCHEMA_VALIDATION_VERSION = 1;

function validateSchema(value, schema, path = '$', violations = [], stage = 'schema') {
  if (schema === undefined || schema === null || schema === 'any') return violations;
  if (typeof schema === 'string') {
    validateType(value, schema, path, violations, stage);
    return violations;
  }
  if (typeof schema === 'function') {
    runSchemaPredicate(schema, value, path, violations, stage);
    return violations;
  }
  if (Array.isArray(schema)) {
    validateOneOf(value, schema, path, violations, stage);
    return violations;
  }
  if (typeof schema !== 'object') {
    addViolation(violations, stage, path, 'invalid_schema', 'Schema must be a type, object, array or predicate');
    return violations;
  }

  if (Array.isArray(schema.oneOf)) {
    validateOneOf(value, schema.oneOf, path, violations, stage);
    if (violations.some(violation => violation.path === path && violation.code === 'one_of_mismatch')) {
      return violations;
    }
  }

  if (value === undefined) {
    if (schema.optional === true) return violations;
    addViolation(violations, stage, path, 'required_value_missing', 'Required value is missing', describeSchema(schema), 'undefined');
    return violations;
  }
  if (value === null) {
    if (schema.nullable === true || schema.type === 'null') return violations;
    addViolation(violations, stage, path, 'null_not_allowed', 'Null is not allowed', describeSchema(schema), 'null');
    return violations;
  }

  if (schema.type && schema.type !== 'any') {
    const before = violations.length;
    validateType(value, schema.type, path, violations, stage);
    if (violations.length > before) return violations;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(value, schema.const)) {
    addViolation(violations, stage, path, 'const_mismatch', 'Value does not match contract constant', schema.const, describeActual(value));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
    addViolation(violations, stage, path, 'enum_mismatch', 'Value is outside the allowed set', schema.enum, describeActual(value));
  }

  if (typeof value === 'number') validateNumber(value, schema, path, violations, stage);
  if (typeof value === 'string') validateString(value, schema, path, violations, stage);
  if (Array.isArray(value)) validateArray(value, schema, path, violations, stage);
  if (isPlainObject(value)) validateObject(value, schema, path, violations, stage);

  if (typeof schema.predicate === 'function') {
    runSchemaPredicate(schema.predicate, value, path, violations, stage);
  }
  return violations;
}

function validateNumber(value, schema, path, violations, stage) {
  if (Number.isFinite(schema.min) && value < schema.min) {
    addViolation(violations, stage, path, 'number_below_minimum', `Number must be at least ${schema.min}`, schema.min, value);
  }
  if (Number.isFinite(schema.max) && value > schema.max) {
    addViolation(violations, stage, path, 'number_above_maximum', `Number must be at most ${schema.max}`, schema.max, value);
  }
}

function validateString(value, schema, path, violations, stage) {
  if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
    addViolation(violations, stage, path, 'string_too_short', `String must contain at least ${schema.minLength} characters`, schema.minLength, value.length);
  }
  if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
    addViolation(violations, stage, path, 'string_too_long', `String must contain at most ${schema.maxLength} characters`, schema.maxLength, value.length);
  }
  if (schema.pattern) {
    const pattern = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(String(schema.pattern));
    if (!pattern.test(value)) {
      addViolation(violations, stage, path, 'pattern_mismatch', `String must match ${pattern}`, String(pattern), value);
    }
  }
}

function validateArray(value, schema, path, violations, stage) {
  if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
    addViolation(violations, stage, path, 'array_too_short', `Array must contain at least ${schema.minItems} items`, schema.minItems, value.length);
  }
  if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
    addViolation(violations, stage, path, 'array_too_long', `Array must contain at most ${schema.maxItems} items`, schema.maxItems, value.length);
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, violations, stage));
  }
}

function validateObject(value, schema, path, violations, stage) {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      addViolation(violations, stage, `${path}.${key}`, 'required_property_missing', `Required property ${key} is missing`, 'present', 'missing');
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (!present && !required.includes(key)) continue;
    if (present) validateSchema(value[key], propertySchema, `${path}.${key}`, violations, stage);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        addViolation(violations, stage, `${path}.${key}`, 'additional_property', `Additional property ${key} is not allowed`, 'declared property', key);
      }
    }
  }
}

function validateOneOf(value, schemas, path, violations, stage) {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    addViolation(violations, stage, path, 'one_of_empty', 'oneOf requires at least one schema');
    return;
  }
  const attempts = schemas.map(schema => {
    const candidate = [];
    validateSchema(value, schema, path, candidate, stage);
    return candidate;
  });
  const matches = attempts.filter(candidate => candidate.length === 0).length;
  if (matches === 1) return;
  addViolation(
    violations,
    stage,
    path,
    matches === 0 ? 'one_of_mismatch' : 'one_of_ambiguous',
    matches === 0
      ? 'Value did not match any allowed schema'
      : 'Value matched more than one oneOf schema',
    schemas.map(describeSchema),
    describeActual(value),
  );
}

function runSchemaPredicate(predicate, value, path, violations, stage) {
  try {
    const outcome = predicate(value, path);
    if (outcome === true || outcome === undefined || outcome === null) return;
    if (outcome === false) {
      addViolation(violations, stage, path, 'predicate_failed', 'Schema predicate returned false');
      return;
    }
    if (typeof outcome === 'string') {
      addViolation(violations, stage, path, 'predicate_failed', outcome);
      return;
    }
    appendValidationOutcome(outcome, stage, violations, path);
  } catch (error) {
    addViolation(violations, stage, path, 'predicate_threw', error?.message || String(error));
  }
}

function appendValidationOutcome(outcome, stage, violations, fallbackPath = '$validator') {
  if (outcome === true || outcome === undefined || outcome === null) return;
  const values = Array.isArray(outcome) ? outcome : [outcome];
  for (const value of values) {
    if (value === false) {
      addViolation(violations, stage, fallbackPath, 'validator_failed', 'Contract validator returned false');
    } else if (typeof value === 'string') {
      addViolation(violations, stage, fallbackPath, 'validator_failed', value);
    } else if (value && typeof value === 'object') {
      violations.push({
        stage,
        path: value.path || fallbackPath,
        code: value.code || 'validator_failed',
        message: value.message || 'Contract validator failed',
        expected: value.expected,
        actual: value.actual,
      });
    }
  }
}

function validateType(value, expected, path, violations, stage) {
  const actual = valueType(value);
  const matches = expected === 'any'
    || expected === actual
    || (expected === 'number' && actual === 'integer')
    || (expected === 'object' && isPlainObject(value));
  if (!matches) {
    addViolation(violations, stage, path, 'type_mismatch', `Expected ${expected} but received ${actual}`, expected, actual);
  }
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeSchema(schema) {
  if (schema === undefined || schema === null) return 'any';
  if (typeof schema === 'string') return schema;
  if (typeof schema === 'function') return 'predicate';
  if (Array.isArray(schema)) return `oneOf(${schema.map(describeSchema).join(', ')})`;
  if (Array.isArray(schema.oneOf)) return `oneOf(${schema.oneOf.map(describeSchema).join(', ')})`;
  return schema.type || 'object';
}

function describeActual(value) {
  const type = valueType(value);
  if (['string', 'number', 'integer', 'boolean', 'undefined', 'null'].includes(type)) return value;
  if (type === 'array') return `array(${value.length})`;
  if (type === 'object') return `object(${Object.keys(value).length})`;
  return type;
}

function addViolation(violations, stage, path, code, message, expected, actual) {
  violations.push({ stage, path, code, message, expected, actual });
}

function objectSchema(required = [], properties = {}, options = {}) {
  return {
    type: 'object',
    required: [...required],
    properties: { ...properties },
    ...options,
  };
}

function arraySchema(items = 'any', options = {}) {
  return { type: 'array', items, ...options };
}

module.exports = {
  SCHEMA_VALIDATION_VERSION,
  validateSchema,
  validateOneOf,
  appendValidationOutcome,
  objectSchema,
  arraySchema,
  valueType,
  isPlainObject,
  describeSchema,
  describeActual,
  addViolation,
};
