'use strict';

const { cloneCanonical } = require('./state-integrity-engine');

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
  const config = normalizeContractOptions(options);
  system.contract = contract;
  system.contractRuntime = {
    version: SYSTEM_CONTRACT_VERSION,
    originalRun,
    options: config,
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
  if (!registry?.systems || typeof registry.systems !== 'object') {
    throw new Error('attachRegistryContracts requires a system registry');
  }
  const attached = [];
  const missingSystems = [];
  const missingContracts = [];
  for (const [systemId, definition] of Object.entries(contracts || {})) {
    const system = registry.systems[systemId];
    if (!system) {
      missingSystems.push(systemId);
      continue;
    }
    attachSystemContract(system, definition, options);
    attached.push(systemId);
  }
  for (const systemId of Object.keys(registry.systems)) {
    if (!registry.systems[systemId].contract) missingContracts.push(systemId);
  }
  return {
    attached: attached.sort(),
    missingSystems: missingSystems.sort(),
    missingContracts: missingContracts.sort(),
    coverage: Object.keys(registry.systems).length
      ? attached.length / Object.keys(registry.systems).length
      : 1,
  };
}

function analyzeContractCoverage(registry) {
  if (!registry?.systems || typeof registry.systems !== 'object') {
    throw new Error('analyzeContractCoverage requires a system registry');
  }
  const systems = Object.values(registry.systems);
  const contracted = systems.filter(system => Boolean(system.contract));
  return {
    systems: systems.length,
    contracted: contracted.length,
    uncontracted: systems.length - contracted.length,
    coverage: systems.length ? contracted.length / systems.length : 1,
    contractedIds: contracted.map(system => system.id).sort(),
    uncontractedIds: systems.filter(system => !system.contract).map(system => system.id).sort(),
  };
}

function executeContractedSystem(system, context) {
  const runtime = system.contractRuntime;
  if (!runtime?.originalRun || !system.contract) return system.run(context);
  const policy = normalizeContractPolicy(context.options?.contractPolicy ?? runtime.options.policy);
  const entry = findSystemReportEntry(context.report, system.id);
  const contractReport = {
    version: SYSTEM_CONTRACT_VERSION,
    policy,
    input: { status: 'not_run', violations: [] },
    output: { status: 'not_run', violations: [] },
    postconditions: { status: 'not_run', violations: [] },
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
  contractReport.input = createStageReport(inputViolations);
  recordContractValidation(state, system, 'input', inputViolations, context.tick, policy);
  handleContractViolations(system, 'input', inputViolations, context, policy);

  const result = runtime.originalRun(context);
  if (result && typeof result.then === 'function') return result;

  const outputViolations = validateContractOutput(system.contract, result, context, runtime.options);
  contractReport.output = createStageReport(outputViolations);
  recordContractValidation(state, system, 'output', outputViolations, context.tick, policy);
  handleContractViolations(system, 'output', outputViolations, context, policy);

  const postconditionViolations = validateContractPostconditions(system.contract, context, runtime.options);
  contractReport.postconditions = createStageReport(postconditionViolations);
  recordContractValidation(state, system, 'postconditions', postconditionViolations, context.tick, policy);
  handleContractViolations(system, 'postconditions', postconditionViolations, context, policy);
  return result;
}

function validateContractInputs(contract, context, options = {}) {
  const root = createValidationRoot(context, undefined);
  const violations = validatePathRules(contract.inputs, root, {
    ...options,
    stage: 'input',
    systemId: context.system.id,
    context,
  });
  appendCustomViolations(
    violations,
    contract.validateInput,
    root,
    createValidationMetadata(context, 'input', undefined),
    options,
  );
  return limitViolations(violations, options.maxViolations);
}

function validateContractOutput(contract, result, context, options = {}) {
  const violations = [];
  if (contract.output) {
    validateSchema(result, contract.output, '$result', violations, {
      ...options,
      stage: 'output',
      systemId: context.system.id,
      context,
    });
  }
  appendCustomViolations(
    violations,
    contract.validateOutput,
    result,
    createValidationMetadata(context, 'output', result),
    options,
  );
  return limitViolations(violations, options.maxViolations);
}

function validateContractPostconditions(contract, context, options = {}) {
  const root = createValidationRoot(context, undefined);
  return limitViolations(validatePathRules(contract.postconditions, root, {
    ...options,
    stage: 'postconditions',
    systemId: context.system.id,
    context,
  }), options.maxViolations);
}

function validatePathRules(rules, root, metadata = {}) {
  const violations = [];
  for (const rule of rules || []) {
    const resolved = resolvePath(root, rule.path);
    if (!resolved.exists && rule.optional) continue;
    if (!resolved.exists) {
      violations.push(createViolation({
        stage: metadata.stage,
        path: rule.path,
        code: 'required_path_missing',
        message: `Required contract path ${rule.path} is missing`,
        expected: describeSchema(rule.schema),
        actual: 'missing',
      }));
      continue;
    }
    validateSchema(resolved.value, rule.schema, rule.path, violations, metadata);
  }
  return violations;
}

function validateSchema(value, schemaInput, path, violations, metadata = {}) {
  const schema = normalizeSchema(schemaInput);
  if (schema.nullable && value === null) return violations;
  if (schema.anyOf?.length) {
    const candidateViolations = schema.anyOf.map(candidate => {
      const output = [];
      validateSchema(value, candidate, path, output, metadata);
      return output;
    });
    if (candidateViolations.some(candidate => candidate.length === 0)) return violations;
    violations.push(createViolation({
      stage: metadata.stage,
      path,
      code: 'any_of_mismatch',
      message: `${path} does not match any allowed schema`,
      expected: schema.anyOf.map(describeSchema),
      actual: describeValue(value),
    }));
    return violations;
  }

  if (schema.type && schema.type !== 'any' && !matchesType(value, schema.type)) {
    violations.push(createViolation({
      stage: metadata.stage,
      path,
      code: 'type_mismatch',
      message: `${path} must be ${schema.type}, received ${describeValue(value)}`,
      expected: schema.type,
      actual: describeValue(value),
    }));
    return violations;
  }

  if (schema.const !== undefined && !isEqualPrimitive(value, schema.const)) {
    violations.push(createViolation({
      stage: metadata.stage,
      path,
      code: 'const_mismatch',
      message: `${path} must equal ${String(schema.const)}`,
      expected: schema.const,
      actual: safeValue(value, metadata.recordValues),
    }));
  }

  if (schema.enum && !schema.enum.some(item => isEqualPrimitive(value, item))) {
    violations.push(createViolation({
      stage: metadata.stage,
      path,
      code: 'enum_mismatch',
      message: `${path} is not an allowed value`,
      expected: [...schema.enum],
      actual: safeValue(value, metadata.recordValues),
    }));
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push(rangeViolation(metadata.stage, path, 'minimum', schema.minimum, value));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push(rangeViolation(metadata.stage, path, 'maximum', schema.maximum, value));
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {
      violations.push(lengthViolation(metadata.stage, path, 'minLength', schema.minLength, Array.from(value).length));
    }
    if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) {
      violations.push(lengthViolation(metadata.stage, path, 'maxLength', schema.maxLength, Array.from(value).length));
    }
    if (schema.pattern && !schema.pattern.test(value)) {
      violations.push(createViolation({
        stage: metadata.stage,
        path,
        code: 'pattern_mismatch',
        message: `${path} does not match ${schema.pattern}`,
        expected: String(schema.pattern),
        actual: metadata.recordValues ? value : `string(${value.length})`,
      }));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push(lengthViolation(metadata.stage, path, 'minItems', schema.minItems, value.length));
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push(lengthViolation(metadata.stage, path, 'maxItems', schema.maxItems, value.length));
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, violations, metadata));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        violations.push(createViolation({
          stage: metadata.stage,
          path: `${path}.${key}`,
          code: 'required_property_missing',
          message: `${path} is missing required property ${key}`,
          expected: describeSchema(schema.properties?.[key] || { type: 'any' }),
          actual: 'missing',
        }));
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      validateSchema(value[key], propertySchema, `${path}.${key}`, violations, metadata);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          violations.push(createViolation({
            stage: metadata.stage,
            path: `${path}.${key}`,
            code: 'additional_property',
            message: `${path} contains undeclared property ${key}`,
            expected: 'declared property',
            actual: key,
          }));
        }
      }
    }
  }

  if (typeof schema.validate === 'function') {
    appendCustomViolations(violations, schema.validate, value, {
      ...metadata,
      path,
      schema,
    }, metadata);
  }
  return violations;
}

function ensureSystemContractState(world) {
  if (!world.kernel || typeof world.kernel !== 'object') world.kernel = {};
  if (!world.kernel.contracts || typeof world.kernel.contracts !== 'object') {
    world.kernel.contracts = {
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
  const state = world.kernel.contracts;
  if (state.version !== SYSTEM_CONTRACT_VERSION) {
    throw new Error(`Unsupported system contract state version ${state.version}`);
  }
  if (!state.systems || typeof state.systems !== 'object') state.systems = {};
  if (!Array.isArray(state.recentViolations)) state.recentViolations = [];
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

function recordContractValidation(state, system, stage, violations, tick, policy) {
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

function handleContractViolations(system, stage, violations, context, policy) {
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
    if (typeof rule === 'string') return { path: rule, optional: false, schema: { type: 'any' } };
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

function normalizeSchema(schema) {
  if (typeof schema === 'string') return { type: schema };
  if (typeof schema === 'function') return { type: 'any', validate: schema };
  if (!schema || typeof schema !== 'object') return { type: 'any' };
  const output = { ...schema };
  if (Array.isArray(output.anyOf)) output.anyOf = output.anyOf.map(normalizeSchema);
  if (output.items !== undefined) output.items = normalizeSchema(output.items);
  if (output.properties && typeof output.properties === 'object') {
    output.properties = Object.fromEntries(
      Object.entries(output.properties).map(([key, value]) => [key, normalizeSchema(value)]),
    );
  }
  output.required = normalizeStringList(output.required);
  output.enum = Array.isArray(output.enum) ? [...output.enum] : null;
  if (output.pattern && !(output.pattern instanceof RegExp)) output.pattern = new RegExp(String(output.pattern));
  if (output.type && !isSupportedType(output.type)) throw new Error(`Unsupported contract schema type ${output.type}`);
  if (!output.type && !output.anyOf) output.type = 'any';
  return output;
}

function createStageReport(violations) {
  return {
    status: violations.length ? 'invalid' : 'valid',
    violations: cloneCanonical(violations),
  };
}

function createValidationRoot(context, result) {
  return {
    world: context.world,
    shared: context.shared,
    options: context.options,
    system: context.system,
    report: context.report,
    tick: context.tick,
    targetTick: context.targetTick,
    result,
  };
}

function createValidationMetadata(context, stage, result) {
  return {
    stage,
    systemId: context.system.id,
    context,
    result,
  };
}

function appendCustomViolations(violations, validator, value, metadata, options = {}) {
  if (typeof validator !== 'function') return;
  let result;
  try {
    result = validator(value, metadata);
  } catch (error) {
    violations.push(createViolation({
      stage: metadata.stage,
      path: metadata.path || '$custom',
      code: 'validator_exception',
      message: error.message || String(error),
      expected: 'validator success',
      actual: 'exception',
    }));
    return;
  }
  for (const item of normalizeCustomValidatorResult(result, metadata)) violations.push(item);
  if (violations.length > Number(options.maxViolations || DEFAULT_CONTRACT_OPTIONS.maxViolations)) {
    violations.length = Number(options.maxViolations || DEFAULT_CONTRACT_OPTIONS.maxViolations);
  }
}

function normalizeCustomValidatorResult(result, metadata) {
  if (result === undefined || result === null || result === true) return [];
  if (result === false) {
    return [createViolation({
      stage: metadata.stage,
      path: metadata.path || '$custom',
      code: 'custom_validation_failed',
      message: 'Custom contract validator returned false',
      expected: 'validator success',
      actual: false,
    })];
  }
  if (typeof result === 'string') {
    return [createViolation({
      stage: metadata.stage,
      path: metadata.path || '$custom',
      code: 'custom_validation_failed',
      message: result,
      expected: 'validator success',
      actual: 'invalid',
    })];
  }
  const values = Array.isArray(result) ? result : [result];
  return values.map(item => createViolation({
    stage: item?.stage || metadata.stage,
    path: item?.path || metadata.path || '$custom',
    code: item?.code || 'custom_validation_failed',
    message: item?.message || 'Custom contract validation failed',
    expected: item?.expected ?? 'validator success',
    actual: item?.actual ?? 'invalid',
  }));
}

function resolvePath(root, path) {
  const parts = parsePath(path);
  let current = root;
  for (const part of parts) {
    if (current === null || current === undefined) return { exists: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(Object(current), part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function parsePath(path) {
  return String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function isSupportedType(type) {
  return ['any', 'null', 'array', 'object', 'integer', 'number', 'string', 'boolean'].includes(type);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEqualPrimitive(left, right) {
  return Object.is(left, right);
}

function describeSchema(schemaInput) {
  const schema = normalizeSchema(schemaInput);
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

function createViolation(input) {
  return {
    stage: input.stage || 'unknown',
    path: input.path || '$',
    code: input.code || 'contract_violation',
    message: input.message || 'System contract violation',
    expected: input.expected ?? null,
    actual: input.actual ?? null,
  };
}

function rangeViolation(stage, path, keyword, expected, actual) {
  return createViolation({
    stage,
    path,
    code: `${keyword}_violation`,
    message: `${path} violates ${keyword} ${expected}`,
    expected,
    actual,
  });
}

function lengthViolation(stage, path, keyword, expected, actual) {
  return createViolation({
    stage,
    path,
    code: `${keyword}_violation`,
    message: `${path} violates ${keyword} ${expected}`,
    expected,
    actual,
  });
}

function findSystemReportEntry(report, systemId) {
  if (!Array.isArray(report?.systems)) return null;
  for (let index = report.systems.length - 1; index >= 0; index -= 1) {
    if (report.systems[index].id === systemId) return report.systems[index];
  }
  return null;
}

function limitViolations(violations, maxViolations) {
  const max = Math.max(1, Number(maxViolations || DEFAULT_CONTRACT_OPTIONS.maxViolations));
  return violations.slice(0, max);
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
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
