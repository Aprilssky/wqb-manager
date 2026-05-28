/* WQB Manager — MCP SSE Edition v2 */
/* Connects to WQB via MCP protocol over SSE (streamable-http transport) */

// ── MCP URL Config ──
const DEFAULT_MCP_URL = 'http://203.83.228.3:8009/mcp';

function getMcpUrl() {
  return localStorage.getItem('wqb_mcp_url') || DEFAULT_MCP_URL;
}

function setMcpUrl(url) {
  localStorage.setItem('wqb_mcp_url', url);
  toast('MCP URL updated. Refreshing...', 'success');
  setTimeout(() => location.reload(), 1000);
}

// ── SSE Parser ──
function parseSSE(text) {
  const events = [];
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let eventType = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data) {
      try { events.push({ event: eventType, data: JSON.parse(data) }); }
      catch { events.push({ event: eventType, data }); }
    }
  }
  return events;
}

// ── MCP Streamable-HTTP Client ──
class McpClient {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.protocolVersion = '2024-11-05';
    this.serverInfo = null;
    this._tools = {};
    this._reqId = 0;
  }

  _nextId() { return ++this._reqId; }

  async _ssePost(body, sessionId) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) {
      headers['MCP-Session-Id'] = sessionId;
      headers['mcp-protocol-version'] = this.protocolVersion;
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg;
      try { const e = await res.json(); msg = e.error?.message || res.statusText; }
      catch { msg = res.statusText; }
      throw new Error(msg);
    }

    // Read response body (SSE stream)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    // Parse SSE events from buffer
    const events = parseSSE(buffer);

    // Get session ID from response headers (if present)
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    // Find the response event (matching by id or first message event)
    const reqId = body.id;
    for (const evt of events) {
      if (evt.data && typeof evt.data === 'object') {
        if (evt.data.id === reqId) {
          if (evt.data.error) throw new Error(evt.data.error.message || 'MCP error');
          result = evt.data.result;
          break;
        }
        // Fallback: any result
        if (evt.data.result && !result) result = evt.data.result;
      }
    }

    return result;
  }

  async initialize() {
    const body = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'wqb-manager', version: '2.0.0' },
      },
      id: this._nextId(),
    };

    const result = await this._ssePost(body);
    this.serverInfo = result;
    return result;
  }

  async listTools() {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: this._nextId(),
    };

    const result = await this._ssePost(body, this.sessionId);
    const tools = result.tools || [];
    this._tools = {};
    for (const t of tools) this._tools[t.name] = t;
    return tools;
  }

  async callTool(name, args = {}) {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: this._nextId(),
    };

    const result = await this._ssePost(body, this.sessionId);

    // Parse MCP content array
    if (result && result.content && Array.isArray(result.content)) {
      const texts = result.content
        .filter(c => c.type === 'text')
        .map(c => { try { return JSON.parse(c.text); } catch { return c.text; } });
      if (texts.length === 1) return texts[0];
      if (texts.length) return texts;
    }
    return result;
  }

  get connected() { return !!this.sessionId && !!this.serverInfo; }
  get tools() { return this._tools; }
}

let mcp = null;

// ── MCP wrappers ──
async function mcpConnect() {
  const url = getMcpUrl();
  mcp = new McpClient(url);
  const info = await mcp.initialize();
  const tools = await mcp.listTools();
  return { tools, serverInfo: info };
}

async function mcpCall(name, args) {
  if (!mcp || !mcp.connected) throw new Error('MCP not connected');
  return mcp.callTool(name, args);
}

function toolName(candidates) {
  if (!mcp) return candidates[0];
  for (const c of candidates) {
    if (mcp.tools[c]) return c;
  }
  return candidates[0];
}

// ── State ──
const state = {
  templates: [],
  alphas: { results: [], count: 0 },
  operators: {},
  currentTab: 'dashboard',
  tools: [],
  detailAlphaId: null,
  detailTemplateId: null,
};

// ── Toast ──
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.remove(); }, 3000);
}

// ── Tab Navigation ──
function switchTab(name) {
  state.currentTab = name;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('nav.tabs button').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  document.querySelector(`nav.tabs button[data-tab="${name}"]`)?.classList.add('active');
  if (name === 'dashboard') loadDashboard();
  if (name === 'templates') loadTemplates();
  if (name === 'alphas') loadAlphas();
  if (name === 'generate') loadGenerate();
  if (name === 'data') loadData();
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
}
window.closeModal = closeModal;

// ── Cache Refresh ──
window.refreshCache = async function(tool) {
  try {
    const result = await mcpCall('cache_refresh', tool ? { tool } : {});
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    toast(`🔄 缓存已刷新: ${tool || '全部'}`, 'success');
  } catch (e) {
    toast('刷新缓存失败: ' + e.message, 'error');
  }
};

// ── Dashboard ──
async function loadDashboard() {
  const el = document.getElementById('dashboard-content');
  el.innerHTML = '<div class="loader" style="margin:40px auto"></div>';
  try {
    const statusRaw = await mcpCall('wqb_status');
    const status = typeof statusRaw === 'string' ? JSON.parse(statusRaw) : statusRaw;

    document.getElementById('status-dot').className = `status-dot ${status.connected ? 'connected' : ''}`;
    document.getElementById('status-text').textContent = status.connected
      ? `${status.user_id || 'Connected'}`
      : 'Disconnected';

    let alphaCount = 0, opCount = 0, tmplCount = 0;
    try {
      const opsRaw = await mcpCall('search_operators');
      const ops = typeof opsRaw === 'string' ? JSON.parse(opsRaw) : opsRaw;
      state.operators = typeof ops === 'object' ? ops : {};
      opCount = Object.values(state.operators).flat().length;
    } catch {}
    try {
      const statsRaw = await mcpCall('alpha_statistics');
      const stats = typeof statsRaw === 'string' ? JSON.parse(statsRaw) : statsRaw;
      alphaCount = stats.total || 0;
    } catch {}

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-box"><div class="num">${status.connected ? '✅' : '❌'}</div><div class="label">WQB Connected</div></div>
        <div class="stat-box"><div class="num">${alphaCount.toLocaleString()}</div><div class="label">Alphas</div></div>
        <div class="stat-box"><div class="num">${opCount}</div><div class="label">Operators</div></div>
        <div class="stat-box"><div class="num">${(state.templates.length || 0)}</div><div class="label">Templates</div></div>
      </div>
      <div class="card">
        <h3>Connection Info</h3>
        <table>
          <tr><td style="width:120px">Server</td><td>${getMcpUrl()}</td></tr>
          <tr><td>User</td><td>${status.user_id || '-'} (${status.user_email || '-'})</td></tr>
          <tr><td>Status</td><td><span class="tag ${status.connected ? 'tag-green' : 'tag-red'}">${status.connected ? 'Connected' : 'Disconnected'}</span></td></tr>
          <tr><td>Tools</td><td>${Object.keys(mcp ? mcp.tools : {}).length} tools available</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Quick Actions</h3>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="switchTab('alphas')">View Alphas</button>
          <button class="btn btn-primary" onclick="switchTab('generate')">Generate New Alpha</button>
        </div>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>Failed to connect: ${e.message}</p>
      <p style="font-size:12px;color:var(--text2);margin-top:8px">
        Configure MCP URL in ⚙️ Settings (top right)
      </p></div>`;
    document.getElementById('status-dot').className = 'status-dot';
    document.getElementById('status-text').textContent = 'Disconnected';
  }
}

// ── Templates (using local state only — template CRUD via REST) ──
// The MCP server doesn't natively expose template CRUD,
// so we keep templates in localStorage for now
const TEMPLATES_KEY = 'wqb_templates';

function loadLocalTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]'); }
  catch { return []; }
}

function saveLocalTemplates(templates) {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
  state.templates = templates;
}

async function loadTemplates() {
  state.templates = loadLocalTemplates();
  renderTemplates();
}

function renderTemplates() {
  const el = document.getElementById('templates-content');
  const dtId = state.detailTemplateId;
  if (!state.templates.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">📋</div>
        <p>No templates yet</p>
        <button class="btn btn-primary" onclick="showTemplateEditor(-1)">Create Template</button>
      </div>`;
    return;
  }
  let html = '<div class="btn-group"><button class="btn btn-primary" onclick="showTemplateEditor(-1)">+ New Template</button></div>';
  html += '<div class="table-wrap"><table><thead><tr><th></th><th>Name</th><th>Description</th><th>Variables</th><th>Actions</th></tr></thead><tbody>';
  state.templates.forEach((t, i) => {
    const vars = t.templateConfigurations ? Object.keys(t.templateConfigurations).length : 0;
    const isExpanded = dtId === i;
    const safeName = (t.name || 'Unnamed').replace(/[<>&]/g, '');
    html += `<tr onclick="toggleTemplateDetail(${i})" style="cursor:pointer">
      <td>${isExpanded ? '▼' : '▶'}</td>
      <td><strong>${safeName}</strong></td>
      <td class="expr-preview">${(t.description || t.expression || '').substring(0, 100).replace(/[<>&]/g, '')}</td>
      <td>${vars} vars</td>
      <td onclick="event.stopPropagation()">
        <button class="btn btn-sm" onclick="showTemplateEditor(${i})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteTemplate(${i})">Delete</button>
        <button class="btn btn-sm btn-primary" onclick="generateFromTemplate(${i})">Generate</button>
      </td>
    </tr>`;
    if (isExpanded) {
      html += `<tr><td colspan="5" style="padding:0;background:var(--surface2)">
        <div style="padding:16px">${renderTemplateDetail(t)}</div></td></tr>`;
    }
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

window.toggleTemplateDetail = function(idx) {
  state.detailTemplateId = state.detailTemplateId === idx ? null : idx;
  renderTemplates();
};

function renderTemplateDetail(t) {
  let html = `<div class="code-block" style="font-size:13px;white-space:pre-wrap">${t.expression || '(empty expression)'}</div>`;
  if (t.description) {
    html += `<p style="color:var(--text2);font-size:13px;margin:8px 0">${t.description}</p>`;
  }
  const configs = t.templateConfigurations || {};
  if (Object.keys(configs).length) {
    html += '<div style="border-bottom:1px solid var(--border);margin:12px 0"></div>';
    html += '<h4 style="margin-bottom:8px">🔧 Variable Configurations</h4>';
    Object.entries(configs).forEach(([key, conf]) => {
      const typeLabel = conf.configType === 'data' ? '📦 Data Field' : conf.configType === 'operator' ? '🔧 Operator' : '📝 Normal';
      const vals = (conf.variables || []).join(', ');
      html += `<div class="variable-group">
        <h4><code>&lt;${key}/&gt;</code> — <span class="tag tag-blue">${typeLabel}</span></h4>
        <div class="vars">${(conf.variables || []).map(v => `<span class="var-tag">${v.replace(/[<>&]/g,'')}</span>`).join('')}</div>
      </div>`;
    });
  }
  return html;
}

function showTemplateEditor(index) {
  const modal = document.getElementById('modal');
  const isNew = index < 0;
  const t = isNew ? { name: '', description: '', expression: '', templateConfigurations: {} } : state.templates[index];

  let varsHtml = '';
  if (t.templateConfigurations) {
    varsHtml = Object.entries(t.templateConfigurations).map(([key, conf]) => {
      const vars = (conf.variables || []).join('\n');
      const browseBtn = conf.configType === 'data'
        ? `<button class="btn btn-sm" onclick="browseFields('${key}')">🔍 Browse Fields</button>`
        : conf.configType === 'operator'
        ? `<button class="btn btn-sm" onclick="browseOperators('${key}')">🔍 Browse Operators</button>`
        : '';
      return `<div class="variable-group" data-varname="${key}">
        <label>Variable: <strong>${key}</strong></label>
        <select style="margin-bottom:4px" onchange="updateVarBrowseBtn('${key}')">
          <option value="data" ${conf.configType === 'data' ? 'selected' : ''}>Data Field</option>
          <option value="operator" ${conf.configType === 'operator' ? 'selected' : ''}>Operator</option>
          <option value="normal" ${conf.configType === 'normal' ? 'selected' : ''}>Normal Value</option>
        </select>
        <textarea id="var-${key}" rows="4" placeholder="One value per line">${vars}</textarea>
        <div id="browse-${key}" style="margin-top:4px">${browseBtn}</div>
        <button class="btn btn-sm btn-danger" onclick="removeVar('${key}')" style="margin-top:4px">Remove</button>
      </div>`;
    }).join('');
  }

  modal.querySelector('.modal-content').innerHTML = `
    <h2>${isNew ? 'Create' : 'Edit'} Template</h2>
    <label>Template Name</label>
    <input id="tmpl-name" value="${t.name || ''}" placeholder="e.g. Double Neutral in Analyst15" />
    <label>Description</label>
    <textarea id="tmpl-desc" rows="2" placeholder="Template description">${t.description || ''}</textarea>
    <label>Expression (use <code>&lt;var_name/></code> for variables)</label>
    <textarea id="tmpl-expr" rows="6" placeholder="e.g. group(rank(&lt;field/>), sector)">${t.expression || ''}</textarea>
    <label>Variables</label>
    <div id="vars-container">${varsHtml || '<p style="color:var(--text2);font-size:13px">No variables defined. Add one below.</p>'}</div>
    <button class="btn btn-sm" onclick="addVar()">+ Add Variable</button>
    <div class="btn-group">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTemplate(${index})">Save</button>
    </div>`;
  modal.classList.add('show');
}

window.addVar = function() {
  const name = prompt('Variable name (e.g. field, operator, window):');
  if (!name) return;
  const container = document.getElementById('vars-container');
  if (document.getElementById(`var-${name}`)) { toast('Variable already exists', 'error'); return; }
  const div = document.createElement('div');
  div.className = 'variable-group';
  div.setAttribute('data-varname', name);
  div.innerHTML = `
    <label>Variable: <strong>${name}</strong></label>
    <select style="margin-bottom:4px" onchange="updateVarBrowseBtn('${name}')">
      <option value="data">Data Field</option>
      <option value="operator">Operator</option>
      <option value="normal" selected>Normal Value</option>
    </select>
    <textarea id="var-${name}" rows="4" placeholder="One value per line"></textarea>
    <div id="browse-${name}" style="margin-top:4px"></div>
    <button class="btn btn-sm btn-danger" onclick="removeVar('${name}')" style="margin-top:4px">Remove</button>`;
  container.appendChild(div);
  updateVarBrowseBtn(name);
};

window.updateVarBrowseBtn = function(name) {
  const container = document.getElementById(`browse-${name}`);
  if (!container) return;
  const select = container.closest('.variable-group').querySelector('select');
  const type = select ? select.value : 'normal';
  if (type === 'data') {
    container.innerHTML = `<button class="btn btn-sm" onclick="browseFields('${name}')">🔍 Browse Fields</button>`;
  } else if (type === 'operator') {
    container.innerHTML = `<button class="btn btn-sm" onclick="browseOperators('${name}')">🔍 Browse Operators</button>`;
  } else {
    container.innerHTML = '';
  }
};

window.browseFields = async function(varName) {
  try {
    const region = 'USA';
    const raw = await mcpCall('search_fields', { region, limit: 100 });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = result.data || result;
    const fields = Array.isArray(data) ? data : (data.fields || data.results || []);
    
    if (!fields.length) { toast('No fields found', 'info'); return; }
    
    // Show a quick picker modal
    const modal = document.getElementById('modal');
    let listHtml = fields.map(f => {
      const id = f.id || f.fieldId || '';
      const name = f.name || f.field || id;
      return `<tr onclick="pickField('${varName}','${name.replace(/'/g, "")}')" style="cursor:pointer">
        <td style="font-size:11px">${id}</td>
        <td>${name}</td>
        <td><small>${(f.datasetName || f.dataset || '').substring(0, 30)}</small></td>
      </tr>`;
    }).join('');
    
    modal.querySelector('.modal-content').innerHTML = `
      <h2>🔤 Select Field for <code>&lt;${varName}/&gt;</code></h2>
      <div class="table-wrap" style="max-height:400px;overflow-y:auto">
      <table><thead><tr><th>ID</th><th>Name</th><th>Dataset</th></tr></thead><tbody>${listHtml}</tbody></table></div>
      <div class="btn-group"><button class="btn" onclick="closeModal()">Cancel</button></div>`;
    modal.classList.add('show');
  } catch (e) {
    toast('Browse error: ' + e.message, 'error');
  }
};

window.browseOperators = async function(varName) {
  try {
    // Try cache first, then fetch
    const raw = await mcpCall('search_operators', {});
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const groups = typeof result === 'object' ? result : {};
    
    const modal = document.getElementById('modal');
    let listHtml = Object.entries(groups).map(([cat, ops]) => {
      const items = Array.isArray(ops) ? ops.map(op => 
        `<tr onclick="pickField('${varName}','${op.replace(/'/g, "")}')" style="cursor:pointer">
          <td>${op}</td><td><span class="tag tag-blue">${cat}</span></td>
        </tr>`
      ).join('') : '';
      return items;
    }).join('');
    
    modal.querySelector('.modal-content').innerHTML = `
      <h2>🔧 Select Operator for <code>&lt;${varName}/&gt;</code></h2>
      <div class="table-wrap" style="max-height:400px;overflow-y:auto">
      <table><thead><tr><th>Name</th><th>Category</th></tr></thead><tbody>${listHtml || '<tr><td colspan="2">No operators found</td></tr>'}</tbody></table></div>
      <div class="btn-group"><button class="btn" onclick="closeModal()">Cancel</button></div>`;
    modal.classList.add('show');
  } catch (e) {
    toast('Browse error: ' + e.message, 'error');
  }
};

window.pickField = function(varName, value) {
  const ta = document.getElementById(`var-${varName}`);
  if (!ta) return;
  if (ta.value.trim()) ta.value += '\n' + value;
  else ta.value = value;
  toast(`Added: ${value}`, 'success');
  closeModal();
};

window.removeVar = function(name) {
  document.querySelectorAll('.variable-group').forEach(el => {
    if (el.querySelector(`#var-${name}`)) el.remove();
  });
};

window.saveTemplate = function(index) {
  const name = document.getElementById('tmpl-name').value.trim();
  const description = document.getElementById('tmpl-desc').value.trim();
  const expression = document.getElementById('tmpl-expr').value.trim();

  const configs = {};
  document.querySelectorAll('.variable-group').forEach(el => {
    const textarea = el.querySelector('textarea');
    if (!textarea) return;
    const key = textarea.id.replace('var-', '');
    const vals = textarea.value.split('\n').map(v => v.trim()).filter(Boolean);
    const select = el.querySelector('select');
    const configType = select ? select.value : 'normal';
    configs[key] = { variables: vals, configType };
  });

  const template = { name, description, expression, templateConfigurations: configs };

  const templates = loadLocalTemplates();
  if (index < 0) {
    templates.push(template);
    toast('Template created (local)', 'success');
  } else {
    templates[index] = template;
    toast('Template updated (local)', 'success');
  }
  saveLocalTemplates(templates);
  closeModal();
  loadTemplates();
};

window.deleteTemplate = function(index) {
  if (!confirm('Delete this template?')) return;
  const templates = loadLocalTemplates();
  templates.splice(index, 1);
  saveLocalTemplates(templates);
  toast('Template deleted', 'success');
  loadTemplates();
};

window.generateFromTemplate = function(index) {
  switchTab('generate');
  setTimeout(() => {
    document.getElementById('gen-template').value = index;
    loadGenerate();
  }, 100);
};

// ── Generate ──
async function loadGenerate() {
  const el = document.getElementById('generate-content');
  const templates = loadLocalTemplates();
  state.templates = templates;

  const selectedIdx = document.getElementById('gen-template')?.value || '';

  let html = `
  <div class="card">
    <h3>Generate Alphas from Template</h3>
    <div class="form-row">
      <div>
        <label>Template</label>
        <select id="gen-template-select" onchange="updateGenerateForm()">
          <option value="">-- Select Template --</option>
          ${templates.map((t, i) => `<option value="${i}" ${i == selectedIdx ? 'selected' : ''}>${t.name || 'Template ' + i}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="gen-template-detail"></div>
    <div id="gen-params" style="margin-top:12px"></div>
    <div id="gen-preview" style="margin-top:12px"></div>
  </div>`;

  el.innerHTML = html;
  if (selectedIdx !== '') updateGenerateForm();
}

window.updateGenerateForm = function() {
  const sel = document.getElementById('gen-template-select');
  const idx = parseInt(sel.value);
  if (isNaN(idx)) return;
  const t = state.templates[idx];
  if (!t) return;

  const detail = document.getElementById('gen-template-detail');
  let varsHtml = '';
  if (t.templateConfigurations) {
    varsHtml = Object.entries(t.templateConfigurations)
      .map(([key, conf]) => `<span class="tag tag-blue" style="margin:2px">&lt;${key}/&gt; (${(conf.variables || []).length} vals)</span>`)
      .join(' ');
  }

  detail.innerHTML = `
    <p style="margin:8px 0"><strong>${t.name}</strong> — ${t.description || ''}</p>
    <div class="code-block">${t.expression || ''}</div>
    <div style="margin:8px 0">${varsHtml}</div>`;

  const params = document.getElementById('gen-params');
  params.innerHTML = `
    <div class="form-row">
      <div><label>Region</label><select id="gen-region">
        <option value="USA">USA</option><option value="CHN">CHN</option>
        <option value="EUR">EUR</option><option value="JPN">JPN</option>
      </select></div>
      <div><label>Delay</label><select id="gen-delay">
        <option value="0">0</option><option value="1" selected>1</option>
      </select></div>
      <div><label>Universe</label><select id="gen-universe">
        <option value="TOP3000">TOP3000</option><option value="TOP1000">TOP1000</option><option value="TOP500">TOP500</option>
      </select></div>
      <div><label>Max Alphas</label><input id="gen-max" type="number" value="20" min="1" max="200" /></div>
    </div>
    <button class="btn btn-primary" onclick="generateFromExpression()">Generate Alphas</button>`;
};

window.generateFromExpression = async function() {
  const sel = document.getElementById('gen-template-select');
  const idx = parseInt(sel.value);
  if (isNaN(idx)) return;
  const t = state.templates[idx];

  const expr = t.expression;
  const maxSamples = parseInt(document.getElementById('gen-max').value) || 20;

  // Build alphas from template configs
  const configs = t.templateConfigurations || {};
  const keys = Object.keys(configs);
  let alphas = [];

  function generateCombinations(configs, idx, current) {
    if (idx >= keys.length) {
      let expr2 = expr;
      for (const [k, v] of Object.entries(current)) {
        expr2 = expr2.replace(new RegExp(`<${k}/>`, 'g'), v);
      }
      alphas.push({ expression: expr2 });
      return;
    }
    const key = keys[idx];
    const conf = configs[key];
    const values = conf.variables || [];
    for (const val of values.slice(0, Math.ceil(maxSamples / values.length))) {
      generateCombinations(configs, idx + 1, { ...current, [key]: val });
    }
  }

  generateCombinations(configs, 0, {});
  alphas = alphas.slice(0, maxSamples);

  const preview = document.getElementById('gen-preview');
  if (!alphas.length) {
    preview.innerHTML = '<p style="color:var(--text2)">No expressions generated (check template variables)</p>';
    return;
  }

  preview.innerHTML = `
    <p><strong>${alphas.length}</strong> expressions from template</p>
    <div class="table-wrap" style="max-height:300px;overflow-y:auto">
    <table><thead><tr><th>#</th><th>Expression</th><th>Actions</th></tr></thead><tbody>
      ${alphas.map((a, i) => `<tr>
        <td>${i+1}</td>
        <td><span class="expr-preview">${a.expression}</span></td>
        <td><button class="btn btn-sm" onclick="simulateSingle('${a.expression.replace(/'/g, "\\'")}')">Simulate</button></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="btn-group" style="margin-top:8px">
      <button class="btn btn-primary" onclick="batchSimulateGenerated()">🚀 Batch Simulate All</button>
      <button class="btn" onclick="exportAlphas()">📥 Export JSON</button>
    </div>`;
  window._generatedAlphas = alphas;
};

window.simulateSingle = async function(expr) {
  try {
    toast('Simulating...', 'info');
    const raw = await mcpCall('simulate_alpha', {
      expression: expr,
      region: document.getElementById('gen-region').value,
      delay: parseInt(document.getElementById('gen-delay').value),
      universe: document.getElementById('gen-universe').value,
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = result.data || result;
    const isData = data.is || data.info || data.stats || {};
    const sharpe = isData.sharpe || data.sharpe || 'N/A';
    toast(`Sharpe: ${sharpe}`, (data.status === 'ERROR') ? 'error' : 'success');
  } catch (e) {
    toast('Simulation error: ' + e.message, 'error');
  }
};

window.batchSimulateGenerated = async function() {
  const alphas = window._generatedAlphas;
  if (!alphas || !alphas.length) { toast('No alphas to simulate', 'error'); return; }

  try {
    toast(`Starting batch simulation of ${alphas.length} alphas...`, 'info');

    const expressionsJson = JSON.stringify(
      alphas.map((a, i) => ({ expression: a.expression, name: `gen_${i+1}` }))
    );

    const raw = await mcpCall('simulate_alphas', {
      expressions: expressionsJson,
      region: document.getElementById('gen-region').value,
      delay: parseInt(document.getElementById('gen-delay').value),
      universe: document.getElementById('gen-universe').value,
      concurrency: 5,
    });

    const results = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const resultList = Array.isArray(results) ? results : (results.results || []);

    const good = resultList.filter(r => {
      const d = r.data || r;
      const s = parseFloat(d.sharpe || (d.is && d.is.sharpe));
      return !isNaN(s) && s > 1.5;
    });

    toast(`Done! ${resultList.length} results, ${good.length} with Sharpe > 1.5`, 'success');

    const preview = document.getElementById('gen-preview');
    const tableRows = resultList.map((r, i) => {
      const d = r.data || r;
      const isData = d.is || d.info || d.stats || {};
      const sharpe = isData.sharpe || d.sharpe || '-';
      const fitness = isData.fitness || d.fitness || '-';
      const statusCode = r.status_code || r.status || '?';
      const sharpeVal = parseFloat(sharpe);
      const highlight = !isNaN(sharpeVal) && sharpeVal > 1.5 ? 'style="background:rgba(63,185,80,0.1)"' : '';
      return `<tr ${highlight}>
        <td>${i+1}</td>
        <td>${statusCode}</td>
        <td>${sharpe}</td>
        <td>${fitness}</td>
      </tr>`;
    }).join('');

    preview.innerHTML += `
      <div class="card" style="margin-top:12px">
        <h3>Batch Results</h3>
        <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat-box"><div class="num">${resultList.length}</div><div class="label">Total</div></div>
          <div class="stat-box"><div class="num">${good.length}</div><div class="label" style="color:var(--green)">Sharpe > 1.5</div></div>
        </div>
        <div class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table><thead><tr><th>#</th><th>Status</th><th>Sharpe</th><th>Fitness</th></tr></thead>
        <tbody>${tableRows}</tbody></table></div>
      </div>`;
  } catch (e) {
    toast('Batch error: ' + e.message, 'error');
  }
};

window.exportAlphas = function() {
  const alphas = window._generatedAlphas;
  if (!alphas) return;
  const blob = new Blob([JSON.stringify(alphas, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'generated_alphas.json';
  a.click();
  URL.revokeObjectURL(url);
};

// ── Alphas ──
const alphaFilters = { search: '', region: 'USA', status: '' };

async function loadAlphas() {
  const el = document.getElementById('alphas-content');
  el.innerHTML = '<div class="loader" style="margin:40px auto"></div>';
  try {
    // Read current filter values (save to state)
    alphaFilters.search = document.getElementById('alpha-search')?.value || '';
    alphaFilters.region = document.getElementById('alpha-region')?.value || 'USA';
    alphaFilters.status = document.getElementById('alpha-status')?.value || '';

    const params = { region: alphaFilters.region, limit: 50 };
    if (alphaFilters.search) params.search = alphaFilters.search;
    if (alphaFilters.status) params.status = alphaFilters.status;

    const raw = await mcpCall('search_alphas', params);
    const results = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const list = Array.isArray(results) ? results : (results.results || []);

    state.alphas = { results: list, count: list.length };
    renderAlphas();
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${e.message}</p></div>`;
  }
}

function fmt(v) {
  if (v === undefined || v === null) return '-';
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function renderAlphas() {
  const el = document.getElementById('alphas-content');
  const results = state.alphas.results || [];

  const sel = (v, t) => v === t ? 'selected' : '';
  let html = `
  <div class="filter-bar">
    <input id="alpha-search" placeholder="Search..." onchange="loadAlphas()" value="${alphaFilters.search}" />
    <select id="alpha-region" onchange="loadAlphas()">
      <option value="USA" ${sel(alphaFilters.region,'USA')}>USA</option>
      <option value="CHN" ${sel(alphaFilters.region,'CHN')}>CHN</option>
      <option value="EUR" ${sel(alphaFilters.region,'EUR')}>EUR</option>
      <option value="JPN" ${sel(alphaFilters.region,'JPN')}>JPN</option>
    </select>
    <select id="alpha-status" onchange="loadAlphas()">
      <option value="" ${sel(alphaFilters.status,'')}>📋 全部</option>
      <option value="ACTIVE" ${sel(alphaFilters.status,'ACTIVE')}>✅ ACTIVE</option>
      <option value="SIMULATING" ${sel(alphaFilters.status,'SIMULATING')}>⏳ SIMULATING</option>
      <option value="SIMULATED" ${sel(alphaFilters.status,'SIMULATED')}>📊 SIMULATED</option>
      <option value="SUBMITTED" ${sel(alphaFilters.status,'SUBMITTED')}>📤 已提交</option>
      <option value="UNSUBMITTED" ${sel(alphaFilters.status,'UNSUBMITTED')}>📝 未提交</option>
    </select>
    <button class="btn btn-primary btn-sm" onclick="loadAlphas()">🔍 搜索</button>
    <button class="btn btn-sm" onclick="refreshCache('search_alphas');loadAlphas()">🔄 刷新缓存</button>
    <span style="color:var(--text2);font-size:13px;margin-left:auto">Total: ${state.alphas.count}</span>
  </div>`;

  if (!results.length) {
    html += '<div class="empty-state"><div class="icon">📊</div><p>No alphas found</p></div>';
    el.innerHTML = html;
    return;
  }

  html += '<div class="table-wrap" style="max-height:500px;overflow-y:auto"><table><thead><tr>' +
    '<th></th><th>ID</th><th>Expression</th><th>Status</th><th>Sharpe</th><th>Fitness</th><th>Returns</th><th>Created</th></tr></thead><tbody>';

  const detailAlpha = state.detailAlphaId;

  results.forEach(a => {
    const status = a.status || '?';
    const statusTag = status === 'ACTIVE' ? 'tag-green' : status === 'SUBMITTED' ? 'tag-blue' : status === 'SIMULATING' ? 'tag-yellow' : status === 'SIMULATED' ? '' : '';
    const expr = (a.regular && a.regular.code) || a.regular || '';
    const is = a.is || {};
    const sharpe = fmt(is.sharpe);
    const fitness = fmt(is.fitness);
    const returns = fmt(is.returns);
    const sharpeHighlight = !isNaN(parseFloat(is.sharpe)) && parseFloat(is.sharpe) > 1.5 ? 'style="color:var(--green);font-weight:600"' : '';
    const safeId = (a.id || '?').replace(/[<>&"']/g, '');
    const dateStr = (a.dateCreated || '').substring(0, 10);
    const isExpanded = a.id === detailAlpha;
    html += `<tr onclick="toggleAlphaDetail('${a.id}')" style="cursor:pointer">
      <td>${isExpanded ? '▼' : '▶'}</td>
      <td style="font-size:11px"><span class="expr-preview" title="${safeId}">${safeId}</span></td>
      <td><span class="expr-preview">${String(expr).substring(0, 80).replace(/[<>&]/g, '')}</span></td>
      <td><span class="tag ${statusTag}">${status}</span></td>
      <td ${sharpeHighlight}>${sharpe}</td>
      <td>${fitness}</td>
      <td>${returns}</td>
      <td style="font-size:11px">${dateStr}</td>
    </tr>`;
    if (isExpanded) {
      html += `<tr><td colspan="8" style="padding:0;background:var(--surface2)">
        <div style="padding:16px">${renderAlphaDetail(a)}</div></td></tr>`;
    }
  });
  html += '</tbody></table></div>';

  html += `
  <div class="card" style="margin-top:12px">
    <h3>Single Alpha Simulator</h3>
    <label>Expression</label>
    <textarea id="sim-expr" rows="3" placeholder="e.g. group(rank(close), sector)"></textarea>
    <div class="form-row">
      <div><label>Region</label><select id="sim-region">
        <option value="USA">USA</option><option value="CHN">CHN</option>
        <option value="EUR">EUR</option><option value="JPN">JPN</option>
      </select></div>
      <div><label>Delay</label><select id="sim-delay"><option value="0">0</option><option value="1" selected>1</option></select></div>
      <div><label>Universe</label><select id="sim-universe">
        <option value="TOP3000">TOP3000</option><option value="TOP1000">TOP1000</option><option value="TOP500">TOP500</option>
      </select></div>
    </div>
    <button class="btn btn-primary" onclick="simulateAlpha()">Simulate</button>
    <div id="sim-result" style="margin-top:8px"></div>
  </div>`;
  el.innerHTML = html;
}

// ── Alpha Detail ──
window.toggleAlphaDetail = function(alphaId) {
  if (state.detailAlphaId === alphaId) {
    state.detailAlphaId = null;
  } else {
    state.detailAlphaId = alphaId;
  }
  renderAlphas();
};

function renderAlphaDetail(a) {
  const s = a.settings || {};
  const is = a.is || {};
  const os = a.os || {};
  const train = a.train || {};
  const test = a.test || {};
  const prod = a.prod || {};

  function metricBlock(label, data, color) {
    if (!Object.keys(data).length) return '';
    const vals = ['sharpe','fitness','returns','drawdown','turnover','margin']
      .filter(k => data[k] !== undefined)
      .map(k => `<div class="stat-box">
        <div class="num" style="color:${color||'var(--accent)'}">${fmt(data[k])}</div>
        <div class="label">${k}</div>
      </div>`).join('');
    if (!vals) return '';
    return `<div style="margin:12px 0">
      <h4 style="margin-bottom:8px;color:var(--text2)">${label}</h4>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${vals}</div>
    </div>`;
  }

  // Expression
  let html = `<div style="margin-bottom:12px">
    <div class="code-block" style="font-size:13px;white-space:pre-wrap">${(a.regular && a.regular.code) || a.regular || '(empty)'}</div>
  </div>`;

  // Metrics across all time windows
  html += '<div style="border-bottom:1px solid var(--border);margin-bottom:12px"></div>';
  html += '<h4 style="margin-bottom:8px">📊 Performance Metrics</h4>';
  html += metricBlock('📈 In-Sample (is)', is, 'var(--accent)');
  html += metricBlock('📉 Out-of-Sample (os)', os, 'var(--green)');
  html += metricBlock('🎯 Train', train, 'var(--orange)');
  html += metricBlock('🧪 Test', test, 'var(--accent)');
  html += metricBlock('🏭 Prod', prod, 'var(--green)');

  // Settings
  html += '<div style="border-bottom:1px solid var(--border);margin-bottom:12px"></div>';
  html += '<h4 style="margin-bottom:8px">⚙️ Settings</h4>';
  html += '<div class="pills">';
  const settingMap = {
    region: 'Region', universe: 'Universe', delay: 'Delay', decay: 'Decay',
    neutralization: 'Neutralization', truncation: 'Truncation',
    pasteurization: 'Pasteurization', unitHandling: 'Unit',
    nanHandling: 'NaN', language: 'Lang', instrumentType: 'Type',
  };
  Object.entries(settingMap).forEach(([k, label]) => {
    if (s[k] !== undefined) html += `<span>${label}: ${s[k]}</span>`;
  });
  html += '</div>';

  // Dates
  html += '<div style="border-bottom:1px solid var(--border);margin:12px 0"></div>';
  html += '<h4 style="margin-bottom:8px">📅 Timeline</h4>';
  html += '<table style="font-size:12px;width:auto"><tr>';
  ['dateCreated','dateSubmitted','dateModified'].forEach(k => {
    if (a[k]) html += `<td style="padding:2px 12px 2px 0"><strong>${k}</strong></td><td>${a[k].substring(0,16)}</td>`;
  });
  html += '</tr></table>';

  // Author & meta
  html += '<div style="border-bottom:1px solid var(--border);margin:12px 0"></div>';
  html += '<div class="pills">';
  if (a.author) html += `<span>👤 ${a.author}</span>`;
  if (a.category) html += `<span>📂 ${a.category}</span>`;
  if (a.type) html += `<span>📄 ${a.type}</span>`;
  if (a.grade) html += `<span>⭐ ${a.grade}</span>`;
  if (a.stage) html += `<span>📌 ${a.stage}</span>`;
  if (a.favorite) html += '<span>⭐ Favorite</span>';
  html += '</div>';

  // Tags
  if (a.tags && a.tags.length) {
    html += '<div style="margin-top:8px">';
    a.tags.forEach(t => { html += `<span class="tag tag-blue">${t}</span> `; });
    html += '</div>';
  }

  return html;
}

window.simulateAlpha = async function() {
  const expr = document.getElementById('sim-expr').value.trim();
  if (!expr) { toast('Enter an expression', 'error'); return; }

  const resultDiv = document.getElementById('sim-result');
  resultDiv.innerHTML = '<div class="loader"></div>';

  try {
    const raw = await mcpCall('simulate_alpha', {
      expression: expr,
      region: document.getElementById('sim-region').value,
      delay: parseInt(document.getElementById('sim-delay').value),
      universe: document.getElementById('sim-universe').value,
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = result.data || result;

    if (data.status === 'ERROR') {
      resultDiv.innerHTML = `<div class="tag tag-red">Error: ${data.message || 'Unknown error'}</div>`;
      return;
    }

    const isData = data.is || data.info || data.stats || {};
    resultDiv.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat-box"><div class="num">${isData.sharpe ?? data.sharpe ?? '-'}</div><div class="label">Sharpe</div></div>
        <div class="stat-box"><div class="num">${isData.fitness ?? data.fitness ?? '-'}</div><div class="label">Fitness</div></div>
        <div class="stat-box"><div class="num">${isData.returns ?? data.returns ?? '-'}</div><div class="label">Returns</div></div>
        <div class="stat-box"><div class="num">${isData.drawdown ?? data.drawdown ?? '-'}</div><div class="label">Drawdown</div></div>
      </div>
      <div class="btn-group" style="margin-top:8px">
        <button class="btn btn-sm btn-primary" onclick="submitAlpha('${expr.replace(/'/g, "\\'")}')">Submit Alpha</button>
      </div>`;

    const sv = parseFloat(isData.sharpe ?? data.sharpe);
    if (!isNaN(sv) && sv > 1.5) toast(`Sharpe: ${sv} 🎯`, 'success');
  } catch (e) {
    resultDiv.innerHTML = `<div class="tag tag-red">Error: ${e.message}</div>`;
  }
};

window.submitAlpha = async function(expr) {
  try {
    const raw = await mcpCall('submit_alpha', {
      expression: expr,
      region: document.getElementById('sim-region').value,
      delay: parseInt(document.getElementById('sim-delay').value),
      universe: document.getElementById('sim-universe').value,
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    toast(`Submitted! (${result.status_code || 'ok'})`, 'success');
  } catch (e) {
    toast('Submit error: ' + e.message, 'error');
  }
};

// ── Settings ──
window.showSettings = function() {
  const modal = document.getElementById('modal');
  modal.querySelector('.modal-content').innerHTML = `
    <h2>Settings</h2>
    <label>MCP URL</label>
    <input id="mcp-url-input" value="${getMcpUrl()}" placeholder="http://203.83.228.3:8009/mcp" />
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
      MCP server endpoint (streamable-http transport).
    </p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
      Claude Desktop config:
    </p>
    <div class="code-block" style="font-size:11px;margin-bottom:12px">{
  "mcpServers": {
    "wqb": {
      "url": "${getMcpUrl()}"
    }
  }
}</div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
      Available MCP tools: ${Object.keys(mcp ? mcp.tools : {}).length}
    </p>
    <div class="btn-group">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="setMcpUrl(document.getElementById('mcp-url-input').value)">Save</button>
    </div>`;
  modal.classList.add('show');
};

// ── Data Browser ──
const dataState = {
  datasets: [],
  fields: [],
  selected: [],
  detail: null,
  mode: 'datasets',
  loading: false,
  lastParams: {},
};

async function loadData() {
  const el = document.getElementById('data-content');
  dataState.selected = dataState.selected || [];

  el.innerHTML = `
    <div class="data-browser">
      <div class="data-tabs">
        <button data-dtab="datasets" class="active" onclick="switchDataTab('datasets')">📦 Datasets</button>
        <button data-dtab="fields" onclick="switchDataTab('fields')">🔤 Fields</button>
      </div>

      <div id="data-filter-panel"></div>
      <div id="data-results"></div>

      <div class="card">
        <h3>📋 Selected Items <span style="font-weight:400;font-size:12px;color:var(--text2)" id="selected-count">(0)</span></h3>
        <div class="selected-list" id="selected-list">
          <span style="color:var(--text2);font-size:13px">Click + to add items from search results</span>
        </div>
        <div class="btn-group">
          <button class="btn btn-sm" onclick="copySelectedAsJson()">📋 Copy JSON</button>
          <button class="btn btn-sm btn-danger" onclick="clearSelected()">🗑️ Clear All</button>
        </div>
      </div>

      <div id="data-detail"></div>
    </div>`;

  switchDataTab('datasets');
}

window.switchDataTab = function(tab) {
  dataState.mode = tab;
  document.querySelectorAll('.data-tabs button').forEach(b => b.classList.remove('active'));
  document.querySelector(`.data-tabs button[data-dtab="${tab}"]`)?.classList.add('active');
  renderDataFilters();
};

function renderDataFilters() {
  const panel = document.getElementById('data-filter-panel');
  const isDatasets = dataState.mode === 'datasets';

  panel.innerHTML = `
    <div class="card">
      <h3>🔍 ${isDatasets ? 'Search Datasets' : 'Search Fields'}</h3>
      <div class="filter-bar">
        <input id="data-search" placeholder="Keyword..." value="${dataState.lastParams.search || ''}" />
        <select id="data-region">
          <option value="USA" ${(dataState.lastParams.region||'USA')==='USA'?'selected':''}>USA</option>
          <option value="CHN" ${dataState.lastParams.region==='CHN'?'selected':''}>CHN</option>
          <option value="EUR" ${dataState.lastParams.region==='EUR'?'selected':''}>EUR</option>
          <option value="JPN" ${dataState.lastParams.region==='JPN'?'selected':''}>JPN</option>
        </select>
        <select id="data-delay">
          <option value="1" ${(dataState.lastParams.delay||1)==1?'selected':''}>Delay 1</option>
          <option value="0" ${dataState.lastParams.delay===0?'selected':''}>No Delay</option>
        </select>
        <select id="data-universe">
          <option value="TOP3000" ${(dataState.lastParams.universe||'TOP3000')==='TOP3000'?'selected':''}>TOP3000</option>
          <option value="TOP1000" ${dataState.lastParams.universe==='TOP1000'?'selected':''}>TOP1000</option>
          <option value="TOP500" ${dataState.lastParams.universe==='TOP500'?'selected':''}>TOP500</option>
        </select>
        ${isDatasets ? '' : `<input id="data-dataset-id" placeholder="Dataset ID filter..." value="${dataState.lastParams.dataset_id || ''}" style="min-width:100px" />`}
        <select id="data-category">
          <option value="">All Categories</option>
          <option value="pv" ${dataState.lastParams.category==='pv'?'selected':''}>PV</option>
          <option value="model" ${dataState.lastParams.category==='model'?'selected':''}>Model</option>
          <option value="analyst" ${dataState.lastParams.category==='analyst'?'selected':''}>Analyst</option>
          <option value="fundamental" ${dataState.lastParams.category==='fundamental'?'selected':''}>Fundamental</option>
          <option value="technical" ${dataState.lastParams.category==='technical'?'selected':''}>Technical</option>
          <option value="sentiment" ${dataState.lastParams.category==='sentiment'?'selected':''}>Sentiment</option>
          <option value="alternative" ${dataState.lastParams.category==='alternative'?'selected':''}>Alternative</option>
        </select>
        <button class="btn btn-primary btn-sm" onclick="searchData()">🔍 Search</button>
      </div>
    </div>`;
}

window.searchData = async function() {
  const isDatasets = dataState.mode === 'datasets';
  const params = {
    region: document.getElementById('data-region').value,
    delay: parseInt(document.getElementById('data-delay').value),
    universe: document.getElementById('data-universe').value,
    search: document.getElementById('data-search').value,
    category: document.getElementById('data-category').value,
    limit: 50,
  };
  if (!isDatasets) {
    params.dataset_id = document.getElementById('data-dataset-id')?.value || '';
  }
  dataState.lastParams = params;

  const resultsDiv = document.getElementById('data-results');
  resultsDiv.innerHTML = '<div class="loader" style="margin:20px auto"></div>';

  try {
    if (isDatasets) {
      const raw = await mcpCall('search_datasets', params);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const data = result.data || result;
      dataState.datasets = Array.isArray(data) ? data : (data.datasets || data.results || []);
      renderDatasets();
    } else {
      const raw = await mcpCall('search_fields', params);
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const data = result.data || result;
      dataState.fields = Array.isArray(data) ? data : (data.fields || data.results || []);
      renderFields();
    }
  } catch (e) {
    resultsDiv.innerHTML = `<div class="empty-state"><p>Search error: ${e.message}</p></div>`;
  }
};

function renderDatasets() {
  const resultsDiv = document.getElementById('data-results');
  const list = dataState.datasets;
  if (!list.length) {
    resultsDiv.innerHTML = '<div class="empty-state"><div class="icon">📦</div><p>No datasets found</p></div>';
    return;
  }

  let html = `<div class="dataset-list"><table><thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Description</th><th></th></tr></thead><tbody>`;
  list.forEach(ds => {
    const id = ds.id || ds.datasetId || '-';
    const name = ds.name || ds.dataset || '-';
    const cat = ds.category || ds.type || '-';
    const desc = (ds.description || ds.longDescription || '').substring(0, 80);
    const isSelected = dataState.selected.some(s => s.id === id && s.type === 'dataset');
    html += `<tr>
      <td style="font-size:11px"><span class="expr-preview" title="${id}">${id}</span></td>
      <td><strong>${name}</strong></td>
      <td><span class="tag tag-blue">${cat}</span></td>
      <td><small>${desc}</small></td>
      <td>
        <button class="btn btn-sm" onclick="locateItem('${id}', 'dataset')" title="Details">ℹ️</button>
        ${isSelected
          ? `<button class="btn btn-sm tag-red" onclick="removeSelected('${id}')" style="color:var(--red)">✕</button>`
          : `<button class="btn btn-sm btn-primary" onclick="addSelected({id:'${id}',name:'${name.replace(/'/g, "\\'")}',type:'dataset',category:'${cat}'})">+ Add</button>`
        }
      </td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  html += `<p style="font-size:12px;color:var(--text2)">${list.length} datasets</p>`;
  resultsDiv.innerHTML = html;
}

function renderFields() {
  const resultsDiv = document.getElementById('data-results');
  const list = dataState.fields;
  if (!list.length) {
    resultsDiv.innerHTML = '<div class="empty-state"><div class="icon">🔤</div><p>No fields found</p></div>';
    return;
  }

  let html = `<div class="field-list"><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Dataset</th><th>Description</th><th></th></tr></thead><tbody>`;
  list.forEach(f => {
    const id = f.id || f.fieldId || '-';
    const name = f.name || f.field || '-';
    const type = f.type || f.dataType || f.kind || '-';
    const dsName = f.datasetName || f.dataset || '-';
    const desc = (f.description || f.longDescription || '').substring(0, 60);
    const isSelected = dataState.selected.some(s => s.id === id && s.type === 'field');
    html += `<tr>
      <td style="font-size:11px"><span class="expr-preview" title="${id}">${id}</span></td>
      <td><strong>${name}</strong></td>
      <td><span class="tag tag-yellow">${type}</span></td>
      <td><small>${dsName}</small></td>
      <td><small>${desc}</small></td>
      <td>
        <button class="btn btn-sm" onclick="locateItem('${id}', 'field')" title="Details">ℹ️</button>
        ${isSelected
          ? `<button class="btn btn-sm tag-red" onclick="removeSelected('${id}')" style="color:var(--red)">✕</button>`
          : `<button class="btn btn-sm btn-primary" onclick="addSelected({id:'${id}',name:'${name.replace(/'/g, "\\'")}',type:'field',dataType:'${type}'})">+ Add</button>`
        }
      </td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  html += `<p style="font-size:12px;color:var(--text2)">${list.length} fields</p>`;
  resultsDiv.innerHTML = html;
}

window.locateItem = async function(id, kind) {
  try {
    const raw = kind === 'dataset'
      ? await mcpCall('locate_dataset', { dataset_id: id })
      : await mcpCall('locate_field', { field_id: id });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = result.data || result;

    const detailDiv = document.getElementById('data-detail');
    detailDiv.innerHTML = `
      <div class="detail-panel">
        <h3 style="margin-bottom:12px">${kind === 'dataset' ? '📦' : '🔤'} ${id}</h3>
        ${Object.entries(data).filter(([k]) => !k.startsWith('_')).map(([k, v]) => {
          const val = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
          return `<dt>${k}</dt><dd class="expr-preview">${val.substring(0, 200)}</dd>`;
        }).join('')}
        <button class="btn btn-sm" onclick="document.getElementById('data-detail').innerHTML=''" style="margin-top:8px">✕ Close</button>
      </div>`;
  } catch (e) {
    toast('Detail error: ' + e.message, 'error');
  }
};

window.addSelected = function(item) {
  if (!dataState.selected) dataState.selected = [];
  if (dataState.selected.some(s => s.id === item.id)) {
    toast('Already selected', 'info');
    return;
  }
  dataState.selected.push(item);
  renderSelected();
  // Re-render current results to update +/- buttons
  if (dataState.mode === 'datasets') renderDatasets();
  else renderFields();
  toast(`Added ${item.id}`, 'success');
};

window.removeSelected = function(id) {
  dataState.selected = dataState.selected.filter(s => s.id !== id);
  renderSelected();
  if (dataState.mode === 'datasets') renderDatasets();
  else renderFields();
};

window.clearSelected = function() {
  dataState.selected = [];
  renderSelected();
  if (dataState.mode === 'datasets') renderDatasets();
  else renderFields();
};

function renderSelected() {
  const list = document.getElementById('selected-list');
  const count = document.getElementById('selected-count');
  if (!list) return;
  if (count) count.textContent = `(${dataState.selected.length})`;

  if (!dataState.selected.length) {
    list.innerHTML = '<span style="color:var(--text2);font-size:13px">Click + to add items from search results</span>';
    return;
  }

  list.innerHTML = dataState.selected.map(item =>
    `<span class="item" onclick="removeSelected('${item.id}')" title="Click to remove">
      ${item.type === 'dataset' ? '📦' : '🔤'} ${item.name || item.id} <span class="remove">✕</span>
    </span>`
  ).join('');
}

window.copySelectedAsJson = function() {
  if (!dataState.selected.length) { toast('Nothing selected', 'info'); return; }
  const text = JSON.stringify(dataState.selected, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    toast('Copied JSON to clipboard', 'success');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Copied JSON to clipboard', 'success');
  });
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  const tc = document.createElement('div');
  tc.id = 'toast-container';
  tc.className = 'toast-container';
  document.body.appendChild(tc);

  try {
    const { tools } = await mcpConnect();
    state.tools = tools;
    document.getElementById('status-dot').className = 'status-dot connected';
    document.getElementById('status-text').textContent = `MCP ✓ (${Object.keys(tools).length} tools)`;
    toast('MCP connected', 'success');
  } catch (e) {
    console.warn('MCP init failed:', e);
    document.getElementById('status-dot').className = 'status-dot';
    document.getElementById('status-text').textContent = 'MCP init failed';
    toast('MCP connection failed: ' + e.message, 'error');
  }

  switchTab('dashboard');
});
