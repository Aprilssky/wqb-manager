/* WQB Manager — JavaScript */

// ── API Config ──
const API = (() => {
  // Try to get API URL from config, fallback to same origin or ty server
  const stored = localStorage.getItem('wqb_api_url');
  if (stored) return stored;
  // Default: same origin (when served from ty server)
  return window.location.origin;
})();

async function api(path, opts = {}) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).detail || res.statusText; } catch { msg = res.statusText; }
    throw new Error(msg);
  }
  return res.json();
}

// ── State ──
const state = {
  status: null,
  templates: [],
  alphas: { results: [], count: 0 },
  operators: {},
  currentTab: 'dashboard',
};

// ── Toast ──
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
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
  
  // Load data when switching
  if (name === 'dashboard') loadDashboard();
  if (name === 'templates') loadTemplates();
  if (name === 'alphas') loadAlphas();
  if (name === 'generate') loadGenerate();
}

// ── Dashboard ──
async function loadDashboard() {
  const el = document.getElementById('dashboard-content');
  el.innerHTML = '<div class="loader" style="margin:40px auto"></div>';
  try {
    const status = await api('/api/status');
    state.status = status;
    document.getElementById('status-dot').className = `status-dot ${status.connected ? 'connected' : ''}`;
    document.getElementById('status-text').textContent = status.connected
      ? `${status.user_id} (${status.user_email})`
      : 'Disconnected';
    
    // Stats
    let alphaCount = 0, opCount = 0;
    try {
      const alphas = await api('/api/alphas?limit=5');
      alphaCount = alphas.count || 0;
    } catch {}
    try {
      const ops = await api('/api/operators');
      state.operators = ops;
      opCount = Object.values(ops).flat().length;
    } catch {}

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-box">
          <div class="num">${status.connected ? '✅' : '❌'}</div>
          <div class="label">WQB Connected</div>
        </div>
        <div class="stat-box">
          <div class="num">${alphaCount.toLocaleString()}</div>
          <div class="label">Alphas</div>
        </div>
        <div class="stat-box">
          <div class="num">${opCount}</div>
          <div class="label">Operators</div>
        </div>
        <div class="stat-box">
          <div class="num">${(state.templates.length || 0)}</div>
          <div class="label">Templates</div>
        </div>
      </div>
      <div class="card">
        <h3>Connection Info</h3>
        <table>
          <tr><td style="width:120px">User ID</td><td>${status.user_id || '-'}</td></tr>
          <tr><td>Email</td><td>${status.user_email || USERNAME || '-'}</td></tr>
          <tr><td>Status</td><td><span class="tag ${status.connected ? 'tag-green' : 'tag-red'}">${status.connected ? 'Connected' : 'Disconnected'}</span></td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Quick Actions</h3>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="switchTab('templates')">Manage Templates</button>
          <button class="btn btn-primary" onclick="switchTab('alphas')">View Alphas</button>
          <button class="btn btn-primary" onclick="switchTab('generate')">Generate New Alpha</button>
        </div>
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>Failed to connect: ${e.message}</p></div>`;
  }
}

// ── Templates ──
async function loadTemplates() {
  const el = document.getElementById('templates-content');
  el.innerHTML = '<div class="loader" style="margin:40px auto"></div>';
  try {
    state.templates = await api('/api/templates');
    renderTemplates();
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${e.message}</p></div>`;
  }
}

function renderTemplates() {
  const el = document.getElementById('templates-content');
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
  html += '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th>Variables</th><th>Actions</th></tr></thead><tbody>';
  state.templates.forEach((t, i) => {
    const vars = t.templateConfigurations ? Object.keys(t.templateConfigurations).length : 0;
    html += `<tr>
      <td><strong>${t.name || 'Unnamed'}</strong></td>
      <td class="expr-preview">${(t.description || t.expression || '').substring(0, 100)}</td>
      <td>${vars} vars</td>
      <td>
        <button class="btn btn-sm" onclick="showTemplateEditor(${i})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteTemplate(${i})">Delete</button>
        <button class="btn btn-sm btn-primary" onclick="generateFromTemplate(${i})">Generate</button>
      </td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function showTemplateEditor(index) {
  const modal = document.getElementById('modal');
  const isNew = index < 0;
  const t = isNew ? { name: '', description: '', expression: '', templateConfigurations: {} } : state.templates[index];
  
  let varsHtml = '';
  if (t.templateConfigurations) {
    varsHtml = Object.entries(t.templateConfigurations).map(([key, conf]) => {
      const vars = (conf.variables || []).join('\n');
      return `<div class="variable-group">
        <label>Variable: <strong>${key}</strong></label>
        <select style="margin-bottom:4px" onchange="updateVarType('${key}', this.value)">
          <option value="data" ${conf.configType === 'data' ? 'selected' : ''}>Data Field</option>
          <option value="operator" ${conf.configType === 'operator' ? 'selected' : ''}>Operator</option>
          <option value="normal" ${conf.configType === 'normal' ? 'selected' : ''}>Normal Value</option>
        </select>
        <textarea id="var-${key}" rows="4" placeholder="One value per line">${vars}</textarea>
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
    </div>
  `;
  modal.classList.add('show');
}

window.addVar = function() {
  const name = prompt('Variable name (e.g. field, operator, window):');
  if (!name) return;
  const container = document.getElementById('vars-container');
  if (document.getElementById(`var-${name}`)) { toast('Variable already exists', 'error'); return; }
  const div = document.createElement('div');
  div.className = 'variable-group';
  div.innerHTML = `
    <label>Variable: <strong>${name}</strong></label>
    <select style="margin-bottom:4px">
      <option value="data">Data Field</option>
      <option value="operator">Operator</option>
      <option value="normal" selected>Normal Value</option>
    </select>
    <textarea id="var-${name}" rows="4" placeholder="One value per line"></textarea>
    <button class="btn btn-sm btn-danger" onclick="removeVar('${name}')" style="margin-top:4px">Remove</button>
  `;
  container.appendChild(div);
};

window.removeVar = function(name) {
  document.querySelectorAll('.variable-group').forEach(el => {
    if (el.querySelector(`#var-${name}`)) el.remove();
  });
};

window.updateVarType = function(name, type) {
  // stored in the select
};

window.saveTemplate = async function(index) {
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
  
  try {
    if (index < 0) {
      await api('/api/templates', { method: 'POST', body: JSON.stringify(template) });
      toast('Template created', 'success');
    } else {
      await api(`/api/templates/${index}`, { method: 'PUT', body: JSON.stringify(template) });
      toast('Template updated', 'success');
    }
    closeModal();
    loadTemplates();
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.deleteTemplate = async function(index) {
  if (!confirm('Delete this template?')) return;
  try {
    await api(`/api/templates/${index}`, { method: 'DELETE' });
    toast('Template deleted', 'success');
    loadTemplates();
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.generateFromTemplate = function(index) {
  switchTab('generate');
  setTimeout(() => {
    document.getElementById('gen-template').value = index;
    loadGenerate();
  }, 100);
};

function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

window.closeModal = closeModal;

// ── Generate ──
async function loadGenerate() {
  const el = document.getElementById('generate-content');
  
  // Load templates for dropdown
  let templates = state.templates;
  if (!templates.length) {
    try { templates = await api('/api/templates'); state.templates = templates; } catch {}
  }
  
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
  
  if (selectedIdx !== '') {
    updateGenerateForm();
  }
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
    varsHtml = Object.entries(t.templateConfigurations).map(([key, conf]) => {
      const vars = (conf.variables || []).join(', ');
      return `<span class="tag tag-blue" style="margin:2px">&lt;${key}/&gt; (${(conf.variables || []).length} vals)</span>`;
    }).join(' ');
  }
  
  detail.innerHTML = `
    <p style="margin:8px 0"><strong>${t.name}</strong> — ${t.description || ''}</p>
    <div class="code-block">${t.expression || ''}</div>
    <div style="margin:8px 0">${varsHtml}</div>
  `;
  
  const params = document.getElementById('gen-params');
  params.innerHTML = `
    <div class="form-row">
      <div><label>Region</label><select id="gen-region">
        <option value="USA">USA</option>
        <option value="CHN">CHN</option>
        <option value="EUR">EUR</option>
        <option value="JPN">JPN</option>
      </select></div>
      <div><label>Delay</label><select id="gen-delay">
        <option value="0">0</option>
        <option value="1" selected>1</option>
      </select></div>
      <div><label>Universe</label><select id="gen-universe">
        <option value="TOP3000">TOP3000</option>
        <option value="TOP1000">TOP1000</option>
        <option value="TOP500">TOP500</option>
      </select></div>
      <div><label>Max Samples</label><input id="gen-max" type="number" value="50" min="1" max="500" /></div>
    </div>
    <button class="btn btn-primary" onclick="previewGenerate()">Preview Generated Alphas</button>
  `;
};

window.previewGenerate = async function() {
  const sel = document.getElementById('gen-template-select');
  const idx = parseInt(sel.value);
  if (isNaN(idx)) return;
  const t = state.templates[idx];
  
  const data = {
    expression: t.expression,
    configurations: t.templateConfigurations,
    region: document.getElementById('gen-region').value,
    delay: parseInt(document.getElementById('gen-delay').value),
    universe: document.getElementById('gen-universe').value,
    max_samples: parseInt(document.getElementById('gen-max').value) || 50,
  };
  
  try {
    const result = await api('/api/templates/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    
    const preview = document.getElementById('gen-preview');
    if (!result.alphas || !result.alphas.length) {
      preview.innerHTML = '<p style="color:var(--text2)">No alphas generated</p>';
      return;
    }
    
    const alphas = result.alphas;
    preview.innerHTML = `
      <p><strong>${alphas.length}</strong> alphas generated</p>
      <div class="table-wrap" style="max-height:300px;overflow-y:auto">
      <table>
        <thead><tr><th>#</th><th>Expression</th><th>Actions</th></tr></thead>
        <tbody>
          ${alphas.map((a, i) => `<tr>
            <td>${i+1}</td>
            <td><span class="expr-preview">${a.expression}</span></td>
            <td><button class="btn btn-sm" onclick="simulateSingle('${a.expression.replace(/'/g, "\\'")}')">Simulate</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <div class="btn-group" style="margin-top:8px">
        <button class="btn btn-primary" onclick="batchSimulateGenerated()">🚀 Batch Simulate All</button>
        <button class="btn" onclick="exportAlphas()">📥 Export JSON</button>
      </div>
    `;
    
    // Store generated alphas for batch ops
    window._generatedAlphas = alphas;
  } catch (e) {
    toast(e.message, 'error');
  }
};

window.simulateSingle = async function(expr) {
  try {
    toast('Simulating...', 'info');
    const result = await api('/api/alphas/simulate', {
      method: 'POST',
      body: JSON.stringify({
        expression: expr,
        region: document.getElementById('gen-region').value,
        delay: parseInt(document.getElementById('gen-delay').value),
        universe: document.getElementById('gen-universe').value,
      }),
    });
    const isData = result.is || {};
    const sharpe = isData.sharpe || 'N/A';
    const fitness = isData.fitness || 'N/A';
    const status = result.status || 'done';
    toast(`Sharpe: ${sharpe}, Fitness: ${fitness}`, status === 'ERROR' ? 'error' : 'success');
  } catch (e) {
    toast('Simulation error: ' + e.message, 'error');
  }
};

window.batchSimulateGenerated = async function() {
  const alphas = window._generatedAlphas;
  if (!alphas || !alphas.length) { toast('No alphas to simulate', 'error'); return; }
  
  try {
    toast(`Starting batch simulation of ${alphas.length} alphas...`, 'info');
    const result = await api('/api/alphas/batch-simulate', {
      method: 'POST',
      body: JSON.stringify({
        expressions: alphas,
        region: document.getElementById('gen-region').value,
        delay: parseInt(document.getElementById('gen-delay').value),
        universe: document.getElementById('gen-universe').value,
        concurrency: 5,
      }),
    });
    
    const results = result.results || [];
    const good = results.filter(r => {
      const isData = r.is || {};
      return isData.sharpe && parseFloat(isData.sharpe) > 1.5;
    });
    
    toast(`Done! ${results.length} results, ${good.length} with Sharpe > 1.5`, 'success');
    
    // Show results
    const preview = document.getElementById('gen-preview');
    const tableRows = results.map((r, i) => {
      const isData = r.is || {};
      const sharpe = isData.sharpe || '-';
      const fitness = isData.fitness || '-';
      const status = r.status || '?';
      const expr = (r.regular && r.regular.code) || alphas[i]?.expression || '?';
      const sharpeVal = parseFloat(sharpe);
      const highlight = !isNaN(sharpeVal) && sharpeVal > 1.5 ? 'style="background:rgba(63,185,80,0.1)"' : '';
      return `<tr ${highlight}>
        <td>${i+1}</td>
        <td><span class="expr-preview">${expr.substring(0, 80)}</span></td>
        <td>${status}</td>
        <td>${sharpe}</td>
        <td>${fitness}</td>
      </tr>`;
    }).join('');
    
    preview.innerHTML += `
      <div class="card" style="margin-top:12px">
        <h3>Batch Results</h3>
        <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat-box"><div class="num">${results.length}</div><div class="label">Total</div></div>
          <div class="stat-box"><div class="num">${good.length}</div><div class="label" style="color:var(--green)">Sharpe > 1.5</div></div>
        </div>
        <div class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table><thead><tr><th>#</th><th>Expression</th><th>Status</th><th>Sharpe</th><th>Fitness</th></tr></thead>
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
async function loadAlphas() {
  const el = document.getElementById('alphas-content');
  el.innerHTML = '<div class="loader" style="margin:40px auto"></div>';
  try {
    const status = document.getElementById('alpha-status')?.value || '';
    const search = document.getElementById('alpha-search')?.value || '';
    const region = document.getElementById('alpha-region')?.value || 'USA';
    
    let url = `/api/alphas?limit=50&region=${region}`;
    if (status) url += `&status=${status}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    
    state.alphas = await api(url);
    renderAlphas();
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p>Error: ${e.message}</p></div>`;
  }
}

function renderAlphas() {
  const el = document.getElementById('alphas-content');
  const results = state.alphas.results || [];
  
  let html = `
  <div class="filter-bar">
    <input id="alpha-search" placeholder="Search..." onchange="loadAlphas()" />
    <select id="alpha-region" onchange="loadAlphas()">
      <option value="USA">USA</option>
      <option value="CHN">CHN</option>
      <option value="EUR">EUR</option>
      <option value="JPN">JPN</option>
    </select>
    <select id="alpha-status" onchange="loadAlphas()">
      <option value="">All Status</option>
      <option value="ACTIVE">ACTIVE</option>
      <option value="SUBMITTED">SUBMITTED</option>
      <option value="UNSUBMITTED">UNSUBMITTED</option>
      <option value="SIMULATING">SIMULATING</option>
    </select>
    <button class="btn btn-primary btn-sm" onclick="loadAlphas()">Refresh</button>
    <span style="color:var(--text2);font-size:13px;margin-left:auto">Total: ${state.alphas.count || results.length}</span>
  </div>`;
  
  if (!results.length) {
    html += '<div class="empty-state"><div class="icon">📊</div><p>No alphas found</p></div>';
    el.innerHTML = html;
    return;
  }
  
  html += '<div class="table-wrap" style="max-height:500px;overflow-y:auto"><table><thead><tr>' +
    '<th>ID</th><th>Expression</th><th>Status</th><th>Sharpe</th><th>Fitness</th><th>Returns</th><th>Modified</th></tr></thead><tbody>';
  
  results.forEach(a => {
    const isData = a.is || {};
    const sharpe = isData.sharpe;
    const fitness = isData.fitness;
    const returns = isData.returns;
    const sharpeHighlight = sharpe && parseFloat(sharpe) > 1.5 ? 'style="color:var(--green);font-weight:600"' : '';
    const statusTag = a.status === 'ACTIVE' ? 'tag-green' : a.status === 'SUBMITTED' ? 'tag-blue' : a.status === 'SIMULATING' ? 'tag-yellow' : '';
    
    html += `<tr>
      <td><span class="expr-preview" title="${a.id}">${a.id}</span></td>
      <td><span class="expr-preview">${(a.regular && a.regular.code) || ''}</span></td>
      <td><span class="tag ${statusTag}">${a.status || '?'}</span></td>
      <td ${sharpeHighlight}>${sharpe !== undefined ? sharpe : '-'}</td>
      <td>${fitness !== undefined ? fitness : '-'}</td>
      <td>${returns !== undefined ? returns : '-'}</td>
      <td style="font-size:11px;color:var(--text2)">${(a.dateModified || '').substring(0, 16)}</td>
    </tr>`;
  });
  
  html += '</tbody></table></div>';
  html += `
  <div class="card" style="margin-top:12px">
    <h3>Single Alpha Simulator</h3>
    <label>Expression</label>
    <textarea id="sim-expr" rows="3" placeholder="e.g. group(rank(close), sector)"></textarea>
    <div class="form-row">
      <div><label>Region</label><select id="sim-region">
        <option value="USA">USA</option>
        <option value="CHN">CHN</option>
        <option value="EUR">EUR</option>
        <option value="JPN">JPN</option>
      </select></div>
      <div><label>Delay</label><select id="sim-delay"><option value="0">0</option><option value="1" selected>1</option></select></div>
      <div><label>Universe</label><select id="sim-universe"><option value="TOP3000">TOP3000</option><option value="TOP1000">TOP1000</option>
        <option value="TOP500">TOP500</option></select></div>
    </div>
    <button class="btn btn-primary" onclick="simulateAlpha()">Simulate</button>
    <div id="sim-result" style="margin-top:8px"></div>
  </div>`;
  
  el.innerHTML = html;
}

window.simulateAlpha = async function() {
  const expr = document.getElementById('sim-expr').value.trim();
  if (!expr) { toast('Enter an expression', 'error'); return; }
  
  const resultDiv = document.getElementById('sim-result');
  resultDiv.innerHTML = '<div class="loader"></div>';
  
  try {
    const result = await api('/api/alphas/simulate', {
      method: 'POST',
      body: JSON.stringify({
        expression: expr,
        region: document.getElementById('sim-region').value,
        delay: parseInt(document.getElementById('sim-delay').value),
        universe: document.getElementById('sim-universe').value,
      }),
    });
    
    if (result.status === 'ERROR') {
      resultDiv.innerHTML = `<div class="tag tag-red">Error: ${result.message || 'Unknown error'}</div>`;
      return;
    }
    
    const isData = result.is || {};
    resultDiv.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat-box"><div class="num">${isData.sharpe ?? '-'}</div><div class="label">Sharpe</div></div>
        <div class="stat-box"><div class="num">${isData.fitness ?? '-'}</div><div class="label">Fitness</div></div>
        <div class="stat-box"><div class="num">${isData.returns ?? '-'}</div><div class="label">Returns</div></div>
        <div class="stat-box"><div class="num">${isData.drawdown ?? '-'}</div><div class="label">Drawdown</div></div>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-box"><div class="num">${isData.turnover ?? '-'}</div><div class="label">Turnover</div></div>
        <div class="stat-box"><div class="num">${result.status || '-'}</div><div class="label">Status</div></div>
      </div>
      <div class="btn-group">
        <button class="btn btn-sm btn-primary" onclick="submitAlpha('${expr.replace(/'/g, "\\'")}')">Submit Alpha</button>
      </div>
    `;
    
    if (isData.sharpe && parseFloat(isData.sharpe) > 1.5) {
      toast(`Sharpe: ${isData.sharpe} 🎯`, 'success');
    }
  } catch (e) {
    resultDiv.innerHTML = `<div class="tag tag-red">Error: ${e.message}</div>`;
  }
};

window.submitAlpha = async function(expr) {
  try {
    const result = await api('/api/alphas/submit', {
      method: 'POST',
      body: JSON.stringify({
        expression: expr,
        region: document.getElementById('sim-region').value,
        delay: parseInt(document.getElementById('sim-delay').value),
        universe: document.getElementById('sim-universe').value,
      }),
    });
    toast('Alpha submitted!', 'success');
  } catch (e) {
    toast('Submit error: ' + e.message, 'error');
  }
};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  // Create toast container
  const tc = document.createElement('div');
  tc.id = 'toast-container';
  tc.className = 'toast-container';
  document.body.appendChild(tc);
  
  // Load dashboard
  switchTab('dashboard');
});
