'use strict';

const CONTRACT_ENGINE_VERSION = 1;
const CONTRACT_POLICIES = {
  OFF: 'off',
  WARN: 'warn',
  STRICT: 'strict',
};
const MISSING = Symbol('missing');

function normalizeContractPolicy(value, fallback = CONTRACT_POLICIES.STRICT) {
  const policy = String(value || fallback).trim().toLowerCase();
  if (!Object.values(CONTRACT_POLICIES).includes(policy)) {
    throw new Error(`Unsupported system contract policy ${policy}`);
  }
  return policy;
}

function normalizeSystemContract(contract) {
  if (!contract) return null;
  if (typeof contract !== 'object') throw new Error('System contract must be an object');
  return {
    version: Number(contract.version || CONTRACT_ENGINE_VERSION),
    name: contract.name ? String(contract.name) : null,
    input: normalizeContractSection(contract.input, 'input'),
    output: normalizeContractSection(contract.output, 'output'),
    post: normalizeContractSection(contract.post, 'post'),
  };
}

function validateSystemContract(contract, stage, context, result) {
  const normalized = normalizeSystemContract(contract);
  if (!normalized) return createValidationResult(stage, []);
  if (normalized.version !== CONTRACT_ENGINE_VERSION) {
    return createValidationResult(stage, [{
      stage,
      path: '$contract.version',
      code: 'unsupported_contract_version',
      message: `Unsupported system contract version ${normalized.version}`,
      expected: CONTRACT_ENGINE_VERSION,
      actual: normalized.version,
    }]);
  }
  const section = normalized[stage];
  if (!section) return createValidationResult(stage, []);
  const violations = [];

  if (section.schema !== undefined) {
    const value = stage === 'output' ? result : context;
    validateSchema(value, section.schema, stage === 'output' ? '$result' : '$context', violations, stage);
  }

  for (const requirement of section.paths) {
    validatePathRequirement(context, requirement, stage, violations);
  }

  for (const validator of section.validators) {
    runValidator(validator, context, result, stage, violations);
  }

  return createValidationResult(stage, violations);
}

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

  if (typeof value === 'number') {
    if (Number.isFinite(schema.min) && value < schema.min) {
      addViolation(violations, stage, path, 'number_below_minimum', `Number must be at least ${schema.min}`, schema.min, value);
    }
    if (Number.isFinite(schema.max) && value > schema.max) {
      addViolation(violations, stage, path, 'number_above_maximum', `Number must be at most ${schema.max}`, schema.max, value);
    }
  }

  if (typeof value === 'string') {
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

  if (Array.isArray(value)) {
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

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        addViolation(violations, stage, `${path}.${key}`, 'required_property_missing', `Required property ${key} is missing`, 'present', 'missing');
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      validateSchema(value[key], propertySchema, `${path}.${key}`, violations, stage);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          addViolation(violations, stage, `${path}.${key}`, 'additional_property', `Additional property ${key} is not allowed`, 'declared property', key);
        }
      }
    }
  }

  if (typeof schema.predicate === 'function') {
    runSchemaPredicate(schema.predicate, value, path, violations, stage);
  }
  return violations;
}

function validatePathRequirement(context, requirement, stage, violations) {
  const normalized = typeof requirement === 'string'
    ? { path: requirement, schema: 'any', optional: false }
    : { ...(requirement || {}) };
  const path = String(normalized.path || '').trim();
  if (!path) {
    addViolation(violations, stage, '$contract.paths', 'path_missing', 'Contract path requirement needs a path');
    return;
  }
  const value = getPathValue(context, path);
  if (value === MISSING) {
    if (!normalized.optional) {
      addViolation(
        violations,
        stage,
        path,
        'required_path_missing',
        normalized.message || `Required path ${path} is missing`,
        describeSchema(normalized.schema),
        'missing',
      );
    }
    return;
  }
  validateSchema(value, normalized.schema ?? 'any', path, violations, stage);
}

function runValidator(validator, context, result, stage, violations) {
  try {
    const outcome = validator(context, result, stage);
    appendValidatorOutcome(outcome, stage, violations);
  } catch (error) {
    addViolation(
      violations,
      stage,
      '$validator',
      'validator_threw',
      error?.message || String(error),
      'validator success',
      error?.name || 'Error',
    );
  }
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
    appendValidatorOutcome(outcome, stage, violations, path);
  } catch (error) {
    addViolation(violations, stage, path, 'predicate_threw', error?.message || String(error));
  }
}

function appendValidatorOutcome(outcome, stage, violations, fallbackPath = '$validator') {
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

function createSystemContractError(systemId, stage, violations) {
  const first = violations[0] || {};
  const error = new Error(
    `System ${systemId} ${stage} contract failed${first.path ? ` at ${first.path}` : ''}: ${first.message || 'contract violation'}`,
  );
  error.name = 'SystemContractError';
  error.code = 'system_contract_violation';
  error.systemId = systemId;
  error.stage = stage;
  error.violations = violations.map(violation => ({ ...violation }));
  return error;
}

function getPathValue(root, path) {
  const parts = String(path || '')
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || !Object.prototype.hasOwnProperty.call(Object(cursor), part)) {
      return MISSING;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function normalizeContractSection(section, stage) {
  if (section === undefined || section === null) return null;
  if (stage === 'output' && isSchemaLike(section)) {
    return { schema: section, paths: [], validators: [] };
  }
  if (typeof section === 'function') {
    return { schema: undefined, paths: [], validators: [section] };
  }
  if (Array.isArray(section)) {
    return { schema: undefined, paths: section.map(normalizePathRequirement), validators: [] };
  }
  if (typeof section !== 'object') {
    return { schema: section, paths: [], validators: [] };
  }
  return {
    schema: section.schema,
    paths: (section.paths || section.requires || []).map(normalizePathRequirement),
    validators: normalizeValidators(section.validate || section.validators),
  };
}

function normalizePathRequirement(value) {
  if (typeof value === 'string') return { path: value, schema: 'any', optional: false };
  return {
    ...(value || {}),
    path: String(value?.path || '').trim(),
    schema: value?.schema ?? value?.type ?? 'any',
    optional: Boolean(value?.optional),
  };
}

function normalizeValidators(value) {
  const validators = Array.isArray(value) ? value : value ? [value] : [];
  for (const validator of validators) {
    if (typeof validator !== 'function') throw new Error('System contract validator must be a function');
  }
  return validators;
}

function isSchemaLike(value) {
  if (typeof value === 'string' || typeof value === 'function' || Array.isArray(value)) return true;
  if (!value || typeof value !== 'object') return false;
  return [
    'type', 'optional', 'nullable', 'enum', 'const', 'required', 'properties', 'items',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'predicate', 'oneOf',
  ].some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function validateOneOf(value, schemas, path, violations, stage) {
  const attempts = schemas.map(schema => {
    const candidate = [];
    validateSchema(value, schema, path, candidate, stage);
    return candidate;
  });
  if (attempts.some(candidate => candidate.length === 0)) return;
  addViolation(
    violations,
    stage,
    path,
    'one_of_mismatch',
    'Value did not match any allowed schema',
    schemas.map(describeSchema),
    describeActual(value),
  );
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

function createValidationResult(stage, violations) {
  return {
    version: CONTRACT_ENGINE_VERSION,
    stage,
    ok: violations.length === 0,
    violations,
  };
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
  CONTRACT_ENGINE_VERSION,
  CONTRACT_POLICIES,
  normalizeContractPolicy,
  normalizeSystemContract,
  validateSystemContract,
  validateSchema,
  createSystemContractError,
  getPathValue,
  objectSchema,
  arraySchema,
  valueType,
};
