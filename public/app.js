const socket = io();

let currentStatus = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
let localGroups = [];
let localSettings = { messages: ['yo'] };

let activeTab = 'groups';
let editingGroupId = null;
let modalNumbers = [];
let activeRadarGroupId = null;

// ==========================================
// 🧭 NAVEGACIÓN Y CAMBIO DE PESTAÑAS (UX)
// ==========================================
function switchTab(tabId) {
  activeTab = tabId;
  
  // Ocultar todas las secciones
  document.querySelectorAll('.tab-section').forEach(sec => sec.classList.add('hidden'));
  // Desactivar todos los botones de la barra inferior
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  
  // Mostrar la sección seleccionada y activar su botón
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  document.getElementById(`navBtn-${tabId}`).classList.add('active');

  if (tabId === 'groups') {
    renderGroups(localGroups);
  } else if (tabId === 'settings') {
    renderTags();
  }
}

// ==========================================
// 📡 MANEJO DE SOCKETS (TIEMPO REAL)
// ==========================================
socket.on('status', (status) => {
  currentStatus = status;
  updateStatusUI();
});

socket.on('groups', (groups) => {
  localGroups = groups;
  if (activeTab === 'groups') {
    renderGroups(localGroups);
  }
  // Si el modal del grupo que se está editando cambia, refrescar su lista interna
  if (editingGroupId) {
    const updated = groups.find(g => g.id === editingGroupId);
    if (updated) {
      modalNumbers = updated.numbers || [];
      renderModalNumbers();
    }
  }
});

socket.on('settings', (settings) => {
  localSettings = settings;
  if (activeTab === 'settings') {
    renderTags();
  }
});

socket.on('nuevo-descubierto', (data) => {
  // Si el usuario tiene el radar abierto de ese grupo específico, actualizar la lista al instante
  if (activeRadarGroupId && activeRadarGroupId === data.groupId) {
    loadRadarList(data.groupId);
  }
});

socket.on('pedido-tomado', (data) => {
  showToast(`🚀 ¡Gatillo disparado con éxito en: ${data.groupName}!`);
  if (Notification.permission === 'granted') {
    new Notification('🛵 Delivery Bot', { body: `¡Pedido atrapado en ${data.groupName}! Bot en reposo.` });
  }
});

// ==========================================
// 🔌 INTERFAZ DE ESTADO Y VINCULACIÓN
// ==========================================
function updateStatusUI() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const stepPhone = document.getElementById('phoneInputStep');
  const stepCode = document.getElementById('codeDisplayStep');

  dot.className = 'dot';

  if (currentStatus.connected) {
    dot.classList.add('online');
    txt.innerText = 'Conectado';
    stepPhone.classList.add('hidden');
    stepCode.classList.add('hidden');
  } else if (currentStatus.whatsappStatus === 'pairing_ready') {
    dot.classList.add('pairing');
    txt.innerText = 'Esperando Código';
  } else {
    dot.classList.add('offline');
    txt.innerText = 'Desconectado';
  }

  if (currentStatus.needsPairing && !currentStatus.connected && currentStatus.whatsappStatus !== 'pairing_ready') {
    stepPhone.classList.remove('hidden');
    stepCode.classList.add('hidden');
  }
}

async function requestWaCode() {
  const phone = document.getElementById('waPhoneNumber').value.trim();
  if (!phone) return showToast('Introduce tu número de WhatsApp.');
  
  const btn = document.getElementById('btnRequestCode');
  btn.innerText = 'Generando...';
  btn.disabled = true;

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
    showToast('Introduce el código en tu WhatsApp.');
  } catch (e) {
    showToast(e.message);
    btn.innerText = 'Generando código';
    btn.disabled = false;
  }
}

// ==========================================
// 🎨 RENDERIZADO DE GRUPOS (TOGGLES iOS)
// ==========================================
function renderGroups(groups) {
  const container = document.getElementById('groupsList');
  container.innerHTML = '';

  if (groups.length === 0) {
    container.innerHTML = `<div class="empty-state">No tienes grupos configurados.<br>Toca el botón de abajo para agregar uno.</div>`;
    return;
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
  const url = `/api/groups/${id}/${isChecked ? 'activate' : 'deactivate'}`;
  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error();
  } catch (e) {
    showToast('Error al cambiar estado del bot.');
    renderGroups(localGroups); // Revertir visualmente
  }
}

// ==========================================
// 📡 RADAR PERSISTENTE POR GRUPO
// ==========================================
async function openRadar(waGroupId, groupName) {
  activeRadarGroupId = waGroupId;
  document.getElementById('radarTitle').innerText = `📡 Radar: ${groupName}`;
  document.getElementById('radarModal').classList.remove('hidden');
  loadRadarList(waGroupId);
}

function closeRadar() {
  document.getElementById('radarModal').classList.add('hidden');
  activeRadarGroupId = null;
}

function closeRadarOutside(e) {
  if (e.target.id === 'radarModal') closeRadar();
}

async function loadRadarList(waGroupId) {
  const listCont = document.getElementById('radarList');
  try {
    const res = await fetch(`/api/groups/${waGroupId}/discovered`);
    const data = await res.json();
    listCont.innerHTML = '';

    if (data.length === 0) {
      listCont.innerHTML = '<p class="hint" style="text-align:center; padding: 20px 0;">No se han detectado stickers en este grupo todavía. El radar se actualizará solo en cuanto caiga uno.</p>';
      return;
    }

    data.forEach(item => {
      const timeStr = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const row = document.createElement('div');
      row.className = 'radar-row';
      row.innerHTML = `
        <div class="radar-info">
          <span class="radar-time">${timeStr}</span>
          <span class="radar-name">${item.name}</span>
          <span class="radar-id">ID: ${item.lid}</span>
        </div>
        <button class="btn-radar-add" onclick="addFromRadar('${waGroupId}', '${item.lid}', '${item.name}')">+ Add</button>
      `;
      listCont.appendChild(row);
    });
  } catch (e) {
    listCont.innerHTML = '<p class="hint">Error cargando el radar.</p>';
  }
}

async function addFromRadar(waGroupId, lid, name) {
  // Buscar a qué grupo local pertenece este waGroupId
  const group = localGroups.find(g => g.groupId === waGroupId);
  if (!group) return showToast('Error: Grupo no encontrado en el panel.');

  // Validar si el negocio ya está en la lista de ese grupo
  const yaExiste = group.numbers.some(n => n.number === lid);
  if (yaExiste) {
    return showToast('Este negocio ya lo tienes configurado en el grupo.');
  }

  // Clonar y empujar el nuevo negocio
  const updatedNumbers = [...group.numbers, { number: lid, name: name, active: true }];
  
  try {
    const res = await fetch(`/api/groups/${group.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: updatedNumbers })
    });
    if (!res.ok) throw new Error();
    showToast(`✅ Agregado: ${name}`);
  } catch (e) {
    showToast('Error al guardar en la lista.');
  }
}

// ==========================================
// 🏷️ RESPUESTAS ROTATIVAS GLOBALES (TAGS)
// ==========================================
function renderTags() {
  const cont = document.getElementById('tagsContainer');
  cont.innerHTML = '';
  const msgs = localSettings.messages || ['yo'];

  msgs.forEach((msg, idx) => {
    const tag = document.createElement('div');
    tag.className = 'msg-tag';
    tag.innerHTML = `
      <span>${msg}</span>
      <button onclick="removeMsgTag(${idx})">✕</button>
    `;
    cont.appendChild(tag);
  });
}

async function addNewMsgTag() {
  const input = document.getElementById('newTagInput');
  const value = input.value.trim();
  if (!value) return;

  const currentMsgs = [...(localSettings.messages || [])];
  if (currentMsgs.includes(value)) {
    input.value = '';
    return showToast('Esa respuesta ya existe.');
  }

  currentMsgs.push(value);
  await saveGlobalSettings(currentMsgs);
  input.value = '';
}

async function removeMsgTag(index) {
  const currentMsgs = [...(localSettings.messages || [])];
  currentMsgs.splice(index, 1);
  await saveGlobalSettings(currentMsgs);
}

async function saveGlobalSettings(messagesArray) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messagesArray })
    });
    const data = await res.json();
    localSettings = data;
    renderTags();
  } catch (e) {
    showToast('Error al guardar ajustes.');
  }
}

// ==========================================
// 📝 MODAL DE GRUPOS (CREAR / EDITAR)
// ==========================================
async function openModal(id = null) {
  editingGroupId = id;
  modalNumbers = [];
  
  document.getElementById('groupSelect').innerHTML = '<option value="">— Selecciona —</option>';
  document.getElementById('numberNameInput').value = '';
  document.getElementById('numberInput').value = '';
  
  if (id) {
    document.getElementById('modalTitle').innerText = 'Editar grupo';
    document.getElementById('btnDelete').classList.remove('hidden');
    const g = localGroups.find(group => group.id === id);
    if (g) {
      const opt = document.createElement('option');
      opt.value = g.groupId;
      opt.innerText = g.groupName;
      opt.selected = true;
      document.getElementById('groupSelect').appendChild(opt);
      modalNumbers = g.numbers || [];
    }
  } else {
    document.getElementById('modalTitle').innerText = 'Nuevo grupo';
    document.getElementById('btnDelete').classList.add('hidden');
    await loadWAGroups();
  }

  renderModalNumbers();
  document.getElementById('groupModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('groupModal').classList.add('hidden');
  editingGroupId = null;
}

function closeModalOutside(e) {
  if (e.target.id === 'groupModal') closeModal();
}

async function loadWAGroups() {
  const select = document.getElementById('groupSelect');
  const currentVal = select.value;
  select.innerHTML = '<option value="">Cargando chats...</option>';
  try {
    const res = await fetch('/api/wa-groups');
    if (!res.ok) throw new Error();
    const list = await res.json();
    select.innerHTML = '<option value="">— Selecciona —</option>';
    list.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.innerText = c.name;
      if (c.id === currentVal) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (e) {
    select.innerHTML = '<option value="">❌ Conecta WhatsApp primero</option>';
  }
}

function renderModalNumbers() {
  const ul = document.getElementById('numberList');
  ul.innerHTML = '';
  modalNumbers.forEach((n, idx) => {
    const isActive = n.active !== false;
    const li = document.createElement('li');
    li.className = `tag-item ${isActive ? '' : 'disabled'}`;
    li.innerHTML = `
      <div class="tag-click-zone" onclick="toggleNumberActive(${idx})">
        <span class="status-indicator"></span>
        <strong>${n.name || 'Negocio'}</strong>
        <small>${n.number}</small>
      </div>
      <button class="tag-remove" onclick="removeNumber(${idx})">✕</button>
    `;
    ul.appendChild(li);
  });
}

function addNumber() {
  const numInput = document.getElementById('numberInput');
  const nameInput = document.getElementById('numberNameInput');
  const number = numInput.value.trim();
  const name = nameInput.value.trim() || 'Negocio';

  if (!number) return;
  if (modalNumbers.some(n => n.number === number)) {
    numInput.value = '';
    return showToast('Ese número ya está en la lista.');
  }

  modalNumbers.push({ number, name, active: true });
  numInput.value = '';
  nameInput.value = '';
  renderModalNumbers();
}

function removeNumber(idx) {
  modalNumbers.splice(idx, 1);
  renderModalNumbers();
  if (editingGroupId) syncModalNumbersToBackend();
}

function toggleNumberActive(idx) {
  modalNumbers[idx].active = !modalNumbers[idx].active;
  renderModalNumbers();
  if (editingGroupId) syncModalNumbersToBackend();
}

function toggleAllModal(value) {
  modalNumbers.forEach(n => n.active = value);
  renderModalNumbers();
  if (editingGroupId) syncModalNumbersToBackend();
}

async function syncModalNumbersToBackend() {
  if (!editingGroupId) return;
  try {
    await fetch(`/api/groups/${editingGroupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: modalNumbers })
    });
  } catch (e) { }
}

async function saveGroup() {
  const select = document.getElementById('groupSelect');
  const groupId = select.value;
  const groupName = select.options[select.selectedIndex]?.text;

  if (!groupId) return showToast('Selecciona un grupo de WhatsApp.');

  const payload = { groupId, groupName, numbers: modalNumbers };
  const method = editingGroupId ? 'PUT' : 'POST';
  const url = editingGroupId ? `/api/groups/${editingGroupId}` : '/api/groups';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();
    closeModal();
    showToast('Grupo guardado con éxito.');
  } catch (e) {
    showToast('Error al guardar grupo.');
  }
}

async function deleteGroup() {
  if (!editingGroupId) return;
  if (!confirm('¿Quieres eliminar este grupo del bot?')) return;
  try {
    await fetch(`/api/groups/${editingGroupId}`, { method: 'DELETE' });
    closeModal();
    showToast('Grupo eliminado.');
  } catch (e) { }
}

// ==========================================
// 🚪 PANEL DE CUENTA (LOGOUT)
// ==========================================
function confirmLogout() {
  if (!confirm('¿Seguro que quieres cerrar la sesión de WhatsApp?\nSe borrarán los archivos de autenticación del servidor.')) return;
  const btn = document.getElementById('btnLogout');
  btn.innerText = 'Cerrando sesión...';
  btn.disabled = true;

  fetch('/api/logout', { method: 'POST' })
    .then(res => {
      if (res.ok) {
        showToast('Sesión destruida.');
        switchTab('settings');
      } else throw new Error();
    })
    .catch(() => showToast('Error al cerrar sesión.'))
    .finally(() => {
      btn.innerText = '🚪 Cerrar Sesión de WhatsApp';
      btn.disabled = false;
    });
}

// ==========================================
// 🔔 UTILERÍAS (TOASTS Y NOTIFICACIONES)
// ==========================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function requestNotifPermission() {
  Notification.requestPermission().then(perm => {
    if (perm === 'granted') {
      showToast('🔔 ¡Alertas del sistema activadas!');
      document.getElementById('btnNotif').style.display = 'none';
    } else {
      showToast('Permiso de notificaciones denegado.');
    }
  });
}

if (Notification.permission === 'granted') {
  document.getElementById('btnNotif').style.display = 'none';
}
