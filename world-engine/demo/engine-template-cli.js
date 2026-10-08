'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_TEMPLATE_BYTES, validateEngineTemplate } = require('../core/engine-template-engine');

async function readTemplateFile(file) {
  const handle = await fs.open(path.resolve(file), 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TEMPLATE_BYTES) throw new Error('Invalid template file');
    // Bound the actual read, including if the file grows after stat().
    const buffer = Buffer.alloc(MAX_TEMPLATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer,length,buffer.length - length,null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TEMPLATE_BYTES) throw new Error('Template file too large');
    return JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(buffer.subarray(0,length)));
  } finally { await handle.close(); }
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: engine-template-cli.js --input TEMPLATE_JSON [--template-id ID] [--output NEW_REPORT]\n只检查世界配置，不推进世界、不连接数据库。报告指出字段位置与中文原因，不回显原始字段值。'); return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { '--input':'input', '--template-id':'templateId', '--output':'output' }[argv[i]], value = argv[++i];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options,key)) throw new Error('Invalid template arguments');
    options[key] = value;
  }
  if (!options.input) throw new Error('Template input required');
  const result = validateEngineTemplate(await readTemplateFile(options.input), { templateId: options.templateId });
  if (options.output) await fs.writeFile(path.resolve(options.output), JSON.stringify(result,null,2)+'\n',{ flag:'wx',mode:0o600 });
  return result;
}
if (require.main === module) main().then(result => {
  if (result) { console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; }
}).catch(() => {
  console.error(JSON.stringify({ valid:false,error:'ENGINE_TEMPLATE_CHECK_FAILED',message:'无法读取或检查配置。请确认参数、UTF-8 JSON 格式、1 MiB 大小上限，以及报告文件尚不存在。' })); process.exitCode = 1;
});
module.exports = { main, readTemplateFile };
