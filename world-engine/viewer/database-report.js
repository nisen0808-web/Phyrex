/* global document, fetch */
'use strict';

const reportEls = {
  url: document.getElementById('database-report-url'),
  load: document.getElementById('load-database-report-button'),
  status: document.getElementById('database-report-status'),
  summary: document.getElementById('databaseReport'),
  files: document.getElementById('databaseReportFiles'),
  warnings: document.getElementById('databaseReportWarnings'),
  errors: document.getElementById('databaseReportErrors'),
  raw: document.getElementById('databaseReportRaw'),
};

async function loadDatabaseReport(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load database report: ${response.status} ${response.statusText}`);
  return response.json();
}

function renderDatabaseReport(payload) {
  const report = payload?.data || payload;
  if (!report || typeof report !== 'object') {
    reportEls.summary.innerHTML = '<p class="muted">No database report loaded.</p>';
    reportEls.files.innerHTML = '<p class="muted">No file data.</p>';
    reportEls.warnings.innerHTML = '<p class="muted">No warnings.</p>';
    reportEls.errors.innerHTML = '<p class="muted">No errors.</p>';
    reportEls.raw.textContent = '';
    return;
  }
  const rows = [
    ['OK', report.ok ? 'yes' : 'no'],
    ['Provider', report.config?.provider || 'unknown'],
    ['Ready', report.config?.ready ? 'yes' : 'no'],
    ['World records', report.counts?.worlds ?? 0],
    ['Event records', report.counts?.events ?? 0],
    ['Schema files', report.counts?.schema ?? 0],
    ['Errors', report.counts?.errors ?? 0],
    ['Warnings', report.counts?.warnings ?? 0],
  ];
  reportEls.summary.innerHTML = renderReportTable(rows);
  reportEls.files.innerHTML = renderReportFiles(report.files || {});
  reportEls.warnings.innerHTML = renderReportList(report.warnings || [], item => `<strong>${escapeReportHtml(item)}</strong>`);
  reportEls.errors.innerHTML = renderReportList(report.errors || [], item => `<strong>${escapeReportHtml(item.file || 'file')}</strong><span>line ${formatReportValue(item.line || 0)} · ${escapeReportHtml(item.message || '')}</span>`);
  reportEls.raw.textContent = JSON.stringify(report, null, 2);
  reportEls.status.textContent = `Loaded provider=${report.config?.provider || 'unknown'} errors=${report.counts?.errors || 0}`;
}

function renderReportFiles(files) {
  const rows = ['worlds', 'events', 'schema'].map(key => {
    const file = files[key] || {};
    return [
      key,
      file.exists ? 'yes' : 'no',
      file.bytes ?? 0,
      file.lines ?? '',
      file.records ?? '',
      file.parseErrors?.length ?? 0,
    ];
  });
  const body = rows.map(row => `<tr>${row.map(value => `<td>${escapeReportHtml(formatReportValue(value))}</td>`).join('')}</tr>`).join('');
  return `<table class="data-table"><thead><tr><th>File</th><th>Exists</th><th>Bytes</th><th>Lines</th><th>Records</th><th>Parse Errors</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderReportTable(rows) {
  return `<table class="data-table"><tbody>${rows.map(([key, value]) => `<tr><th>${escapeReportHtml(key)}</th><td>${escapeReportHtml(formatReportValue(value))}</td></tr>`).join('')}</tbody></table>`;
}

function renderReportList(items, renderer) {
  if (!items.length) return '<p class="muted">No data.</p>';
  return `<div class="list">${items.map(item => `<div class="item">${renderer(item)}</div>`).join('')}</div>`;
}

function formatReportValue(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || value === '' || value === null || value === undefined) return String(value ?? '');
  return String(Math.round(num * 100) / 100);
}

function escapeReportHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function bootDatabaseReport(showError = true) {
  try {
    const report = await loadDatabaseReport(reportEls.url.value);
    renderDatabaseReport(report);
  } catch (error) {
    renderDatabaseReport(null);
    if (showError) reportEls.status.textContent = error.message;
  }
}

if (reportEls.load && reportEls.url) {
  reportEls.load.addEventListener('click', () => bootDatabaseReport(true));
  reportEls.url.addEventListener('keydown', event => { if (event.key === 'Enter') bootDatabaseReport(true); });
  bootDatabaseReport(false);
}
