'use strict';

const { cloneCanonical } = require('./state-integrity-engine');

const SYSTEM_CONTRACT_VERSION = 1;
const CONTRACT_STAGES = ['before', 'result', 'after'];
const CONTRACT_POLICIES = ['error', 'warn', 'off'];
const CONTRACT_SEVERITIES = ['error', 'warning'];
const DEFAULT_CONTRACT_OPTIONS = {
  policy: 'error',
  maxIssues: 50,
  includeValues: false,
};

function normalizeSystemContracts(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const normalized = {};
  for (const stage of CONTRACT_STAGES) {
    const entries = Array.isArray(source[stage])
      ? source[stage]
      : source[stage]
        ? [source[stage]]
        : [];
    normalized[stage] = entries.map((contract, index) => normalizeContract(contract, stage, index));
  }
  return normalized;
}

function normalizeContract(contract, stage, index) {
  if (typeof contract === 'function') {
    return {
      id: contract.name || `${stage}.${index + 1}`,
      severity: 'error',
      target: stage === 'result' ? 'result' : 'world',
      path: '',
      required: false,
      validator: contract,
      raw: null,
    };
  }
  if (!contract || typeof contract !== 'object') {
    throw new Error(`Invalid ${stage} contract at index ${index}`);
  }
  const severity = normalizeSeverity(contract.severity);
  const target = normalizeTarget(contract.target || (stage === 'result' ? 'result' : 'world'));
  return {
    id: String(contract.id || `${stage}.${index + 1}`).trim(),
    severity,
    target,
    path: normalizePath(contract.path),
    required: contract.required !== false && contract.allowUndefined !== true,
    nullable: contract.nullable === true,
    type: normalizeTypes(contract.type),
    enum: Array.isArray(contract.enum) ? [...contract.enum] : null,
    min: numberOrNull(contract.min),
    max: numberOrNull(contract.max),
    integer: contract.integer === true,
    finite: contract.finite !== false,
    minLength: integerOrNull(contract.minLength),
    maxLength: integerOrNull(contract.maxLength),
    minItems: integerOrNull(contract.minItems),
    maxItems: integerOrNull(contract.maxItems),
    message: contract.message ? String(contract.message) : null,
    code: contract.code ? String(contract.code) : null,
    predicate: typeof contract.predicate === 'function'
      ? contract.predicate
      : typeof contract.validate === 'function'
        ? contract.validate
        : null,
    validator: null,
    metadata: contract.metadata && typeof contract.metadata === 'object'
      ? { ...contract.metadata }
      : null,
    raw: { ...contract },
  };
}

function evaluateSystemContracts(system, stage, payload = {}, options = {}) {
  const config = normalizeContractOptions(options);
  const normalizedStage = normalizeStage(stage);
  const contracts = normalizeSystemContracts(system?.contracts || {})[normalizedStage];
  const issues = [];
  let checked = 0;

  if (config.policy === 'off' || !contracts.length) {
    return createContractReport(system, normalizedStage, checked, issues, config);
  }

  for (const contract of contracts) {
    checked += 1;
    const remaining = Math.max(0, config.maxIssues - issues.length);
    if (remaining === 0) break;
    const contractIssues = evaluateOneContract(contract, normalizedStage, system, payload, config)
      .slice(0, remaining);
    issues.push(...contractIssues);
  }

  if (issues.length >= config.maxIssues && contracts.length > checked) {
    issues.push(createIssue({
      contract: { id: 'contract.issue_limit', severity: 'warning', target: 'system', path: '' },
      stage: normalizedStage,
      system,
      code: 'contract_issue_limit_reached',
      message: `Contract issue limit ${config.maxIssues} reached`,
      expected: `at most ${config.maxIssues} issues`,
      actualType: 'issue_limit',
      config,
    }));
  }

  return createContractReport(system, normalizedStage, checked, issues, config);
}

function assertSystemContracts(system, stage, payload = {}, options = {}) {
  const report = evaluateSystemContracts(system, stage, payload, options);
  const policy = normalizeContractOptions(options).policy;
  if (policy === 'error' && report.errors > 0) {
    throw createSystemContractError(system, stage, report);
  }
  return report;
}

function evaluateOneContract(contract, stage, system, payload, config) {
  const contractContext = createContractContext(system, stage, payload, config);
  if (contract.validator) {
    return evaluateValidatorResult(
      contract,
      stage,
      system,
      invokeValidator(contract.validator, contractContext),
      config,
    );
  }

  const root = resolveTarget(contract.target, contractContext);
  const lookup = getPathValue(root, contract.path);
  const value = lookup.value;
  const issues = [];

  if (!lookup.found || value === undefined) {
    if (contract.required) {
      issues.push(createIssue({
        contract,
        stage,
        system,
        code: contract.code || 'contract_required_value_missing',
        message: contract.message || `Required ${contract.target}${formatPath(contract.path)} is missing`,
        expected: expectedDescription(contract),
        actualType: 'undefined',
        actualValue: value,
        config,
      }));
    }
    return issues;
  }

  if (value === null) {
    if (!contract.nullable) {
      issues.push(createIssue({
        contract,
        stage,
        system,
        code: contract.code || 'contract_null_not_allowed',
        message: contract.message || `${contract.target}${formatPath(contract.path)} must not be null`,
        expected: expectedDescription(contract),
        actualType: 'null',
        actualValue: value,
        config,
      }));
    }
    return issues;
  }

  if (contract.type.length && !contract.type.includes(valueType(value))) {
    issues.push(createIssue({
      contract,
      stage,
      system,
      code: contract.code || 'contract_type_mismatch',
      message: contract.message || `${contract.target}${formatPath(contract.path)} must be ${contract.type.join(' or ')}`,
      expected: contract.type.join('|'),
      actualType: valueType(value),
      actualValue: value,
      config,
    }));
    return issues;
  }

  if (contract.enum && !contract.enum.some(item => Object.is(item, value))) {
    issues.push(createIssue({
      contract,
      stage,
      system,
      code: contract.code || 'contract_enum_mismatch',
      message: contract.message || `${contract.target}${formatPath(contract.path)} is outside the allowed enum`,
      expected: `one of ${contract.enum.map(item => JSON.stringify(item)).join(', ')}`,
      actualType: valueType(value),
      actualValue: value,
      config,
    }));
  }

  if (typeof value === 'number') {
    if (contract.finite && !Number.isFinite(value)) {
      issues.push(numericIssue(contract, stage, system, config, value, 'contract_number_not_finite', 'a finite number'));
    }
    if (contract.integer && !Number.isInteger(value)) {
      issues.push(numericIssue(contract, stage, system, config, value, 'contract_integer_required', 'an integer'));
    }
    if (contract.min !== null && value < contract.min) {
      issues.push(numericIssue(contract, stage, system, config, value, 'contract_minimum_violation', `>= ${contract.min}`));
    }
    if (contract.max !== null && value > contract.max) {
      issues.push(numericIssue(contract, stage, system, config, value, 'contract_maximum_violation', `<= ${contract.max}`));
    }
  }

  if (typeof value === 'string' || Array.isArray(value)) {
    if (contract.minLength !== null && value.length < contract.minLength) {
      issues.push(lengthIssue(contract, stage, system, config, value, 'contract_min_length_violation', `length >= ${contract.minLength}`));
    }
    if (contract.maxLength !== null && value.length > contract.maxLength) {
      issues.push(lengthIssue(contract, stage, system, config, value, 'contract_max_length_violation', `length <= ${contract.maxLength}`));
    }
  }

  if (Array.isArray(value)) {
    if (contract.minItems !== null && value.length < contract.minItems) {
      issues.push(lengthIssue(contract, stage, system, config, value, 'contract_min_items_violation', `items >= ${contract.minItems}`));
    }
    if (contract.maxItems !== null && value.length > contract.maxItems) {
      issues.push(lengthIssue(contract, stage, system, config, value, 'contract_max_items_violation', `items <= ${contract.maxItems}`));
    }
  }

  if (contract.predicate) {
    const predicateResult = invokePredicate(contract.predicate, value, contractContext);
    issues.push(...evaluateValidatorResult(contract, stage, system, predicateResult, config));
  }

  return deduplicateIssues(issues);
}

function createContractContext(system, stage, payload, config) {
  return {
    version: SYSTEM_CONTRACT_VERSION,
    system,
    stage,
    world: payload.world,
    result: payload.result,
    context: payload.context,
    shared: payload.shared ?? payload.context?.shared,
    report: payload.report ?? payload.context?.report,
    config,
    get: (target, path) => getPathValue(resolveTarget(target, {
      world: payload.world,
      result: payload.result,
      context: payload.context,
      shared: payload.shared ?? payload.context?.shared,
      report: payload.report ?? payload.context?.report,
      system,
    }), path).value,
    has: (target, path) => getPathValue(resolveTarget(target, {
      world: payload.world,
      result: payload.result,
      context: payload.context,
      shared: payload.shared ?? payload.context?.shared,
      report: payload.report ?? payload.context?.report,
      system,
    }), path).found,
    typeOf: valueType,
  };
}

function evaluateValidatorResult(contract, stage, system, value, config) {
  if (value === undefined || value === null || value === true) return [];
  if (value && typeof value.then === 'function') {
    return [createIssue({
      contract,
      stage,
      system,
      code: 'contract_async_validator_forbidden',
      message: `Contract ${contract.id} returned a Promise; contracts must be synchronous`,
      expected: 'synchronous validator result',
      actualType: 'promise',
      config,
    })];
  }
  if (value === false) {
    return [createIssue({
      contract,
      stage,
      system,
      code: contract.code || 'contract_predicate_failed',
      message: contract.message || `Contract ${contract.id} failed`,
      expected: expectedDescription(contract),
      actualType: 'predicate_false',
      config,
    })];
  }
  if (typeof value === 'string') {
    return [createIssue({
      contract,
      stage,
      system,
      code: contract.code || 'contract_predicate_failed',
      message: value,
      expected: expectedDescription(contract),
      actualType: 'predicate_message',
      config,
    })];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => evaluateValidatorResult(contract, stage, system, item, config));
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.issues)) {
      return value.issues.flatMap(item => evaluateValidatorResult(contract, stage, system, item, config));
    }
    if (value.ok === true) return [];
    const issueContract = {
      ...contract,
      severity: normalizeSeverity(value.severity || contract.severity),
      target: value.target ? normalizeTarget(value.target) : contract.target,
      path: value.path !== undefined ? normalizePath(value.path) : contract.path,
    };
    return [createIssue({
      contract: issueContract,
      stage,
      system,
      code: value.code || contract.code || 'contract_predicate_failed',
      message: value.message || contract.message || `Contract ${contract.id} failed`,
      expected: value.expected || expectedDescription(contract),
      actualType: value.actualType || 'predicate_result',
      actualValue: value.actual,
      config,
    })];
  }
  return [createIssue({
    contract,
    stage,
    system,
    code: 'contract_invalid_validator_result',
    message: `Contract ${contract.id} returned unsupported validator result ${valueType(value)}`,
    expected: 'boolean, string, issue object, array, null or undefined',
    actualType: valueType(value),
    actualValue: value,
    config,
  })];
}

function invokeValidator(validator, context) {
  try {
    return validator(context);
  } catch (error) {
    return {
      ok: false,
      code: 'contract_validator_threw',
      message: `Contract validator threw: ${error.message}`,
      actualType: error?.name || 'Error',
    };
  }
}

function invokePredicate(predicate, value, context) {
  try {
    return predicate(value, context);
  } catch (error) {
    return {
      ok: false,
      code: 'contract_predicate_threw',
      message: `Contract predicate threw: ${error.message}`,
      actualType: error?.name || 'Error',
    };
  }
}

function createContractReport(system, stage, checked, issues, config) {
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  const errors = issues.filter(issue => issue.severity === 'error').length;
  return {
    version: SYSTEM_CONTRACT_VERSION,
    systemId: system?.id || null,
    stage,
    policy: config.policy,
    checked,
    passed: errors === 0,
    warnings,
    errors,
    issues,
  };
}

function compactContractReport(report) {
  if (!report) return null;
  return {
    version: report.version,
    systemId: report.systemId,
    stage: report.stage,
    policy: report.policy,
    checked: report.checked,
    passed: report.passed,
    warnings: report.warnings,
    errors: report.errors,
    issues: (report.issues || []).map(issue => ({ ...issue })),
  };
}

function createSystemContractError(system, stage, report) {
  const first = report.issues.find(issue => issue.severity === 'error') || report.issues[0];
  const error = new Error(`System ${system?.id || 'unknown'} ${stage} contract failed: ${first?.message || 'unknown contract violation'}`);
  error.name = 'SystemContractError';
  error.code = 'system_contract_failed';
  error.systemId = system?.id || null;
  error.stage = stage;
  error.contractId = first?.contractId || null;
  error.contractReport = compactContractReport(report);
  return error;
}

function createIssue({
  contract,
  stage,
  system,
  code,
  message,
  expected,
  actualType,
  actualValue,
  config,
}) {
  const issue = {
    contractId: contract?.id || null,
    systemId: system?.id || null,
    stage,
    severity: normalizeSeverity(contract?.severity),
    code: code || 'contract_violation',
    message: String(message || 'Contract violation'),
    target: contract?.target || null,
    path: contract?.path || '',
    expected: expected || null,
    actualType: actualType || 'unknown',
  };
  if (config?.includeValues && actualValue !== undefined) {
    issue.actual = safeCloneValue(actualValue);
  }
  if (contract?.metadata) issue.metadata = { ...contract.metadata };
  return issue;
}

function numericIssue(contract, stage, system, config, value, code, expected) {
  return createIssue({
    contract,
    stage,
    system,
    code: contract.code || code,
    message: contract.message || `${contract.target}${formatPath(contract.path)} must be ${expected}`,
    expected,
    actualType: valueType(value),
    actualValue: value,
    config,
  });
}

function lengthIssue(contract, stage, system, config, value, code, expected) {
  return createIssue({
    contract,
    stage,
    system,
    code: contract.code || code,
    message: contract.message || `${contract.target}${formatPath(contract.path)} must have ${expected}`,
    expected,
    actualType: valueType(value),
    actualValue: value,
    config,
  });
}

function resolveTarget(target, context) {
  if (target === 'world') return context.world;
  if (target === 'result') return context.result;
  if (target === 'context') return context.context;
  if (target === 'shared') return context.shared;
  if (target === 'report') return context.report;
  if (target === 'system') return context.system;
  return undefined;
}

function getPathValue(root, path) {
  if (!path) return { found: root !== undefined, value: root };
  const tokens = tokenizePath(path);
  let current = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(Object(current), token)) {
      return { found: false, value: undefined };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

function tokenizePath(path) {
  return String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(token => token.trim())
    .filter(Boolean);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  if (Buffer.isBuffer(value)) return 'buffer';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function expectedDescription(contract) {
  const descriptions = [];
  if (contract.type?.length) descriptions.push(contract.type.join('|'));
  if (contract.enum) descriptions.push(`enum(${contract.enum.length})`);
  if (contract.integer) descriptions.push('integer');
  if (contract.min !== null) descriptions.push(`>=${contract.min}`);
  if (contract.max !== null) descriptions.push(`<=${contract.max}`);
  if (contract.minLength !== null) descriptions.push(`minLength=${contract.minLength}`);
  if (contract.maxLength !== null) descriptions.push(`maxLength=${contract.maxLength}`);
  if (contract.minItems !== null) descriptions.push(`minItems=${contract.minItems}`);
  if (contract.maxItems !== null) descriptions.push(`maxItems=${contract.maxItems}`);
  return descriptions.join(', ') || (contract.required ? 'defined value' : 'valid value');
}

function normalizeContractOptions(options = {}) {
  const policy = normalizeContractPolicy(options.contractPolicy ?? options.policy);
  return {
    ...DEFAULT_CONTRACT_OPTIONS,
    ...(options || {}),
    policy,
    maxIssues: Math.max(1, Math.floor(Number(options.contractMaxIssues ?? options.maxIssues ?? DEFAULT_CONTRACT_OPTIONS.maxIssues))),
    includeValues: Boolean(options.contractIncludeValues ?? options.includeValues ?? DEFAULT_CONTRACT_OPTIONS.includeValues),
  };
}

function normalizeContractPolicy(value) {
  const policy = String(value || DEFAULT_CONTRACT_OPTIONS.policy).trim().toLowerCase();
  if (!CONTRACT_POLICIES.includes(policy)) throw new Error(`Unsupported contract policy ${policy}`);
  return policy;
}

function normalizeStage(stage) {
  const value = String(stage || '').trim().toLowerCase();
  if (!CONTRACT_STAGES.includes(value)) throw new Error(`Unsupported contract stage ${value || '(empty)'}`);
  return value;
}

function normalizeSeverity(value) {
  const severity = String(value || 'error').trim().toLowerCase();
  if (!CONTRACT_SEVERITIES.includes(severity)) throw new Error(`Unsupported contract severity ${severity}`);
  return severity;
}

function normalizeTarget(value) {
  const target = String(value || 'world').trim().toLowerCase();
  if (!['world', 'result', 'context', 'shared', 'report', 'system'].includes(target)) {
    throw new Error(`Unsupported contract target ${target}`);
  }
  return target;
}

function normalizeTypes(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(type => String(type || '').trim().toLowerCase()).filter(Boolean))];
}

function normalizePath(value) {
  return String(value || '').trim().replace(/^\.+|\.+$/g, '');
}

function formatPath(path) {
  return path ? `.${path}` : '';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected finite number, received ${value}`);
  return number;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  if (!Number.isInteger(number) || number < 0) throw new Error(`Expected non-negative integer, received ${value}`);
  return number;
}

function safeCloneValue(value) {
  try { return cloneCanonical(value); }
  catch (_error) { return String(value); }
}

function deduplicateIssues(issues) {
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.contractId}|${issue.stage}|${issue.code}|${issue.target}|${issue.path}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  SYSTEM_CONTRACT_VERSION,
  CONTRACT_STAGES,
  CONTRACT_POLICIES,
  CONTRACT_SEVERITIES,
  DEFAULT_CONTRACT_OPTIONS,
  normalizeSystemContracts,
  normalizeContract,
  evaluateSystemContracts,
  assertSystemContracts,
  compactContractReport,
  createSystemContractError,
  normalizeContractOptions,
  normalizeContractPolicy,
  getPathValue,
  valueType,
};
