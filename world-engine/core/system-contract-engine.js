'use strict';

const SYSTEM_CONTRACT_VERSION = 1;
const CONTRACT_POLICIES = {
  OFF: 'off',
  WARN: 'warn',
  ERROR: 'error',
};

function normalizeSystemContract(input) {
  if (!input) return null;
  if (typeof input === 'function') {
    return {
      version: SYSTEM_CONTRACT_VERSION,
      input: null,
      output: input,
      invariants: [],
      description: null,
    };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('System contract must be an object or validator function');
  }
  return {
    version: SYSTEM_CONTRACT_VERSION,
    input: normalizeValidator(input.input),
    output: normalizeValidator(input.output),
    invariants: normalizeInvariants(input.invariants),
    description: input.description ? String(input.description) : null,
  };
}

function validateSystemInput(contract, context) {
  if (!contract?.input) return emptyValidation('input');
  return runValidator(contract.input, context, {
    stage: 'input',
    path: '$context',
    context,
  });
}

function validateSystemOutput(contract, context, result) {
  if (!contract?.output) return emptyValidation('output');
  return runValidator(contract.output, result, {
    stage: 'output',
    path: '$result',
    context,
    result,
  });
}

function validateSystemInvariants(contract, context, result) {
  const issues = [];
  for (const invariant of contract?.invariants || []) {
    try {
      const value = invariant.check({
        world: context.world,
        context,
        result,
        system: context.system,
        report: context.report,
        shared: context.shared,
      });
      issues.push(...normalizeValidatorResult(value, {
        stage: 'invariant',
        path: `$invariant.${invariant.id}`,
        code: 'invariant_failed',
        message: invariant.message || `Invariant ${invariant.id} failed`,
      }));
    } catch (error) {
      issues.push(createIssue({
        stage: 'invariant',
        path: `$invariant.${invariant.id}`,
        code: error?.code || 'invariant_exception',
        message: error?.message || String(error),
      }));
    }
  }
  return validationResult('invariant', issues);
}

function validateSchema(value, schema, options = {}) {
  const issues = [];
  const seen = new WeakSet();
  visitSchema(value, schema, options.path || '$', issues, seen, options);
  return validationResult(options.stage || 'schema', issues);
}

function runValidator(validator, value, options) {
  if (validator.kind === 'schema') {
    return validateSchema(value, validator.schema, options);
  }
  try {
    const result = validator.validate(value, options.context, options.result);
    return validationResult(options.stage, normalizeValidatorResult(result, {
      stage: options.stage,
      path: options.path,
      code: 'custom_validation_failed',
      message: `${options.stage} contract failed`,
    }));
  } catch (error) {
    return validationResult(options.stage, [createIssue({
      stage: options.stage,
      path: options.path,
      code: error?.code || 'validator_exception',
      message: error?.message || String(error),
    })]);
  }
}

function visitSchema(value, schemaInput, path, issues, seen, options) {
  const schema = normalizeSchema(schemaInput);
  if (schema.nullable && value === null) return;
  if (schema.optional && value === undefined) return;

  if (schema.oneOf) {
    const candidates = schema.oneOf.map(candidate => {
      const candidateIssues = [];
      visitSchema(value, candidate, path, candidateIssues, new WeakSet(), options);
      return candidateIssues;
    });
    if (!candidates.some(candidate => candidate.length === 0)) {
      issues.push(createIssue({
        stage: options.stage,
        path,
        code: 'one_of_mismatch',
        message: schema.message || 'Value does not match any allowed schema',
      }));
    }
    return;
  }

  const actualType = valueType(value);
  const allowedTypes = normalizeTypes(schema.type);
  if (allowedTypes.length && !allowedTypes.includes(actualType)) {
    issues.push(createIssue({
      stage: options.stage,
      path,
      code: 'type_mismatch',
      message: schema.message || `Expected ${allowedTypes.join('|')}, received ${actualType}`,
      expected: allowedTypes,
      actual: actualType,
    }));
    return;
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issues.push(createIssue({
      stage: options.stage,
      path,
      code: 'const_mismatch',
      message: schema.message || `Expected constant ${String(schema.const)}`,
      expected: schema.const,
      actual: value,
    }));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
    issues.push(createIssue({
      stage: options.stage,
      path,
      code: 'enum_mismatch',
      message: schema.message || 'Value is not in the allowed enum',
      expected: schema.enum,
      actual: value,
    }));
  }

  if (typeof value === 'number') validateNumber(value, schema, path, issues, options.stage);
  if (typeof value === 'string') validateString(value, schema, path, issues, options.stage);
  if (Array.isArray(value)) validateArray(value, schema, path, issues, seen, options);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    validateObject(value, schema, path, issues, seen, options);
  }

  if (typeof schema.validate === 'function') {
    try {
      const customIssues = normalizeValidatorResult(schema.validate(value, options.context), {
        stage: options.stage,
        path,
        code: 'schema_custom_failed',
        message: schema.message || 'Custom schema validation failed',
      });
      issues.push(...customIssues);
    } catch (error) {
      issues.push(createIssue({
        stage: options.stage,
        path,
        code: error?.code || 'schema_custom_exception',
        message: error?.message || String(error),
      }));
    }
  }
}

function validateNumber(value, schema, path, issues, stage) {
  if (schema.finite !== false && !Number.isFinite(value)) {
    issues.push(createIssue({ stage, path, code: 'number_not_finite', message: 'Number must be finite' }));
    return;
  }
  if (schema.integer && !Number.isInteger(value)) {
    issues.push(createIssue({ stage, path, code: 'number_not_integer', message: 'Number must be an integer' }));
  }
  if (schema.minimum !== undefined && value < Number(schema.minimum)) {
    issues.push(createIssue({ stage, path, code: 'number_below_minimum', message: `Number must be >= ${schema.minimum}` }));
  }
  if (schema.maximum !== undefined && value > Number(schema.maximum)) {
    issues.push(createIssue({ stage, path, code: 'number_above_maximum', message: `Number must be <= ${schema.maximum}` }));
  }
}

function validateString(value, schema, path, issues, stage) {
  if (schema.minLength !== undefined && value.length < Number(schema.minLength)) {
    issues.push(createIssue({ stage, path, code: 'string_too_short', message: `String length must be >= ${schema.minLength}` }));
  }
  if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) {
    issues.push(createIssue({ stage, path, code: 'string_too_long', message: `String length must be <= ${schema.maxLength}` }));
  }
  if (schema.pattern) {
    const pattern = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(String(schema.pattern));
    if (!pattern.test(value)) {
      issues.push(createIssue({ stage, path, code: 'string_pattern_mismatch', message: `String must match ${pattern}` }));
    }
  }
}

function validateArray(value, schema, path, issues, seen, options) {
  if (schema.minItems !== undefined && value.length < Number(schema.minItems)) {
    issues.push(createIssue({ stage: options.stage, path, code: 'array_too_short', message: `Array length must be >= ${schema.minItems}` }));
  }
  if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) {
    issues.push(createIssue({ stage: options.stage, path, code: 'array_too_long', message: `Array length must be <= ${schema.maxItems}` }));
  }
  if (schema.items) {
    value.forEach((item, index) => visitSchema(item, schema.items, `${path}[${index}]`, issues, seen, options));
  }
}

function validateObject(value, schema, path, issues, seen, options) {
  if (seen.has(value)) return;
  seen.add(value);
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      issues.push(createIssue({
        stage: options.stage,
        path: `${path}.${key}`,
        code: 'required_property_missing',
        message: `Required property ${key} is missing`,
      }));
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    visitSchema(value[key], propertySchema, `${path}.${key}`, issues, seen, options);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        issues.push(createIssue({
          stage: options.stage,
          path: `${path}.${key}`,
          code: 'additional_property_forbidden',
          message: `Additional property ${key} is not allowed`,
        }));
      }
    }
  }
}

function normalizeValidator(input) {
  if (!input) return null;
  if (typeof input === 'function') return { kind: 'function', validate: input };
  if (typeof input === 'object' && !Array.isArray(input)) return { kind: 'schema', schema: normalizeSchema(input) };
  throw new Error('Contract validator must be a schema object or function');
}

function normalizeSchema(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Schema must be an object');
  }
  return {
    ...input,
    type: input.type || null,
    required: normalizeStringList(input.required),
    properties: input.properties && typeof input.properties === 'object' ? input.properties : {},
    oneOf: Array.isArray(input.oneOf) ? input.oneOf : null,
  };
}

function normalizeInvariants(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((entry, index) => {
    if (typeof entry === 'function') {
      return { id: `invariant_${index + 1}`, check: entry, message: null };
    }
    if (!entry || typeof entry !== 'object' || typeof entry.check !== 'function') {
      throw new Error(`Invariant ${index + 1} requires check function`);
    }
    return {
      id: String(entry.id || `invariant_${index + 1}`),
      check: entry.check,
      message: entry.message ? String(entry.message) : null,
    };
  });
}

function normalizeValidatorResult(value, defaults) {
  if (value === undefined || value === null || value === true) return [];
  if (value === false) return [createIssue(defaults)];
  if (typeof value === 'string') return [createIssue({ ...defaults, message: value })];
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeValidatorResult(item, defaults));
  }
  if (typeof value === 'object') {
    if (value.ok === true) return [];
    if (Array.isArray(value.issues)) {
      return value.issues.map(issue => createIssue({ ...defaults, ...(issue || {}) }));
    }
    return [createIssue({ ...defaults, ...value })];
  }
  return [createIssue({ ...defaults, message: String(value) })];
}

function createContractViolation(systemId, validations) {
  const issues = validations.flatMap(validation => validation?.issues || []);
  const first = issues[0] || { stage: 'unknown', path: '$', message: 'Unknown contract violation' };
  const error = new Error(`System ${systemId} contract failed at ${first.path}: ${first.message}`);
  error.name = 'SystemContractError';
  error.code = 'system_contract_violation';
  error.systemId = systemId;
  error.stage = first.stage;
  error.issues = issues;
  return error;
}

function summarizeContract(contract) {
  if (!contract) return { input: false, output: false, invariants: 0 };
  return {
    input: Boolean(contract.input),
    output: Boolean(contract.output),
    invariants: contract.invariants?.length || 0,
  };
}

function normalizeContractPolicy(value) {
  const policy = String(value || CONTRACT_POLICIES.ERROR).toLowerCase();
  if (!Object.values(CONTRACT_POLICIES).includes(policy)) {
    throw new Error(`Unsupported contract policy ${policy}`);
  }
  return policy;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function normalizeTypes(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(type => String(type).toLowerCase()))];
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function emptyValidation(stage) {
  return validationResult(stage, []);
}

function validationResult(stage, issues) {
  return {
    stage,
    ok: issues.length === 0,
    issues,
  };
}

function createIssue(input = {}) {
  return {
    stage: input.stage || 'unknown',
    path: input.path || '$',
    code: input.code || 'validation_failed',
    message: input.message || 'Validation failed',
    expected: input.expected,
    actual: input.actual,
  };
}

module.exports = {
  SYSTEM_CONTRACT_VERSION,
  CONTRACT_POLICIES,
  normalizeSystemContract,
  validateSystemInput,
  validateSystemOutput,
  validateSystemInvariants,
  validateSchema,
  createContractViolation,
  summarizeContract,
  normalizeContractPolicy,
  valueType,
};
