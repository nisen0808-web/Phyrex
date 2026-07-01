'use strict';

function formatPerformanceReportMarkdown(report, options = {}) {
  const title = options.title || 'Performance Report';
  const lines = [`# ${escapeMarkdown(title)}`, ''];
  if (report.trend && report.pressure) appendOperations(lines, report);
  else if (report.trend && report.averageTotalLoad !== undefined) appendTrend(lines, report);
  else if (report.scenarios) appendPressure(lines, report);
  else lines.push('_Unknown performance report format._');
  return `${lines.join('\n').trim()}\n`;
}

function appendOperations(lines, report) {
  lines.push(`- Tick: ${formatValue(report.tick)}`);
  lines.push(`- Trend: ${formatValue(report.trend.trend.direction)}`);
  lines.push(`- Scenarios: ${formatValue(report.pressure.scenarioCount)}`);
  lines.push('');
  appendTrend(lines, report.trend, 2);
  lines.push('');
  appendPressure(lines, report.pressure, 2);
  lines.push('');
  lines.push('## Recommendations');
  lines.push('');
  for (const item of report.recommendations || []) lines.push(`- **${escapeMarkdown(item.priority || 'info')}** ${escapeMarkdown(item.message || item.type || '')}`);
  if (!(report.recommendations || []).length) lines.push('- No recommendations.');
}

function appendTrend(lines, report, headingLevel = 1) {
  const h = '#'.repeat(headingLevel);
  lines.push(`${h} Trend`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Samples | ${formatValue(report.sampleCount)} |`);
  lines.push(`| Average total load | ${formatValue(report.averageTotalLoad)} |`);
  lines.push(`| Max total load | ${formatValue(report.maxTotalLoad)} |`);
  lines.push(`| Average max system load | ${formatValue(report.averageMaxSystemLoad)} |`);
  lines.push(`| Max system load | ${formatValue(report.maxSystemLoad)} |`);
  lines.push(`| Warnings | ${formatValue(report.warningCount)} |`);
  lines.push(`| Violations | ${formatValue(report.violationCount)} |`);
  lines.push(`| Direction | ${escapeMarkdown(report.trend?.direction || 'unknown')} |`);
  lines.push('');
  appendTopSystems(lines, report.topSystems || [], `${h} Top Systems`);
}

function appendPressure(lines, report, headingLevel = 1) {
  const h = '#'.repeat(headingLevel);
  lines.push(`${h} Pressure Scenarios`);
  lines.push('');
  lines.push('| Scenario | Total load | Max system load | Warnings | Violations | Risk |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const scenario of report.scenarios || []) {
    lines.push(`| ${escapeMarkdown(scenario.name)} | ${formatValue(scenario.totalLoad)} | ${formatValue(scenario.maxSystemLoad)} | ${formatValue(scenario.warnings)} | ${formatValue(scenario.violations)} | ${formatValue(scenario.riskScore)} |`);
  }
  if (!(report.scenarios || []).length) lines.push('| none | 0 | 0 | 0 | 0 | 0 |');
  lines.push('');
  if (report.highestRisk) {
    lines.push(`Highest risk: **${escapeMarkdown(report.highestRisk.name)}** with score **${formatValue(report.highestRisk.riskScore)}**.`);
    lines.push('');
  }
}

function appendTopSystems(lines, systems, title) {
  lines.push(title);
  lines.push('');
  lines.push('| System | Average load | Max load | Appearances | Budget |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const system of systems) {
    lines.push(`| ${escapeMarkdown(system.systemId)} | ${formatValue(system.averageLoad ?? system.load)} | ${formatValue(system.maxLoad ?? system.load)} | ${formatValue(system.appearances ?? 1)} | ${formatValue(system.budget)} |`);
  }
  if (!systems.length) lines.push('| none | 0 | 0 | 0 | 0 |');
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  return escapeMarkdown(value);
}

module.exports = {
  formatPerformanceReportMarkdown,
};
