'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { digest } = require('../storage/postgres/codec');
const tempRoot = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(tempRoot,'phyrex-template-'));
const cli = (file,args) => spawnSync(process.execPath,[path.join(__dirname,'../demo',file),...args],{encoding:'utf8',windowsHide:true,timeout:60000});
try {
  const template = path.join(__dirname,'../templates/river-valley.json'), output = path.join(directory,'world.json'), report = path.join(directory,'report.json');
  let result = cli('engine-template-cli.js',['--input',template,'--output',report]);
  assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).summary.population,4);
  assert.equal(JSON.parse(fs.readFileSync(report,'utf8')).valid,true);
  const reportBytes = fs.readFileSync(report);
  assert.equal(cli('engine-template-cli.js',['--input',template,'--output',report]).status,1);
  assert.deepEqual(fs.readFileSync(report),reportBytes);
  result = cli('engine-init-cli.js',['--output',output,'--template-file',template,'--world-id','custom-valley','--seed','custom-seed']);
  assert.equal(result.status,0,result.stderr); const envelope = JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(envelope.world.id,'custom-valley'); assert.equal(envelope.world.seed,'custom-seed');
  assert.equal(envelope.world.locations['pine-forest'].name,'松林');
  const before = fs.readFileSync(output);
  assert.equal(cli('engine-init-cli.js',['--output',output,'--template-file',template]).status,1);
  assert.deepEqual(fs.readFileSync(output),before);
  const second = path.join(directory,'second.json');
  assert.equal(cli('engine-init-cli.js',['--output',second,'--template-file',template,'--world-id','custom-valley','--seed','custom-seed']).status,0);
  assert.equal(digest(JSON.parse(fs.readFileSync(second,'utf8')).world),digest(envelope.world));
  const invalid = path.join(directory,'invalid.json'), rejected = path.join(directory,'rejected.json');
  const bad = JSON.parse(fs.readFileSync(template,'utf8')); bad.templates[0].definition.entities[0].locationId = 'secret-invalid-reference';
  fs.writeFileSync(invalid,JSON.stringify(bad));
  result = cli('engine-template-cli.js',['--input',invalid]);
  assert.equal(result.status,1); assert(JSON.parse(result.stdout).issues.some(i=>i.code==='reference'));
  assert(!result.stdout.includes('secret-invalid-reference'));
  result = cli('engine-init-cli.js',['--output',rejected,'--template-file',invalid]);
  assert.equal(result.status,1); assert(!fs.existsSync(rejected)); assert(!result.stderr.includes('secret-invalid-reference'));
  for (const flags of [['--population','4'],['--commerce','starter'],['--player-rules',template],['--template-id','missing']]) {
    assert.equal(cli('engine-init-cli.js',['--output',rejected,'--template-file',template,...flags]).status,1); assert(!fs.existsSync(rejected));
  }
  assert.equal(cli('engine-init-cli.js',['--output',rejected,'--template-id','river-valley']).status,1);
  for (const contents of [Buffer.from('{invalid-secret-json'),Buffer.alloc(1024*1024+1,32),Buffer.from([0xff,0xfe,0x7b])]) {
    fs.writeFileSync(invalid,contents); result = cli('engine-template-cli.js',['--input',invalid]);
    assert.equal(result.status,1); assert(!result.stderr.includes('invalid-secret-json')); assert(!fs.existsSync(rejected));
  }
  console.log('engine template CLI passed: validation, new saves, safe failures, deterministic content and no overwrite');
} finally {
  assert.equal(path.dirname(path.resolve(directory)),tempRoot); assert(path.basename(directory).startsWith('phyrex-template-'));
  fs.rmSync(directory,{recursive:true,force:true});
}
