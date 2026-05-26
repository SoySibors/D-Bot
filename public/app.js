const socket = io();

let currentStatus = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
let localGroups = [];
let localSettings = { messages: ['yo'] };
let localHistorial = [];

let activeTab = 'groups';
let editingGroupId = null;
let modalNumbers = [];
let activeRadarGroupId = null;

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-section').forEach(sec => sec.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.getElementById(`navBtn-${tabId}`).classList.add('active');

  if (tabId === 'groups') renderGroups(localGroups);
  if (tabId === 'history') renderHistorial();
  if (tabId === 'panel') renderTags();
}

// ── MANEJO DE SOCKETS ──────────────────────────────────────────────
socket.on('status', (status) => { currentStatus = status; updateStatusUI(); });
socket.on('groups', (groups) => {
  localGroups = groups;
  if (activeTab === 'groups') renderGroups(localGroups);
  if (editingGroupId) {
    const updated = groups.find(g => g.id === editingGroupId);
    if (updated) { modalNumbers = updated.numbers || []; renderModalNumbers(); }
  }
});
socket.on('settings', (settings) => {
  localSettings = settings;
  if (activeTab === 'panel') renderTags();
});
socket.on('historial', (history) => {
  localHistorial = history;
  if (activeTab === 'history') renderHistorial();
});

socket.on('nuevo-descubierto', (data) => {
  if (activeRadarGroupId && activeRadarGroupId === data.groupId) loadRadarList(data.groupId);
});

socket.on('pedido-tomado', (pedido) => {
  showToast(`🚀 ¡Gatillo enviado a: ${pedido.businessName}!`);
  // Lanzar notificación sonora y visual nativa si hay permiso
  if (Notification.permission === 'granted') {
    new Notification('🛵 Proyecto D-Bot', {
      body: `Disparado en ${pedido.groupName} para ${pedido.businessName}. ¡Confirma si lo ganaste!`,
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛵</text></svg>'
    });
  }
});

function updateStatusUI() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const stepPhone = document.getElementById('phoneInputStep');
  const stepCode = document.getElementById('codeDisplayStep');

  dot.className = 'dot';
  if (currentStatus.connected) {
    dot.classList.add('online'); txt.innerText = 'Conectado';
    stepPhone.classList.add('hidden'); stepCode.classList.add('hidden');
  } else if (currentStatus.whatsappStatus === 'pairing_ready') {
    dot.classList.add('pairing'); txt.innerText = 'Esperando Código';
  } else {
    dot.classList.add('offline'); txt.innerText = 'Desconectado';
  }

  if (currentStatus.needsPairing && !currentStatus.connected && currentStatus.whatsappStatus !== 'pairing_ready') {
    stepPhone.classList.remove('hidden'); stepCode.classList.add('hidden');
  }
}

async function requestWaCode() {
  const phone = document.getElementById('waPhoneNumber').value.trim();
  if (!phone) return showToast('Introduce tu número.');
  const btn = document.getElementById('btnRequestCode');
  btn.innerText = 'Generando...'; btn.disabled = true;
  try {
    const res = await fetch('/api/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('phoneInputStep').classList.add('hidden');
    document.getElementById('codeDisplayStep').classList.remove('hidden');
    document.getElementById('pairingCodeDisplay').innerText = data.code;
  } catch (e) { showToast(e.message); btn.innerText = 'Generando código'; btn.disabled = false; }
}

// ── RENDERIZADO DE HISTORIAL Y MÉTRICAS ─────────────────────────────
function renderHistorial() {
  const container = document.getElementById('historyList');
  container.innerHTML = '';

  let wonCount = 0;
  let lostCount = 0;

  localHistorial.forEach(p => {
    if (p.status === 'won') wonCount++;
    if (p.status === 'lost') lostCount++;

    const item = document.createElement('div');
    item.className = `history-card ${p.status}`;
    
    const timeStr = new Date(p.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let actionButtons = '';
    if (p.status === 'pending') {
      actionButtons = `
        <div class="history-decision">
          <p>¿Ganaste este pedido?</p>
          <div class="decision-btns">
            <button class="btn-yes" onclick="resolvePedido('${p.id}', 'won')">SÍ</button>
            <button class="btn-no" onclick="resolvePedido('${p.id}', 'lost')">NO</button>
          </div>
        </div>
      `;
    } else {
      const statusText = p.status === 'won' ? '🏆 PEDIDO GANADO' : '❌ PERDIDO';
      actionButtons = `<div class="final-status-badge ${p.status}">${statusText}</div>`;
    }

    item.innerHTML = `
      <div class="history-main-info">
        <div class="hist-meta">
          <span class="hist-time">${timeStr}</span>
          <span class="hist-group">${p.groupName}</span>
        </div>
        <h3>${p.businessName}</h3>
        <p class="hist-phrase">Gatillo: "<em>${p.phraseUsed}</em>"</p>
      </div>
      ${actionButtons}
    `;
    container.appendChild(item);
  });

  document.getElementById('countWon').innerText = wonCount;
  document.getElementById('countLost').innerText = lostCount;

  if (localHistorial.length === 0) {
    container.innerHTML = '<div class="empty-state">El historial está limpio.<br>Los disparos en la calle aparecerán aquí.</div>';
  }
}

async function resolvePedido(id, status) {
  try {
    await fetch(`/api/historial/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    // El servidor emitirá el cambio y actualizará la lista sola
  } catch (e) { showToast('Error al registrar decisión.'); }
}

// ── RENDERIZADO DE GRUPOS ───────────────────────────────────────────
function renderGroups(groups) {
  const container = document.getElementById('groupsList'); container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = `<div class="empty-state">No tienes grupos configurados.<br>Toca el botón de abajo para agregar uno.</div>`; return;
  }
  groups.forEach(g => {
    const activeCount = g.numbers.filter(n => n.active !== false).length;
    const card = document.createElement('div');
    card.className = `group-card ${g.active ? 'hunting' : ''}`;
    card.innerHTML = `
      <div class="group-card-header">
        <div onclick="openModal('${g.id}')" style="flex:1; cursor:pointer;">
          <h3>${g.groupName}</h3>
          <p class="subtitle">${activeCount} de ${g.numbers.length} negocios activos</p>
        </div>
        <label class="ios-switch">
          <input type="checkbox" ${g.active ? 'checked' : ''} onchange="toggleGroupHunting('${g.id}', this.checked)">
          <span class="ios-slider"></span>
        </label>
      </div>
      <div class="group-card-actions">
        <button class="btn-radar-action" onclick="openRadar('${g.groupId}', '${g.groupName}')">📡 Abrir Radar del Grupo</button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function toggleGroupHunting(id, isChecked) {
  try { await fetch(`/api/groups/${id}/${isChecked ? 'activate' : 'deactivate'}`, { method: 'POST' }); } catch (e) { renderGroups(localGroups); }
}

// ── RADAR PERSISTENTE POR GRUPO ──────────────────────────────────────
async function openRadar(waGroupId, groupName) {
  activeRadarGroupId = waGroupId;
  document.getElementById('radarTitle').innerText = `📡 Radar: ${groupName}`;
  document.getElementById('radarModal').classList.remove('hidden');
  loadRadarList(waGroupId);
}
function closeRadar() { document.getElementById('radarModal').classList.add('hidden'); activeRadarGroupId = null; }
function closeRadarOutside(e) { if (e.target.id === 'radarModal') closeRadar(); }
async function loadRadarList(waGroupId) {
  const listCont = document.getElementById('radarList');
  try {
    const res = await fetch(`/api/groups/${waGroupId}/discovered`); const data = await res.json();
    listCont.innerHTML = '';
    if (data.length === 0) {
      listCont.innerHTML = '<p class="hint" style="text-align:center; padding: 20px 0;">Esperando códigos de stickers en este grupo...</p>'; return;
    }
    data.forEach(item => {
      const timeStr = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const row = document.createElement('div'); row.className = 'radar-row';
      row.innerHTML = `
        <div class="radar-info">
          <span class="radar-time">${timeStr}</span><span class="radar-name">${item.name}</span><span class="radar-id">ID: ${item.lid}</span>
        </div>
        <button class="btn-radar-add" onclick="addFromRadar('${waGroupId}', '${item.lid}', '${item.name}')">+ Add</button>
      `;
      listCont.appendChild(row);
    });
  } catch (e) { listCont.innerHTML = '<p class="hint">Error cargando el radar.</p>'; }
}
async function addFromRadar(waGroupId, lid, name) {
  const group = localGroups.find(g => g.groupId === waGroupId); if (!group) return;
  if (group.numbers.some(n => n.number === lid)) return showToast('Este negocio ya existe.');
  const updatedNumbers = [...group.numbers, { number: lid, name: name, active: true }];
  try {
    await fetch(`/api/groups/${group.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: updatedNumbers })
    });
    showToast(`✅ Agregado: ${name}`);
  } catch (e) { }
}

// ── RESPUESTAS ROTATIVAS GLOBALES (TAGS) ──────────────────────────────
function renderTags() {
  const cont = document.getElementById('tagsContainer'); cont.innerHTML = '';
  const msgs = localSettings.messages || ['yo'];
  msgs.forEach((msg, idx) => {
    const tag = document.createElement('div'); tag.className = 'msg-tag';
    tag.innerHTML = `<span>${msg}</span><button onclick="removeMsgTag(${idx})">✕</button>`;
    cont.appendChild(tag);
  });
}
async function addNewMsgTag() {
  const input = document.getElementById('newTagInput'); const value = input.value.trim(); if (!value) return;
  const currentMsgs = [...(localSettings.messages || [])]; if (currentMsgs.includes(value)) return;
  currentMsgs.push(value); await saveGlobalSettings(currentMsgs); input.value = '';
}
async function removeMsgTag(index) {
  const currentMsgs = [...(localSettings.messages || [])]; currentMsgs.splice(index, 1); await saveGlobalSettings(currentMsgs);
}
async function saveGlobalSettings(messagesArray) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: messagesArray })
    });
    localSettings = await res.json(); renderTags();
  } catch (e) { }
}

// ── MODAL GRUPOS (CREAR / EDITAR) ────────────────────────────────────
async function openModal(id = null) {
  editingGroupId = id; modalNumbers = [];
  document.getElementById('groupSelect').innerHTML = '<option value="">— Selecciona —</option>';
  document.getElementById('numberNameInput').value = ''; document.getElementById('numberInput').value = '';
  if (id) {
    document.getElementById('modalTitle').innerText = 'Editar grupo'; document.getElementById('btnDelete').classList.remove('hidden');
    const g = localGroups.find(group => group.id === id);
    if (g) {
      const opt = document.createElement('option'); opt.value = g.groupId; opt.innerText = g.groupName; opt.selected = true;
      document.getElementById('groupSelect').appendChild(opt); modalNumbers = g.numbers || [];
    }
  } else {
    document.getElementById('modalTitle').innerText = 'Nuevo grupo'; document.getElementById('btnDelete').classList.add('hidden');
    await loadWAGroups();
  }
  renderModalNumbers(); document.getElementById('groupModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('groupModal').classList.add('hidden'); editingGroupId = null; }
function closeModalOutside(e) { if (e.target.id === 'groupModal') closeModal(); }
async function loadWAGroups() {
  const select = document.getElementById('groupSelect'); select.innerHTML = '<option value="">Cargando chats...</option>';
  try {
    const res = await fetch('/api/wa-groups'); const list = await res.json();
    select.innerHTML = '<option value="">— Selecciona —</option>';
    list.forEach(c => { const opt = document.createElement('option'); opt.value = c.id; opt.innerText = c.name; select.appendChild(opt); });
  } catch (e) { select.innerHTML = '<option value="">❌ Conecta WhatsApp primero</option>'; }
}
function renderModalNumbers() {
  const ul = document.getElementById('numberList'); ul.innerHTML = '';
  modalNumbers.forEach((n, idx) => {
    const isActive = n.active !== false; const li = document.createElement('li'); li.className = `tag-item ${isActive ? '' : 'disabled'}`;
    li.innerHTML = `
      <div class="tag-click-zone" onclick="toggleNumberActive(${idx})">
        <span class="status-indicator"></span><strong>${n.name || 'Negocio'}</strong><small>${n.number}</small>
      </div><button class="tag-remove" onclick="removeNumber(${idx})">✕</button>
    `; ul.appendChild(li);
  });
}
function addNumber() {
  const numInput = document.getElementById('numberInput'); const nameInput = document.getElementById('numberNameInput');
  const number = numInput.value.trim(); const name = nameInput.value.trim() || 'Negocio'; if (!number) return;
  if (modalNumbers.some(n => n.number === number)) return;
  modalNumbers.push({ number, name, active: true }); numInput.value = ''; nameInput.value = ''; renderModalNumbers();
  if (editingGroupId) syncModalNumbersToBackend();
}
function removeNumber(idx) { modalNumbers.splice(idx, 1); renderModalNumbers(); if (editingGroupId) syncModalNumbersToBackend(); }
function toggleNumberActive(idx) { modalNumbers[idx].active = !modalNumbers[idx].active; renderModalNumbers(); if (editingGroupId) syncModalNumbersToBackend(); }
function toggleAllModal(value) { modalNumbers.forEach(n => n.active = value); renderModalNumbers(); if (editingGroupId) syncModalNumbersToBackend(); }
async function syncModalNumbersToBackend() {
  if (!editingGroupId) return;
  try { await fetch(`/api/groups/${editingGroupId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: modalNumbers }) }); } catch (e) { }
}
async function saveGroup() {
  const select = document.getElementById('groupSelect'); const groupId = select.value; const groupName = select.options[select.selectedIndex]?.text;
  if (!groupId) return showToast('Selecciona un grupo.');
  const payload = { groupId, groupName, numbers: modalNumbers };
  const method = editingGroupId ? 'PUT' : 'POST'; const url = editingGroupId ? `/api/groups/${editingGroupId}` : '/api/groups';
  try { await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); closeModal(); } catch (e) { }
}
async function deleteGroup() {
  if (!editingGroupId || !confirm('¿Eliminar grupo?')) return;
  try { await fetch(`/api/groups/${editingGroupId}`, { method: 'DELETE' }); closeModal(); } catch (e) { }
}

// ── NOTIFICACIONES Y LOGOUT ──────────────────────────────────────────
function confirmLogout() {
  if (!confirm('¿Cerrar sesión de WhatsApp del servidor?')) return;
  fetch('/api/logout', { method: 'POST' }).then(() => location.reload());
}

function showToast(msg) {
  const t = document.getElementById('toast'); t.innerText = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function requestNotifPermission() {
  Notification.requestPermission().then(perm => {
    if (perm === 'granted') {
      showToast('🔔 ¡Canal de notificaciones activo!');
      document.getElementById('btnNotif').classList.add('hidden');
      document.getElementById('txtNotifOk').classList.remove('hidden');
    } else { showToast('Permiso de notificaciones denegado.'); }
  });
}

// Revisión inicial de permisos de alertas al cargar la app
if (Notification.permission === 'granted') {
  setTimeout(() => {
    if(document.getElementById('btnNotif')) document.getElementById('btnNotif').classList.add('hidden');
    if(document.getElementById('txtNotifOk')) document.getElementById('txtNotifOk').classList.remove('hidden');
  }, 500);
}

// Carga inicial de datos de historial
fetch('/api/historial').then(res => res.json()).then(data => { localHistorial = data; renderHistorial(); });