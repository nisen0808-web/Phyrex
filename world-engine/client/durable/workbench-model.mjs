const clone = value => JSON.parse(JSON.stringify(value));
const bytes = text => new TextEncoder().encode(text).byteLength;
export function createWorkbench(validator, initial) {
  let document = clone(initial), selected = initial.templates?.[0]?.id ?? initial.id;
  let history = [], dirty = false, revision = 0;
  const validate = () => validator.validateEngineTemplate(document, { templateId: selected });
  if (!validate().valid) throw new Error('Invalid initial template');
  function remember() {
    history.push({ document: clone(document), selected });
    while (history.length > 20 || (history.length > 1 && bytes(JSON.stringify(history)) > 5 * 1024 * 1024)) history.shift();
  }
  function inspectText(text, templateId) {
    if (bytes(text) > validator.MAX_TEMPLATE_BYTES) return { valid: false, issues: [{ path: '$', message: '配置文件不能超过 1 MiB。' }] };
    let value;
    try { value = JSON.parse(text); } catch { return { valid: false, issues: [{ path: '$', message: 'JSON 格式有误，请检查括号、逗号和引号。' }] }; }
    const choices = Array.isArray(value?.templates) ? value.templates : [];
    const selection = templateId ?? (choices.length === 1 ? choices[0]?.id : choices.length === 0 ? value?.id : undefined);
    // Inspect the entire pack before presenting names or permitting replacement.
    const result = validator.validateEngineTemplate(value, { templateId: selection ?? choices[0]?.id });
    if (!result.valid) return result;
    if (choices.length > 1 && selection === undefined) return { valid: false, needsSelection: true, choices: choices.map(t => ({ id: t.id, name: t.name })), issues: [] };
    return { ...result, value, selection };
  }
  return {
    snapshot() { return { document: clone(document), selected, dirty, revision, canUndo: history.length > 0, validation: validate() }; },
    inspectText,
    load(text, templateId) {
      const result = inspectText(text, templateId);
      if (!result.valid) return result;
      remember(); document = result.value; selected = result.selection; dirty = true; revision++; return validate();
    },
    select(id) {
      if (!document.templates?.some(t => t.id === id)) throw new Error('Unknown template');
      selected = id; revision++;
    },
    edit(change) {
      const candidate = clone(document), template = candidate.templates?.find(t => t.id === selected) ?? candidate;
      change(template); remember(); document = candidate; dirty = true; revision++; return validate();
    },
    undo() { if (!history.length) return; const previous = history.pop(); document = previous.document; selected = previous.selected; dirty = true; revision++; },
    serialize(requireValid = true) {
      if (requireValid && !validate().valid) throw new Error('Fix validation errors before exporting');
      const pretty = JSON.stringify(document, null, 2) + '\n';
      return bytes(pretty) <= validator.MAX_TEMPLATE_BYTES ? pretty : JSON.stringify(document);
    },
    markSaved() { dirty = false; },
  };
}
export function nextId(rows, prefix) {
  const ids = new Set(rows.map(row => row.id ?? row.key)); let suffix = 1;
  while (ids.has(`${prefix}-${suffix}`)) suffix++;
  return `${prefix}-${suffix}`;
}
export function locationReferences(template, id) {
  const d = template.definition;
  return (d.entities ?? []).filter(e => e.locationId === id).length
    + (d.organizations ?? []).filter(o => o.homeLocationId === id).length
    + (d.connections ?? []).filter(edge => edge.includes(id)).length
    + (template.starterShops ?? []).filter(value => value === id).length
    + ((template.observerLocationId ?? d.locations[0]?.id) === id ? 1 : 0);
}
export function entityReferences(template, id) {
  return (template.definition.organizations ?? []).filter(o => o.leaderId === id || o.members?.includes(id) || Object.hasOwn(o.roles ?? {}, id)).length;
}
