'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  const coreDirectory = path.join(__dirname, '..', 'core');
  const findings = [];
  for (const name of fs.readdirSync(coreDirectory).filter(file => file.endsWith('.js')).sort()) {
    const file = path.join(coreDirectory, name);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of [
        { type: 'Math.random', regex: /Math\.random\s*\(/g },
        { type: 'Date.now', regex: /Date\.now\s*\(/g },
        { type: 'new Date', regex: /new\s+Date\s*\(/g },
      ]) {
        if (pattern.regex.test(line)) {
          findings.push({ file: name, line: index + 1, type: pattern.type, source: line.trim() });
        }
        pattern.regex.lastIndex = 0;
      }
    });
  }

  console.log('DETERMINISM_SOURCE_AUDIT ' + JSON.stringify(findings));
  console.log(`determinism source audit completed: ${findings.length} implicit time/random call(s)`);
}

main();
