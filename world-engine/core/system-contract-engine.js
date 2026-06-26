'use strict';

const { cloneCanonical } = require('./state-integrity-engine');
const { ensureSchedulerState } = require('./system-scheduler-engine');

const SYSTEM_CONTRACT_VERSION = 1;
const CONTRACT_POLICIES = {
  OFF: 'off',
  WARN: 'warn',
  ERROR: 'error',
};
const DEFAULT_CONTRACT_OPTIONS = {
  policy: CONTRACT_POLICIES.ERROR,
  maxViolations: 50,
  recordValues: false,
};

function createSystemContract(definition = {}) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('System contract definition must be an object');
  }
  return {
    version: SYSTEM_CONTRACT_VERSION,
    description: definition.description ? String(definition.description) : null,
    inputs: normalizePathRules(definition.inputs),
    output: definition.output === undefined ? null : normalizeSchema(definition.output),
    postconditions: normalizePathRules(definition.postconditions),
    validateInput: typeof definition.validateInput === 'function' ? definition.validateInput : null,
    validateOutput: typeof definition.validateOutput === 'function' ? definition.validateOutput : null,
    metadata: { ...(definition.metadata || {}) },
  };
}

function attachSystemContract(system, contractDefinition, options = {}) {
  if (!system || typeof system !== 'object' || typeof system.run !== 'function') {
    throw new Error('attachSystemContract requires a normalized system');
  }
  const contract = contractDefinition?.version === SYSTEM_CONTRACT_VERSION
    ? contractDefinition
    : createSystemContract(contractDefinition || {});
  const originalRun = system.contractRuntime?.originalRun || system.run;
  system.contract = contract;
  system.contractRuntime = {
    version: SYSTEM_CONTRACT_VERSION,
    originalRun,
    options: normalizeContractOptions(options),
  };
  system.run = context => executeContractedSystem(system, context);
  return system;
}

function detachSystemContract(system) {
  if (!system?.contractRuntime?.originalRun) return system;
  system.run = system.contractRuntime.originalRun;
  delete system.contract;
  delete system.contractRuntime;
  return system;
}

function attachRegistryContracts(registry, contracts = {}, options = {}) {
  requireRegistry(registry);
  const attached = [];
  const missingSystems = [];
  for (const [systemId, definition] of Object.entries(contracts || {})) {
    const system = registry.systems[systemId];
    if (!system) {
      missingSystems.push(systemId);
      continue;
    }
    attachSystemContract(system, definition, options);
    attached.push(systemId);
  }
  const missingContracts = Object.keys(registry.systems)
    .filter(systemId => !registry.systems[systemId].contract)
    .sort();
  return {
    attached: attached.sort(),
    missingSystems: missingSystems.sort(),
    missingContracts,
    coverage: Object.keys(registry.systems).length
      ? attached.length / Object.keys(registry.systems).length
      : 1,
  };
}

function analyzeContractCoverage(registry) {
  requireRegistry(registry);
  const systems = Object.values(registry.systems);
  const contractedIds = systems.filter(system => system.contract).map(system => system.id).sort();
  const uncontractedIds = systems.filter(system => !system.contract).map(system => system.id).sort();
  return {
    systems: systems.length,
    contracted: contractedIds.length,
    uncontracted: uncontractedIds.length,
    coverage: systems.length ? contractedIds.length / systems.length : 1,
    contractedIds,
    uncontractedIds,
  };
}

function executeContractedSystem(system, context) {
  const runtime = system.contractRuntime;
  if (!runtime?.originalRun || !system.contract) {
    throw new Error(`System ${system?.id || 'unknown'} has an invalid contract runtime`);
  }
  const policy = normalizeContractPolicy(context.options?.contractPolicy ?? runtime.options.policy);
  const entry = findSystemReportEntry(context.report, system.id);
  const contractReport = {
    version: SYSTEM_CONTRACT_VERSION,
    policy,
    input: stageReport('not_run'),
    output: stageReport('not_run'),
    postconditions: stageReport('not_run'),
  };
  if (entry) entry.contract = contractReport;

  if (policy === CONTRACT_POLICIES.OFF) {
    contractReport.input.status = 'disabled';
    contractReport.output.status = 'disabled';
    contractReport.postconditions.status = 'disabled';
    return runtime.originalRun(context);
  }

  const state = ensureSystemContractState(context.world);
  const inputViolations = validateContractInputs(system.contract, context, runtime.options);
  contractReport.input = stageReport(inputViolations.length ? 'invalid' : 'valid', inputViolations);
  recordValidation(state, system, 'input', inputViolations, context.tick, policy);
  enforceViolations(system, 'input', inputViolations, context, policy);

  const result = runtime.originalRun(context);
  if (result && typeof result.then === 'function') return result;

  const outputViolations = validateContractOutput(system.contract, result, context, runtime.options);
  contractReport.output = stageReport(outputViolations.length ? 'invalid' : 'valid', outputViolations);
  recordValidation(state, system, 'output', outputViolations, context.tick, policy);
  enforceViolations(system, 'output', outputViolations, context, policy);

  const postViolations = validateContractPostconditions(system.contract, context, runtime.options);
  contractReport.postconditions = stageReport(postViolations.length ? 'invalid' : 'valid', postViolations);
  recordValidation(state, system, 'postconditions', postViolations, context.tick, policy);
  enforceViolations(system, 'postconditions', postViolations, context, policy);
  return result;
}

function validateContractInputs(contract, context, options = {}) {
  const root = validationRoot(context);
  const metadata = validationMetadata(context, 'input', options);
  const violations = validatePathRules(contract.inputs, root, metadata);
  appendCustomViolations(violations, contract.validateInput, root, metadata);
  return limitViolations(violations, options.maxViolations);
}

function validateContractOutput(contract, result, context, options = {}) {
  const metadata = validationMetadata(context, 'output', options, result);
  const violations = [];
  if (contract.output) validateSchema(result, contract.output, '$result', violations, metadata);
  appendCustomViolations(violations, contract.validateOutput, result, metadata);
  return limitViolations(violations, options.maxViolations);
}

function validateContractPostconditions(contract, context, options = {}) {
  const metadata = validationMetadata(context, 'postconditions', options);
  return limitViolations(
    validatePathRules(contract.postconditions, validationRoot(context), metadata),
    options.maxViolations,
  );
}

function validatePathRules(rules, root, metadata) {
  const violations = [];
  for (const rule of rules || []) {
    const resolved = resolvePath(root, rule.path);
    if (!resolved.exists) {
      if (!rule.optional) {
        violations.push(violation(
          metadata.stage,
          rule.path,
          'required_path_missing',
          `Required contract path ${rule.path} is missing`,
          describeSchema(rule.schema),
          'missing',
        ));
      }
      continue;
    }
    validateSchema(resolved.value, rule.schema, rule.path, violations, metadata);
  }
  return violations;
}

function validateSchema(value, schemaInput, path = '$', violations = [], metadata = {}) {
  const schema = normalizeSchema(schemaInput);
  if (schema.nullable && value === null) return violations;

  if (schema.anyOf?.length) {
    const candidates = schema.anyOf.map(candidate => {
      const output = [];
      validateSchema(value, candidate, path, output, metadata);
      return output;
    });
    if (!candidates.some(candidate => candidate.length === 0)) {
      violations.push(violation(
        metadata.stage,
        path,
        'any_of_mismatch',
        `${path} does not match any allowed schema`,
        schema.anyOf.map(describeSchema),
        describeValue(value),
      ));
    }
    return violations;
  }

  if (schema.type !== 'any' && !matchesType(value, schema.type)) {
    violations.push(violation(
      metadata.stage,
      path,
      'type_mismatch',
      `${path} must be ${schema.type}, received ${describeValue(value)}`,
      schema.type,
      describeValue(value),
    ));
    return violations;
  }

  validateScalarConstraints(value, schema, path, violations, metadata);
  if (Array.isArray(value)) validateArrayConstraints(value, schema, path, violations, metadata);
  if (isPlainObject(value)) validateObjectConstraints(value, schema, path, violations, metadata);
  if (typeof schema.validate === 'function') {
    appendCustomViolations(violations, schema.validate, value, { ...metadata, path, schema });
  }
  return violations;
}

function validateScalarConstraints(value, schema, path, violations, metadata) {
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    violations.push(violation(
      metadata.stage,
      path,
      'const_mismatch',
      `${path} must equal ${String(schema.const)}`,
      schema.const,
      safeValue(value, metadata.recordValues),
    ));
  }
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    violations.push(violation(
      metadata.stage,
      path,
      'enum_mismatch',
      `${path} is not an allowed value`,
      [...schema.enum],
      safeValue(value, metadata.recordValues),
    ));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push(keywordViolation(metadata.stage, path, 'minimum', schema.minimum, value));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push(keywordViolation(metadata.stage, path, 'maximum', schema.maximum, value));
    }
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      violations.push(keywordViolation(metadata.stage, path, 'minLength', schema.minLength, length));
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      violations.push(keywordViolation(metadata.stage, path, 'maxLength', schema.maxLength, length));
    }
    if (schema.pattern && !schema.pattern.test(value)) {
      violations.push(violation(
        metadata.stage,
        path,
        'pattern_mismatch',
        `${path} does not match ${schema.pattern}`,
        String(schema.pattern),
        metadata.recordValues ? value : `string(${value.length})`,
      ));
    }
  }
}

function validateArrayConstraints(value, schema, path, violations, metadata) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    violations.push(keywordViolation(metadata.stage, path, 'minItems', schema.minItems, value.length));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    violations.push(keywordViolation(metadata.stage, path, 'maxItems', schema.maxItems, value.length));
  }
  if (schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, violations, metadata));
  }
}

function validateObjectConstraints(value, schema, path, violations, metadata) {
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      violations.push(violation(
        metadata.stage,
        `${path}.${key}`,
        'required_property_missing',
        `${path} is missing required property ${key}`,
        describeSchema(schema.properties?.[key] || 'any'),
        'missing',
      ));
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateSchema(value[key], propertySchema, `${path}.${key}`, violations, metadata);
    }
  }
  if (schema.additionalProperties === false) {
    const declared = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(value)) {
      if (!declared.has(key)) {
        violations.push(violation(
          metadata.stage,
          `${path}.${key}`,
          'additional_property',
          `${path} contains undeclared property ${key}`,
          'declared property',
          key,
        ));
      }
    }
  }
}

function ensureSystemContractState(world) {
  const kernel = ensureSchedulerState(world);
  if (!kernel.contracts || typeof kernel.contracts !== 'object') {
    kernel.contracts = {
      version: SYSTEM_CONTRACT_VERSION,
      validations: 0,
      violations: 0,
      warnings: 0,
      failures: 0,
      inputFailures: 0,
      outputFailures: 0,
      postconditionFailures: 0,
      systems: {},
      lastViolation: null,
      recentViolations: [],
    };
  }
  const state = kernel.contracts;
  if (state.version !== SYSTEM_CONTRACT_VERSION) {
    throw new Error(`Unsupported system contract state version ${state.version}`);
  }
  if (!state.systems || typeof state.systems !== 'object') state.systems = {};
  if (!Array.isArray(state.recentViolations)) state.recentViolations = [];
  for (const key of [
    'validations',
    'violations',
    'warnings',
    'failures',
    'inputFailures',
    'outputFailures',
    'postconditionFailures',
  ]) {
    if (!Number.isInteger(state[key]) || state[key] < 0) state[key] = 0;
  }
  return state;
}

function getSystemContractSummary(world) {
  const state = ensureSystemContractState(world);
  return cloneCanonical({
    version: state.version,
    validations: state.validations,
    violations: state.violations,
    warnings: state.warnings,
    failures: state.failures,
    inputFailures: state.inputFailures,
    outputFailures: state.outputFailures,
    postconditionFailures: state.postconditionFailures,
    lastViolation: state.lastViolation,
    recentViolations: state.recentViolations,
    systems: Object.values(state.systems || {}).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function recordValidation(state, system, stage, violations, tick, policy) {
  state.validations += 1;
  if (!state.systems[system.id]) {
    state.systems[system.id] = {
      id: system.id,
      validations: 0,
      violations: 0,
      warnings: 0,
      failures: 0,
      lastStage: null,
      lastTick: null,
      lastViolation: null,
    };
  }
  const systemState = state.systems[system.id];
  systemState.validations += 1;
  systemState.lastStage = stage;
  systemState.lastTick = tick;
  if (!violations.length) return;

  state.violations += violations.length;
  systemState.violations += violations.length;
  if (stage === 'input') state.inputFailures += 1;
  if (stage === 'output') state.outputFailures += 1;
  if (stage === 'postconditions') state.postconditionFailures += 1;
  if (policy === CONTRACT_POLICIES.WARN) {
    state.warnings += 1;
    systemState.warnings += 1;
  } else {
    state.failures += 1;
    systemState.failures += 1;
  }

  const summary = {
    systemId: system.id,
    stage,
    tick,
    policy,
    violations: cloneCanonical(violations),
  };
  state.lastViolation = summary;
  systemState.lastViolation = summary;
  state.recentViolations.push(summary);
  if (state.recentViolations.length > 100) state.recentViolations.shift();
}

function enforceViolations(system, stage, violations, context, policy) {
  if (!violations.length || policy === CONTRACT_POLICIES.WARN) return;
  const error = new Error(`System ${system.id} ${stage} contract failed with ${violations.length} violation(s)`);
  error.name = 'SystemContractError';
  error.code = 'system_contract_violation';
  error.systemId = system.id;
  error.stage = stage;
  error.violations = cloneCanonical(violations);
  error.tick = context.tick;
  throw error;
}

function normalizeContractOptions(options = {}) {
  return {
    ...DEFAULT_CONTRACT_OPTIONS,
    ...(options || {}),
    policy: normalizeContractPolicy(options.policy ?? DEFAULT_CONTRACT_OPTIONS.policy),
    maxViolations: Math.max(1, Number(options.maxViolations || DEFAULT_CONTRACT_OPTIONS.maxViolations)),
    recordValues: Boolean(options.recordValues),
  };
}

function normalizeContractPolicy(value) {
  const policy = String(value || DEFAULT_CONTRACT_OPTIONS.policy).trim().toLowerCase();
  if (!Object.values(CONTRACT_POLICIES).includes(policy)) {
    throw new Error(`Unsupported system contract policy ${policy}`);
  }
  return policy;
}

function normalizePathRules(value) {
  const rules = Array.isArray(value) ? value : value ? [value] : [];
  return rules.map(rule => {
    if (typeof rule === 'string') return { path: rule, optional: false, schema: normalizeSchema('any') };
    if (!rule || typeof rule !== 'object') throw new Error('Contract path rule must be a string or object');
    const path = String(rule.path || '').trim();
    if (!path) throw new Error('Contract path rule requires path');
    return {
      path,
      optional: Boolean(rule.optional),
      schema: normalizeSchema(rule.schema ?? rule.type ?? 'any'),
    };
  });
}

function normalizeSchema(input) {
  if (typeof input === 'string') return { type: requireSupportedType(input) };
  if (typeof input === 'function') return { type: 'any', validate: input };
  if (!input || typeof input !== 'object') return { type: 'any' };
  const schema = { ...input };
  if (Array.isArray(schema.anyOf)) schema.anyOf = schema.anyOf.map(normalizeSchema);
  if (schema.items !== undefined) schema.items = normalizeSchema(schema.items);
  if (schema.properties && typeof schema.properties === 'object') {
    schema.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, normalizeSchema(value)]),
    );
  }
  schema.required = normalizeStringList(schema.required);
  schema.enum = Array.isArray(schema.enum) ? [...schema.enum] : null;
  if (schema.pattern && !(schema.pattern instanceof RegExp)) schema.pattern = new RegExp(String(schema.pattern));
  schema.type = schema.type ? requireSupportedType(schema.type) : (schema.anyOf ? null : 'any');
  return schema;
}

function resolvePath(root, path) {
  let current = root;
  for (const part of parsePath(path)) {
    if (current === null || current === undefined) return { exists: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(Object(current), part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function appendCustomViolations(violations, validator, value, metadata) {
  if (typeof validator !== 'function') return;
  let result;
  try {
    result = validator(value, metadata);
  } catch (error) {
    result = {
      path: metadata.path || '$custom',
      code: 'validator_exception',
      message: error.message || String(error),
      expected: 'validator success',
      actual: 'exception',
    };
  }
  for (const item of normalizeCustomResult(result, metadata)) violations.push(item);
}

function normalizeCustomResult(result, metadata) {
  if (result === undefined || result === null || result === true) return [];
  if (result === false) {
    return [violation(
      metadata.stage,
      metadata.path || '$custom',
      'custom_validation_failed',
      'Custom contract validator returned false',
      'validator success',
      false,
    )];
  }
  if (typeof result === 'string') {
    return [violation(
      metadata.stage,
      metadata.path || '$custom',
      'custom_validation_failed',
      result,
      'validator success',
      'invalid',
    )];
  }
  return (Array.isArray(result) ? result : [result]).map(item => violation(
    item?.stage || metadata.stage,
    item?.path || metadata.path || '$custom',
    item?.code || 'custom_validation_failed',
    item?.message || 'Custom contract validation failed',
    item?.expected ?? 'validator success',
    item?.actual ?? 'invalid',
  ));
}

function validationRoot(context) {
  return {
    world: context.world,
    shared: context.shared,
    options: context.options,
    system: context.system,
    report: context.report,
    tick: context.tick,
    targetTick: context.targetTick,
  };
}

function validationMetadata(context, stage, options, result) {
  return {
    stage,
    systemId: context.system.id,
    context,
    result,
    recordValues: Boolean(options.recordValues),
  };
}

function stageReport(status, violations = []) {
  return { status, violations: cloneCanonical(violations) };
}

function violation(stage, path, code, message, expected, actual) {
  return {
    stage: stage || 'unknown',
    path: path || '$',
    code: code || 'contract_violation',
    message: message || 'System contract violation',
    expected: expected ?? null,
    actual: actual ?? null,
  };
}

function keywordViolation(stage, path, keyword, expected, actual) {
  return violation(
    stage,
    path,
    `${keyword}_violation`,
    `${path} violates ${keyword} ${expected}`,
    expected,
    actual,
  );
}

function matchesType(value, type) {
  if (type === 'any' || type === null) return true;
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function requireSupportedType(type) {
  const value = String(type || '').trim();
  if (!['any', 'null', 'array', 'object', 'integer', 'number', 'string', 'boolean'].includes(value)) {
    throw new Error(`Unsupported contract schema type ${value}`);
  }
  return value;
}

function describeSchema(input) {
  const schema = normalizeSchema(input);
  if (schema.anyOf) return `anyOf(${schema.anyOf.map(describeSchema).join(', ')})`;
  if (schema.const !== undefined) return `const(${String(schema.const)})`;
  if (schema.enum) return `enum(${schema.enum.map(String).join(', ')})`;
  return schema.type || 'any';
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : String(value);
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

function safeValue(value, recordValues) {
  if (!recordValues) return describeValue(value);
  try { return cloneCanonical(value); }
  catch (_error) { return describeValue(value); }
}

function parsePath(path) {
  return String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean);
}

function findSystemReportEntry(report, systemId) {
  if (!Array.isArray(report?.systems)) return null;
  for (let index = report.systems.length - 1; index >= 0; index -= 1) {
    if (report.systems[index].id === systemId) return report.systems[index];
  }
  return null;
}

function limitViolations(violations, maxViolations) {
  return violations.slice(0, Math.max(1, Number(maxViolations || DEFAULT_CONTRACT_OPTIONS.maxViolations)));
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRegistry(registry) {
  if (!registry?.systems || typeof registry.systems !== 'object') {
    throw new Error('System contract operation requires a system registry');
  }
}

module.exports = {
  SYSTEM_CONTRACT_VERSION,
  CONTRACT_POLICIES,
  DEFAULT_CONTRACT_OPTIONS,
  createSystemContract,
  attachSystemContract,
  detachSystemContract,
  attachRegistryContracts,
  analyzeContractCoverage,
  validateContractInputs,
  validateContractOutput,
  validateContractPostconditions,
  validateSchema,
  ensureSystemContractState,
  getSystemContractSummary,
  normalizeContractOptions,
  normalizeContractPolicy,
  normalizeSchema,
  resolvePath,
  describeSchema,
  describeValue,
};
