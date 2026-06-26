'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_PURITY_VERSION = 1;

const DEFAULT_SOURCE_PURITY_RULES = [
  {
    id: 'implicit_math_random',
    severity: 'error',
    pattern: /\bMath\s*\.\s*random\s*\(/g,
    message: 'Use context.random or createRandomContext instead of Math.random inside engine code.',
  },
  {
    id: 'implicit_date_now',
    severity: 'error',
    pattern: /\bDate\s*\.\s*now\s*\(/g,
    message: 'Use the deterministic world clock or random clock helpers instead of Date.now inside simulation code.',
  },
  {
    id: 'implicit_new_date',
    severity: 'warning',
    pattern: /\bnew\s+Date\s*\(/g,
    message: 'Use explicit timestamps from deterministic context or isolate wall-clock formatting outside simulation code.',
  },
  {
    id: 'implicit_performance_now',
    severity: 'warning',
    pattern: /\bperformance\s*\.\s*now\s*\(/g,
    message: 'Use injected timing diagnostics instead of performance.now inside deterministic engine code.',
  },
  {
    id: 'implicit_process_hrtime',
    severity: 'warning',
    pattern: /\bprocess\s*\.\s*hrtime\s*\(/g,
    message: 'Use injected timing diagnostics instead of process.hrtime inside deterministic engine code.',
  },
];

const DEFAULT_SOURCE_PURITY_OPTIONS = {
  extensions: ['.js'],
  ignoreDirectories: new Set(['node_modules', '.git', 'output', 'saves', 'coverage']),
  ignoreFiles: new Set([]),
  stripComments: true,
  allowInlineDirectives: true,
};

function scanSourceText(source, filePath = '<memory>', options = {}) {
  const config = normalizeSourcePurityOptions(options);
  const lines = String(source || '').split(/\r?\n/);
  const scanText = config.stripComments ? stripCommentsPreservingLines(String(source || '')) : String(source || '');
  const findings = [];

  for (const rule of config.rules) {
    const pattern = resetGlobalRegex(rule.pattern);
    let match;
    while ((match = pattern.exec(scanText)) !== null) {
      const location = offsetToLineColumn(scanText, match.index);
      const lineText = lines[location.line - 1] || '';
      if (isAllowedByDirective(lineText, rule, config)) continue;
      if (isAllowedByList(filePath, location.line, rule, config)) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity || 'error',
        file: normalizePath(filePath),
        line: location.line,
        column: location.column,
        match: match[0],
        message: rule.message || `Source purity rule ${rule.id} matched`,
        snippet: lineText.trim(),
      });
    }
  }

  return findings.sort(compareFindings);
}

function scanSourceFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  return scanSourceText(text, filePath, options);
}

function scanSourceDirectory(directory, options = {}) {
  const config = normalizeSourcePurityOptions(options);
  const root = path.resolve(directory);
  const files = listSourceFiles(root, config);
  const findings = [];
  for (const file of files) findings.push(...scanSourceFile(file, config));
  return {
    version: SOURCE_PURITY_VERSION,
    root,
    files: files.length,
    findings: findings.sort(compareFindings),
    summary: summarizeFindings(findings),
  };
}

function summarizeFindings(findings) {
  const summary = {
    total: 0,
    errors: 0,
    warnings: 0,
    byRule: {},
    byFile: {},
  };
  for (const finding of findings || []) {
    summary.total += 1;
    if (finding.severity === 'error') summary.errors += 1;
    else summary.warnings += 1;
    summary.byRule[finding.ruleId] = (summary.byRule[finding.ruleId] || 0) + 1;
    summary.byFile[finding.file] = (summary.byFile[finding.file] || 0) + 1;
  }
  return summary;
}

function assertSourcePurity(report, options = {}) {
  const maxErrors = Number(options.maxErrors ?? 0);
  const maxWarnings = Number(options.maxWarnings ?? Infinity);
  const errors = Number(report?.summary?.errors || 0);
  const warnings = Number(report?.summary?.warnings || 0);
  if (errors <= maxErrors && warnings <= maxWarnings) return report;
  const message = [
    `Source purity audit failed: ${errors} error(s), ${warnings} warning(s)`,
    ...formatFindings(report.findings || []).slice(0, options.maxDisplayed || 20),
  ].join('\n');
  const error = new Error(message);
  error.code = 'source_purity_failed';
  error.report = report;
  throw error;
}

function formatFindings(findings) {
  return (findings || []).map(finding => (
    `${finding.severity.toUpperCase()} ${finding.ruleId} ${finding.file}:${finding.line}:${finding.column} ${finding.message}`
  ));
}

function createPurityBaseline(report) {
  return {
    version: SOURCE_PURITY_VERSION,
    createdFrom: report?.root || null,
    summary: report?.summary || summarizeFindings(report?.findings || []),
    allowed: (report?.findings || []).map(finding => ({
      file: normalizePath(finding.file),
      line: finding.line,
      ruleId: finding.ruleId,
      match: finding.match,
    })),
  };
}

function compareToPurityBaseline(report, baseline = {}) {
  const allowed = new Set((baseline.allowed || []).map(baselineKey));
  const newFindings = (report.findings || []).filter(finding => !allowed.has(findingKey(finding)));
  const resolved = (baseline.allowed || []).filter(item => {
    const key = baselineKey(item);
    return !(report.findings || []).some(finding => findingKey(finding) === key);
  });
  return {
    ok: newFindings.length === 0,
    newFindings,
    resolved,
    report,
    baseline,
  };
}

function normalizeSourcePurityOptions(options = {}) {
  const base = { ...DEFAULT_SOURCE_PURITY_OPTIONS, ...(options || {}) };
  return {
    ...base,
    extensions: new Set(base.extensions || DEFAULT_SOURCE_PURITY_OPTIONS.extensions),
    ignoreDirectories: new Set(base.ignoreDirectories || DEFAULT_SOURCE_PURITY_OPTIONS.ignoreDirectories),
    ignoreFiles: new Set(base.ignoreFiles || []),
    allowlist: normalizeAllowlist(base.allowlist || []),
    rules: (base.rules || DEFAULT_SOURCE_PURITY_RULES).map(rule => ({
      ...rule,
      pattern: resetGlobalRegex(rule.pattern),
      severity: rule.severity || 'error',
    })),
  };
}

function listSourceFiles(root, config) {
  const output = [];
  walk(root);
  output.sort();
  return output;

  function walk(current) {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const name = path.basename(current);
      if (config.ignoreDirectories.has(name)) return;
      for (const child of fs.readdirSync(current).sort()) walk(path.join(current, child));
      return;
    }
    if (!stat.isFile()) return;
    const normalized = normalizePath(current);
    if (config.ignoreFiles.has(path.basename(current)) || config.ignoreFiles.has(normalized)) return;
    if (!config.extensions.has(path.extname(current))) return;
    output.push(current);
  }
}

function stripCommentsPreservingLines(text) {
  let output = '';
  let index = 0;
  let mode = 'code';
  let quote = null;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (mode === 'lineComment') {
      if (char === '\n') {
        output += '\n';
        mode = 'code';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 2;
        mode = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (mode === 'string') {
      output += char;
      if (char === '\\') {
        output += next || '';
        index += 2;
        continue;
      }
      if (char === quote) {
        mode = 'code';
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      mode = 'lineComment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      mode = 'blockComment';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      mode = 'string';
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function isAllowedByDirective(lineText, rule, config) {
  if (!config.allowInlineDirectives) return false;
  const marker = 'source-purity-allow';
  if (!String(lineText || '').includes(marker)) return false;
  return String(lineText).includes(rule.id) || String(lineText).includes(`${marker}: all`);
}

function isAllowedByList(filePath, line, rule, config) {
  const file = normalizePath(filePath);
  for (const item of config.allowlist || []) {
    if (item.ruleId && item.ruleId !== rule.id) continue;
    if (item.file && !file.endsWith(normalizePath(item.file))) continue;
    if (item.line !== undefined && Number(item.line) !== Number(line)) continue;
    return true;
  }
  return false;
}

function normalizeAllowlist(value) {
  return (Array.isArray(value) ? value : []).map(item => ({
    file: item.file ? normalizePath(item.file) : null,
    line: item.line === undefined ? undefined : Number(item.line),
    ruleId: item.ruleId || null,
  }));
}

function offsetToLineColumn(text, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function resetGlobalRegex(pattern) {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return new RegExp(pattern.source, flags);
  }
  return new RegExp(String(pattern), 'g');
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.ruleId.localeCompare(right.ruleId);
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function findingKey(finding) {
  return [normalizePath(finding.file), finding.line, finding.ruleId, finding.match].join('|');
}

function baselineKey(item) {
  return [normalizePath(item.file), item.line, item.ruleId, item.match].join('|');
}

module.exports = {
  SOURCE_PURITY_VERSION,
  DEFAULT_SOURCE_PURITY_RULES,
  DEFAULT_SOURCE_PURITY_OPTIONS,
  scanSourceText,
  scanSourceFile,
  scanSourceDirectory,
  summarizeFindings,
  assertSourcePurity,
  formatFindings,
  createPurityBaseline,
  compareToPurityBaseline,
  stripCommentsPreservingLines,
  normalizeSourcePurityOptions,
};
