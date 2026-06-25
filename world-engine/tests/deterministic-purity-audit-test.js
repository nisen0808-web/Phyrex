'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function main() {
  const coreDirectory = path.join(__dirname, '..', 'core');
  const allowlist = new Map([
    ['random-engine.js', [
      /const originalRandom = Math\.random/,
      /const originalNow = Date\.now/,
      /Math\.random =/,
      /Date\.now =/,
    ]],
  ]);
  const findings = [];

  for (const name of fs.readdirSync(coreDirectory).filter(file => file.endsWith('.js')).sort()) {
    const filePath = path.join(coreDirectory, name);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const allowedPatterns = allowlist.get(name) || [];
    lines.forEach((line, index) => {
      for (const pattern of [/Math\.random\s*\(/, /Date\.now\s*\(/]) {
        if (!pattern.test(line)) continue;
        if (allowedPatterns.some(allowed => allowed.test(line))) continue;
        findings.push({
          file: name,
          line: index + 1,
          expression: pattern.source.includes('Math') ? 'Math.random' : 'Date.now',
          source: line.trim(),
        });
      }
    });
  }

  const reportPath = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'deterministic-purity-findings.json',
  );
  fs.writeFileSync(reportPath, JSON.stringify({ findings }, null, 2), 'utf8');

  if (findings.length) {
    console.error('Implicit deterministic globals remain in core modules:');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} ${finding.expression} :: ${finding.source}`);
    }
  }

  assert.deepStrictEqual(findings, [], 'core modules must use explicit deterministic random/time APIs');
  console.log('deterministic purity audit test passed');
}

main();
