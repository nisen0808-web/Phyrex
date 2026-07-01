'use strict';

const path = require('path');
const { summarizeFindings, SOURCE_PURITY_VERSION } = require('./source-purity-engine');

function createRelativePurityBaseline(report, options = {}) {
  const root = options.root || report.root || process.cwd();
  const findings = normalizeReportFindings(report, root);
  return {
    version: SOURCE_PURITY_VERSION,
    root: options.rootLabel || 'world-engine/core',
    summary: summarizeFindings(findings),
    allowed: findings.map(finding => ({
      file: finding.file,
      line: finding.line,
      ruleId: finding.ruleId,
      match: finding.match,
    })),
  };
}

function compareReportToRelativeBaseline(report, baseline = {}, options = {}) {
  const root = options.root || report.root || process.cwd();
  const findings = normalizeReportFindings(report, root);
  const allowed = new Set((baseline.allowed || []).map(baselineKey));
  const current = new Set(findings.map(findingKey));
  const newFindings = findings.filter(finding => !allowed.has(findingKey(finding)));
  const resolved = (baseline.allowed || []).filter(item => !current.has(baselineKey(item)));
  return {
    ok: newFindings.length === 0,
    newFindings,
    resolved,
    report: { ...report, findings, summary: summarizeFindings(findings) },
    baseline,
  };
}

function normalizeReportFindings(report, root) {
  const rootPath = path.resolve(root || report.root || process.cwd());
  return (report.findings || []).map(finding => ({
    ...finding,
    file: toRelativePath(finding.file, rootPath),
  })).sort(compareFindings);
}

function formatBaselineDrift(comparison, limit = 40) {
  const lines = [];
  if (comparison.newFindings?.length) {
    lines.push(`New source purity findings: ${comparison.newFindings.length}`);
    for (const finding of comparison.newFindings.slice(0, limit)) {
      lines.push(`${finding.severity || 'warning'} ${finding.ruleId} ${finding.file}:${finding.line}:${finding.column} ${finding.match}`);
    }
  }
  if (comparison.resolved?.length) {
    lines.push(`Resolved source purity baseline entries: ${comparison.resolved.length}`);
    for (const item of comparison.resolved.slice(0, limit)) {
      lines.push(`resolved ${item.ruleId} ${item.file}:${item.line} ${item.match}`);
    }
  }
  return lines.join('\n');
}

function toRelativePath(file, root) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const normalizedRoot = String(root || '').replace(/\\/g, '/');
  if (normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1);
  return normalized.replace(/^.*world-engine\/core\//, '');
}

function findingKey(finding) {
  return [finding.file, finding.line, finding.ruleId, finding.match].join('|');
}

function baselineKey(item) {
  return [item.file, item.line, item.ruleId, item.match].join('|');
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file)
    || Number(left.line || 0) - Number(right.line || 0)
    || Number(left.column || 0) - Number(right.column || 0)
    || String(left.ruleId).localeCompare(String(right.ruleId));
}

module.exports = {
  createRelativePurityBaseline,
  compareReportToRelativeBaseline,
  normalizeReportFindings,
  formatBaselineDrift,
};
