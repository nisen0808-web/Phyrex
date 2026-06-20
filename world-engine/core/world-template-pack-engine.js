'use strict';

const fs = require('fs');
const path = require('path');
const {
  registerWorldTemplate,
  getWorldTemplate,
} = require('./world-template-engine');

const WORLD_TEMPLATE_PACK_SCHEMA_VERSION = 1;

function normalizeWorldTemplatePack(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('World template pack must be an object');
  const templates = Array.isArray(input.templates)
    ? input.templates
    : input.id && input.definition
      ? [input]
      : [];
  if (!templates.length) throw new Error('World template pack requires templates');

  const ids = new Set();
  const normalized = templates.map(template => {
    if (!template?.id) throw new Error('Packed world template requires id');
    if (!template?.name) throw new Error(`Packed world template ${template.id} requires name`);
    if (!template?.definition) throw new Error(`Packed world template ${template.id} requires definition`);
    if (ids.has(template.id)) throw new Error(`Duplicate template id in pack: ${template.id}`);
    ids.add(template.id);
    return deepClone(template);
  });

  return {
    schemaVersion: Number(input.schemaVersion || WORLD_TEMPLATE_PACK_SCHEMA_VERSION),
    id: input.packId || input.id && !input.definition ? input.id : options.packId || 'world-template-pack',
    name: input.packName || input.name && Array.isArray(input.templates) ? input.name : options.name || 'World Template Pack',
    description: input.description || '',
    author: input.author || null,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    templates: normalized,
    sourceFile: options.sourceFile || input.sourceFile || null,
  };
}

function loadWorldTemplatePack(filePath) {
  const absolute = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return normalizeWorldTemplatePack(raw, {
    sourceFile: absolute,
    packId: path.basename(absolute, path.extname(absolute)),
  });
}

function registerWorldTemplatePack(registry, packOrPath, options = {}) {
  const pack = typeof packOrPath === 'string'
    ? loadWorldTemplatePack(packOrPath)
    : normalizeWorldTemplatePack(packOrPath);
  const registered = [];
  for (const template of pack.templates) {
    registered.push(registerWorldTemplate(registry, template, {
      replace: options.replace === true,
    }));
  }
  return { pack, registered };
}

function loadWorldTemplateDirectory(registry, directory, options = {}) {
  const absolute = path.resolve(directory);
  if (!fs.existsSync(absolute)) return { directory: absolute, packs: [], registered: [], errors: [] };
  const files = fs.readdirSync(absolute)
    .filter(name => name.toLowerCase().endsWith('.json'))
    .sort();
  const packs = [];
  const registered = [];
  const errors = [];

  for (const name of files) {
    const file = path.join(absolute, name);
    try {
      const result = registerWorldTemplatePack(registry, file, options);
      packs.push(result.pack);
      registered.push(...result.registered);
    } catch (error) {
      const entry = { file, message: error.message || String(error) };
      errors.push(entry);
      if (options.strict !== false) throw error;
    }
  }

  return { directory: absolute, packs, registered, errors };
}

function exportWorldTemplatePack(registry, templateIds = null, metadata = {}) {
  const ids = templateIds?.length ? templateIds : [...(registry.order || [])];
  const templates = ids.map(id => {
    const template = getWorldTemplate(registry, id);
    if (!template) throw new Error(`Missing world template ${id}`);
    return deepClone(template);
  });
  return normalizeWorldTemplatePack({
    schemaVersion: WORLD_TEMPLATE_PACK_SCHEMA_VERSION,
    packId: metadata.id || 'exported-world-templates',
    packName: metadata.name || 'Exported World Templates',
    description: metadata.description || '',
    author: metadata.author || null,
    tags: metadata.tags || [],
    templates,
  });
}

function saveWorldTemplatePack(filePath, pack, options = {}) {
  const absolute = path.resolve(filePath);
  const normalized = normalizeWorldTemplatePack(pack);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const text = options.pretty === false
    ? JSON.stringify(stripRuntimeFields(normalized))
    : JSON.stringify(stripRuntimeFields(normalized), null, 2);
  fs.writeFileSync(absolute, text, 'utf8');
  return {
    file: absolute,
    templates: normalized.templates.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    schemaVersion: normalized.schemaVersion,
  };
}

function stripRuntimeFields(pack) {
  const copy = deepClone(pack);
  delete copy.sourceFile;
  return copy;
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  WORLD_TEMPLATE_PACK_SCHEMA_VERSION,
  normalizeWorldTemplatePack,
  loadWorldTemplatePack,
  registerWorldTemplatePack,
  loadWorldTemplateDirectory,
  exportWorldTemplatePack,
  saveWorldTemplatePack,
};
