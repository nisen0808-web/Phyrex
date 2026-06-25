'use strict';

const {
  validateSchema,
  appendValidationOutcome,
  objectSchema,
  arraySchema,
  valueType,
  describeSchema,
  addViolation,
} = require('./schema-validation-engine');

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
    appendValidationOutcome(outcome, stage, violations);
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

function createValidationResult(stage, violations) {
  return {
    version: CONTRACT_ENGINE_VERSION,
    stage,
    ok: violations.length === 0,
    violations,
  };
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
