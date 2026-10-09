import { createWorkbench, nextId, locationReferences, entityReferences } from './workbench-model.mjs';
const $ = id => document.getElementById(id);
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); return node; };
let model, catalog, locationId, personId, pendingImport = null, importEpoch = 0, rawDirty = false, fieldDirty = false;
const speciesNames = { human: '人类', spirit_beast: '灵兽', demon: '妖魔', dragon: '龙' };
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function current(snapshot = model.snapshot()) { return snapshot.document.templates?.find(t => t.id === snapshot.selected) ?? snapshot.document; }
function selectOptions(target, rows, value) {
  target.replaceChildren(...rows.map(([id, name]) => { const option = el('option', name); option.value = id; return option; })); target.value = value ?? '';
}
function changed(change) { model.edit(change); fieldDirty = false; render(); }
function editedField(change) { model.edit(change); fieldDirty = false; renderDerived(); }
function field(parent, label, value, update, { type = 'text', min, max, options, wide } = {}) {
  const wrapper = el('label', label), input = el(options ? 'select' : 'input');
  if (options) selectOptions(input, options, value);
  else { input.type = type; if (type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? ''; if (min !== undefined) input.min = min; if (max !== undefined) input.max = max; if (type === 'text') input.maxLength = 256; }
  input.addEventListener('input', () => editedField(t => update(t, type === 'checkbox' ? input.checked : type === 'number' ? input.value === '' ? null : Number(input.value) : input.value)));
  wrapper.append(input); if (wide) wrapper.className = 'field-wide'; parent.append(wrapper);
}
function resourceFields(parent, object, update) {
  const keys = [...new Set(['food', 'water', 'wood', 'stone', 'currency', ...Object.keys(object ?? {})])];
  const names = { food: '食物', water: '水', wood: '木材', stone: '石料', currency: '货币', metal: '金属', herbs: '草药', knowledge: '知识' };
  for (const key of keys) field(parent, names[key] ?? key, object?.[key] ?? 0, (t, value) => update(t, key, value), { type: 'number', min: 0, max: 1000000 });
}
function renderPreview(t, d, location) {
  $('preview-name').textContent = t.name; $('counts').replaceChildren();
  for (const [name, count] of [['地点',d.locations.length],['道路',(d.connections ?? []).length],['人物',(d.entities ?? []).length],['组织',(d.organizations ?? []).length]]) {
    const row = el('div'); row.append(el('b',count),el('span',name)); $('counts').append(row);
  }
  const labels = new Map(d.locations.map(l => [l.id,l.name || l.id]));
  $('map').replaceChildren();
  const center = el('div', labels.get(location.id)); center.className = 'current'; $('map').append(center);
  const neighbors = (d.connections ?? []).filter(edge => edge.includes(location.id)).map(edge => edge.find(id => id !== location.id));
  $('map').append(el('p', neighbors.length ? '↕ 可以直接前往以下地点' : '暂无道路连接，可以在“连接道路”中添加'));
  for (const id of neighbors) { const button = el('button',labels.get(id) ?? id); button.type = 'button'; button.addEventListener('click', () => { locationId = id; render(); }); $('map').append(button); }
  $('preview-context').textContent = `${t.observerLocationId === location.id ? '观察者起点 · ' : ''}${t.starterShops?.includes(location.id) ? '有初始商店 · ' : ''}危险程度 ${location.danger ?? 0} / 100${t.seedTicks ? ` · 配置另有 ${t.seedTicks} 轮预推进` : ''}`;
  for (const [target, rows] of [['preview-people',(d.entities ?? []).filter(e => e.locationId === location.id).map(e => `${e.name || e.id} · ${speciesNames[e.species ?? 'human'] ?? e.species}`)],['preview-organizations',(d.organizations ?? []).filter(o => o.homeLocationId === location.id).map(o => o.name || o.id || o.key)]]) {
    $(target).replaceChildren(...(rows.length ? rows : ['暂无']).map(name => el('li',name)));
  }
}
function render() {
  fieldDirty = false;
  const snapshot = model.snapshot(), t = current(snapshot), d = t.definition;
  const locations = d.locations.map(l => [l.id,l.name || l.id]);
  locationId = d.locations.some(l => l.id === locationId) ? locationId : d.locations[0].id;
  personId = (d.entities ?? []).some(e => e.id === personId) ? personId : d.entities?.[0]?.id;
  const location = d.locations.find(l => l.id === locationId), person = (d.entities ?? []).find(e => e.id === personId);
  $('world-name').value = t.name; $('world-id').value = d.world?.id ?? t.id; $('world-seed').value = d.world?.seed ?? 1;
  selectOptions($('observer-location'),locations,t.observerLocationId ?? d.locations[0].id);
  $('template-select-label').hidden = !snapshot.document.templates || snapshot.document.templates.length === 1;
  selectOptions($('template-select'),(snapshot.document.templates ?? [t]).map(row => [row.id,row.name]),snapshot.selected);
  selectOptions($('location-select'),locations,locationId); selectOptions($('road-from'),locations,locationId);
  selectOptions($('road-to'),locations,locations.find(([id]) => id !== locationId)?.[0] ?? locationId);
  $('add-location').disabled = d.locations.length >= 128; $('add-person').disabled = (d.entities ?? []).length >= 1000;
  $('add-road').disabled = d.locations.length < 2 || (d.connections ?? []).length >= 2048;
  $('location-fields').replaceChildren();
  const editLocation = (template) => template.definition.locations.find(l => l.id === locationId);
  field($('location-fields'),'地点名称',location.name ?? location.id,(t,v) => editLocation(t).name = v);
  field($('location-fields'),'危险程度',location.danger ?? 0,(t,v) => editLocation(t).danger = v,{type:'number',min:0,max:100});
  resourceFields($('location-fields'),location.resources,(t,k,v) => { (editLocation(t).resources ??= {})[k] = v; });
  field($('location-fields'),'设置初始商店',t.starterShops?.includes(locationId),(t,checked) => { t.starterShops = (t.starterShops ?? []).filter(id => id !== locationId); if (checked) t.starterShops.push(locationId); },{type:'checkbox'});
  const refs = locationReferences(t, locationId); $('remove-location').disabled = d.locations.length <= 1 || refs > 0;
  $('location-note').textContent = `地点编号：${locationId}。${refs ? '删除前请先移走人物、组织、起点和商店，并移除相连道路。' : '没有其他内容引用，可以删除。'}`;
  $('road-list').replaceChildren(...(d.connections ?? []).map((edge,index) => {
    const row = el('li'), button = el('button','移除'); row.append(el('span',`${locations.find(([id]) => id === edge[0])?.[1]} ↔ ${locations.find(([id]) => id === edge[1])?.[1]}`),button);
    button.addEventListener('click', () => changed(t => t.definition.connections.splice(index,1))); return row;
  }));
  selectOptions($('person-select'),(d.entities ?? []).map(e => [e.id,e.name || e.id]),personId);
  $('person-select').disabled = !person; $('person-fields').replaceChildren(); $('remove-person').disabled = !person || entityReferences(t,personId) > 0;
  $('person-note').textContent = person ? `人物编号：${personId}。组织首领或成员需要先在“完整配置与组织设置”中解除关联，才能删除。` : '还没有人物。点击“添加人物”放入第一位居民。';
  if (person) {
    const editPerson = t => t.definition.entities.find(e => e.id === personId);
    field($('person-fields'),'人物姓名',person.name ?? person.id,(t,v) => editPerson(t).name = v);
    field($('person-fields'),'种族',person.species ?? 'human',(t,v) => editPerson(t).species = v,{options:catalog.species.map(s => [s.id,speciesNames[s.id] ?? s.name])});
    field($('person-fields'),'初始地点',person.locationId,(t,v) => editPerson(t).locationId = v,{options:locations});
    resourceFields($('person-fields'),person.resources,(t,k,v) => { (editPerson(t).resources ??= {})[k] = v; });
  }
  $('rule-fields').replaceChildren();
  for (const [key,label,min] of [['workYield','工作收益',1],['workEnergy','工作体力消耗',1],['gatherYield','采集收益',1],['gatherEnergy','采集体力消耗',1],['moveEnergy','移动体力消耗',1],['restEnergy','休息恢复体力',0],['restHealth','休息恢复生命',0],['trainingExperience','训练经验',1]]) {
    field($('rule-fields'),label,t.playerRules?.[key] ?? globalThis.PhyrexTemplateValidation.DEFAULT_PLAYER_ACTION_RULES[key],(t,v) => { (t.playerRules ??= {})[key] = v; },{type:'number',min,max:100});
  }
  renderDerived();
}
function renderDerived() {
  const snapshot = model.snapshot(), t = current(snapshot), d = t.definition;
  const location = d.locations.find(l => l.id === locationId) ?? d.locations[0];
  renderPreview(t,d,location);
  const locationNames = new Map(d.locations.map(l => [l.id,l.name || l.id]));
  for (const id of ['location-select','observer-location','road-from','road-to']) for (const option of $(id).options) option.textContent = locationNames.get(option.value) ?? option.value;
  const personNames = new Map((d.entities ?? []).map(e => [e.id,e.name || e.id]));
  for (const option of $('person-select').options) option.textContent = personNames.get(option.value) ?? option.value;
  $('remove-location').disabled = d.locations.length <= 1 || locationReferences(t,locationId) > 0;
  $('remove-person').disabled = !personNames.has(personId) || entityReferences(t,personId) > 0;
  const { valid, issues } = snapshot.validation;
  $('validation-badge').textContent = valid ? '检查通过' : '需要修改';
  $('validation-summary').textContent = valid ? '整个配置包通过检查，可以下载用于创建新世界。' : `有 ${issues.length} 项需要修正；不会生成部分世界。`;
  $('validation-errors').replaceChildren(...issues.map(issue => { const row = el('li',issue.message); row.append(el('code',issue.path)); return row; }));
  $('download').disabled = !valid || rawDirty; $('undo').disabled = !snapshot.canUndo;
  $('save-state').textContent = snapshot.dirty || rawDirty ? '有未下载的修改' : '配置未改动 / 已发起下载';
  $('selected-template-hint').textContent = `请将命令中的 TEMPLATE_ID 替换为：${snapshot.selected}。Windows 可使用 npm.cmd。`;
  if (!rawDirty) $('advanced-json').value = model.serialize(false);
}
function replacementAllowed() { return !(model.snapshot().dirty || rawDirty || fieldDirty) || window.confirm('打开其他配置会替换当前内容。尚未应用的 JSON 文本无法通过撤销找回，请先保存需要保留的草稿。继续打开吗？'); }
function applyImport(text, templateId) {
  const result = model.inspectText(text,templateId);
  if (result.needsSelection) {
    pendingImport = text; $('import-choice').hidden = false;
    selectOptions($('import-selection'),[['','请选择模板'],...result.choices.map(t => [t.id,t.name])],''); notice('已检查整个模板包。请选择一个模板后确认打开。'); return;
  }
  if (!result.valid) { notice('没有替换当前配置。' + result.issues.slice(0,3).map(i => `${i.path}：${i.message}`).join(' '),true); return; }
  if (!replacementAllowed()) return;
  model.load(text,templateId); rawDirty = false; fieldDirty = false; locationId = personId = undefined; pendingImport = null; $('import-choice').hidden = true; render(); notice('配置已打开，可以继续编辑。请下载保存修改。');
}
function download(draft = false) {
  let text;
  try { if (!draft && rawDirty) throw Error(); text = draft && rawDirty ? $('advanced-json').value : model.serialize(!draft); }
  catch { notice('请先应用完整配置并修正检查结果，再下载可用配置。',true); return; }
  const blob = new Blob([text],{type:'application/json;charset=utf-8'}), url = URL.createObjectURL(blob), link = el('a');
  link.href = url; link.download = draft ? 'world-template-draft.json' : 'world-template.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  if (!draft) model.markSaved(); render(); notice(draft ? '已发起草稿下载。草稿可能包含错误，请继续修正。' : '已发起配置下载。接下来按右侧说明创建独立的新世界。');
}
async function main() {
  const response = await fetch('/console/template-catalog.json', { cache: 'no-store' }); if (!response.ok) throw Error(); catalog = await response.json();
  const validator = globalThis.PhyrexTemplateValidation.createTemplateValidator(catalog.species.map(s => s.id));
  model = createWorkbench(validator,catalog.sample);
  $('editor').addEventListener('input', event => { if (event.target !== $('import-file')) importEpoch++; fieldDirty = true; if (event.target === $('advanced-json')) { rawDirty = true; $('download').disabled = true; notice('完整配置尚未应用。请点击“应用完整配置”，或用当前表单重新填入。'); } $('save-state').textContent = '有未下载的修改'; });
  for (const [id,update] of [['world-name',(t,v) => t.name = v],['world-id',(t,v) => { (t.definition.world ??= {}).id = v; }],['world-seed',(t,v) => { (t.definition.world ??= {}).seed = v; }],['observer-location',(t,v) => t.observerLocationId = v]]) $(id).addEventListener('input', () => editedField(t => update(t,$(id).value)));
  $('template-select').addEventListener('change', () => { model.select($('template-select').value); locationId = personId = undefined; render(); });
  $('location-select').addEventListener('change', () => { locationId = $('location-select').value; render(); });
  $('person-select').addEventListener('change', () => { personId = $('person-select').value; render(); });
  $('add-location').addEventListener('click', () => changed(t => { locationId = nextId(t.definition.locations,'place'); t.definition.locations.push({id:locationId,name:'新的地点',danger:0,resources:{food:1000,water:1000}}); }));
  $('remove-location').addEventListener('click', () => changed(t => { if (t.definition.locations.length > 1 && !locationReferences(t,locationId)) t.definition.locations = t.definition.locations.filter(l => l.id !== locationId); }));
  $('add-road').addEventListener('click', () => {
    const from = $('road-from').value, to = $('road-to').value;
    if (from === to || (current().definition.connections ?? []).some(edge => edge.includes(from) && edge.includes(to))) return notice('请选择两个不同地点，并避免重复连接。',true);
    changed(t => (t.definition.connections ??= []).push([from,to])); notice('道路已连接，预览已更新。');
  });
  $('add-person').addEventListener('click', () => changed(t => { const rows = t.definition.entities ??= []; personId = nextId(rows,'resident'); rows.push({id:personId,name:'新的居民',species:'human',locationId,resources:{currency:100,food:100}}); }));
  $('remove-person').addEventListener('click', () => changed(t => { if (!entityReferences(t,personId)) t.definition.entities = t.definition.entities.filter(e => e.id !== personId); }));
  $('undo').addEventListener('click', () => { if (rawDirty && !window.confirm('撤销会丢弃尚未应用的 JSON 文本。继续吗？')) return; model.undo(); rawDirty = fieldDirty = false; render(); notice('已撤销上一项修改。'); });
  $('sample').addEventListener('click', () => applyImport(JSON.stringify(catalog.sample)));
  $('blank').addEventListener('click', () => applyImport(JSON.stringify({id:'my-world',name:'我的世界',definition:{world:{id:'my-world',seed:'my-world-v1'},locations:[{id:'home',name:'起点',resources:{food:1000,water:1000}}]}})));
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; $('import-file').value = ''; if (!file) return;
    const epoch = ++importEpoch, revision = model.snapshot().revision;
    if (file.size > validator.MAX_TEMPLATE_BYTES) return notice('文件超过 1 MiB，未替换当前配置。',true);
    try { const buffer = await file.arrayBuffer(); if (buffer.byteLength > validator.MAX_TEMPLATE_BYTES) throw Error(); const text = new TextDecoder('utf-8',{fatal:true}).decode(buffer);
      if (epoch !== importEpoch || revision !== model.snapshot().revision) return notice('读取文件期间配置已变化，请重新打开文件。',true); applyImport(text);
    } catch { notice('无法读取 UTF-8 JSON 文件，当前配置保持原样。',true); }
  });
  $('confirm-import').addEventListener('click', () => { if (!$('import-selection').value) return notice('请先选择要编辑的模板。',true); if (pendingImport) applyImport(pendingImport,$('import-selection').value); });
  $('cancel-import').addEventListener('click', () => { pendingImport = null; $('import-choice').hidden = true; });
  $('apply-json').addEventListener('click', () => {
    let selection;
    try { const parsed = JSON.parse($('advanced-json').value), id = model.snapshot().selected; if (parsed?.id === id || parsed?.templates?.some(t => t?.id === id)) selection = id; } catch { /* inspectText supplies safe diagnostics */ }
    applyImport($('advanced-json').value,selection);
  });
  $('refresh-json').addEventListener('click', () => { if (rawDirty && !window.confirm('用表单内容替换尚未应用的 JSON 文本吗？')) return; rawDirty = fieldDirty = false; render(); });
  $('advanced-json').addEventListener('change', () => { rawDirty = true; $('download').disabled = true; });
  $('download').addEventListener('click', () => download()); $('download-draft').addEventListener('click', () => download(true));
  window.addEventListener('beforeunload', event => { if (model.snapshot().dirty || rawDirty || fieldDirty) { event.preventDefault(); event.returnValue = ''; } });
  $('editor').hidden = false; render(); notice('已载入河谷样例。先修改世界名称，再选择一个地点试试。');
}
main().catch(() => notice('工坊未能加载，请刷新页面后重试。已下载的配置不受影响。',true));
