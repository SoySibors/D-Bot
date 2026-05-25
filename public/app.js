const socket = io();
let groups = [];
let modalNums = [];
let editingId = null;

// ==========================================
// RECEPCIÓN DE EVENTOS DE SOCKET.IO
// ==========================================
socket.on('status', (s) => updateStatusDot(s));
socket.on('groups', (g) => { groups = g; renderGroups(); });

// Evento modificado: Escucha si el bot arroja señal de QR e interactúa con el panel de código
socket.on('qr', (dataUrl) => {
  // Baileys usa WebSockets internos, si llega un QR/Señal manejamos la visibilidad desde el status badge
});

socket.on('pedido-tomado', ({ groupName }) => alertPedido(groupName));

// ==========================================
// ACCIÓN PARA SOLICITAR EL CÓDIGO DE 8 DÍGITOS
// ==========================================
async function requestWaCode() {
  const phoneInput = document.getElementById('waPhoneNumber').value.trim().replace(/\D/g, '');
  if (!phoneInput) {
    showToast('Ingresa un número válido', true);
    return;
  }
  
  const btn = document.getElementById('btnRequestCode');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneInput })
    });
    const data = await res.json();
    
    if (res.ok && data.code) {
      document.getElementById('phoneInputStep').classList.add('hidden');
      document.getElementById('codeDisplayStep').classList.remove('hidden');
      document.getElementById('pairingCodeDisplay').textContent = data.code;
      showToast('¡Código generado! 🔑');
    } else {
      throw new Error(data.error || 'Error del servidor');
    }
  } catch (e) {
    showToast('Error: ' + e.message, true);
  } finally {
    btn.textContent = 'Generar código';
    if (!document.getElementById('phoneInputStep').classList.contains('hidden')) {
      btn.disabled = false;
    }
  }
}

// ==========================================
// ACTUALIZACIÓN DE LA INTERFAZ Y ESTADOS
// ==========================================
function updateStatusDot(statusObj) {
  const ws = statusObj.whatsappStatus;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const pairingSection = document.getElementById('pairingSection');
  const btnRequest = document.getElementById('btnRequestCode');
  
  dot.className = 'dot';
  
  if (ws === 'ready') {
    dot.classList.add('connected');
    text.textContent = 'Conectado';
    if (pairingSection) pairingSection.classList.add('hidden');
  } else {
    if (ws === 'pairing_ready') {
      dot.classList.add('qr');
      text.textContent = 'Listo para vincular';
      if (btnRequest) btnRequest.disabled = false;
    } else if (ws === 'connecting') {
      dot.classList.add('qr');
      text.textContent = 'Conectando...';
      if (btnRequest) btnRequest.disabled = true;
    } else {
      dot.classList.add('error');
      text.textContent = 'Desconectado';
      if (btnRequest) btnRequest.disabled = true;
    }
    
    // Si la sesión de Baileys reporta que necesita emparejamiento, mostramos la sección
    if (statusObj.needsPairing && pairingSection) {
      pairingSection.classList.remove('hidden');
      document.getElementById('phoneInputStep').classList.remove('hidden');
      document.getElementById('codeDisplayStep').classList.add('hidden');
    }
  }
}

function renderGroups() {
  const el = document.getElementById('groupsList');
  if (!groups.length) {
    el.innerHTML = '<div class="empty">Sin grupos · toca + para agregar</div>';
    return;
  }
  el.innerHTML = groups.map(g => {
    const onCount = g.numbers.filter(n => typeof n === 'string' ? true : n.active !== false).length;
    return `
      <div class="group-card ${g.active ? 'is-active' : ''}" id="card-${g.id}">
        <div class="group-card-header">
          <div class="group-card-info">
            <div class="group-card-name">${g.groupName}</div>
            <div class="group-card-meta">${onCount} de ${g.numbers.length} negocios activos · stickers</div>
          </div>
          <button class="group-card-edit" onclick="openModal('${g.id}')">⚙️</button>
        </div>
        <button class="group-toggle ${g.active ? 'on' : 'off'}" onclick="toggleGroup('${g.id}')">
          ${g.active ? '⏹ DESACTIVAR' : '▶ ACTIVAR'}
        </button>
      </div>
    `;
  }).join('');
}

async function toggleGroup(id) {
  const g = groups.find(x => x.id === id);
  if (!g) return;
  await fetch(`/api/groups/${id}/${g.active ? 'deactivate' : 'activate'}`, { method: 'POST' });
}

function openModal(id = null) {
  editingId = id;
  if (id) {
    const g = groups.find(x => x.id === id);
    document.getElementById('modalTitle').textContent = 'Editar grupo';
    document.getElementById('replyMessage').value = g.replyMessage || 'yo';
    modalNums = g.numbers.map(n => typeof n === 'string' ? { number: n, name: n, active: true } : { ...n });
    loadWAGroups(g.groupId, g.groupName);
    document.getElementById('btnDelete').classList.remove('hidden');
  } else {
    document.getElementById('modalTitle').textContent = 'Nuevo grupo';
    document.getElementById('replyMessage').value = 'yo';
    document.getElementById('groupSelect').innerHTML = '<option value="">— Selecciona —</option>';
    modalNums = [];
    document.getElementById('btnDelete').classList.add('hidden');
    loadWAGroups();
  }
  renderModalNums();
  document.getElementById('groupModal').classList.remove('hidden');
}

function closeModal() { document.getElementById('groupModal').classList.add('hidden'); }
function closeModalOutside(e) { if (e.target === document.getElementById('groupModal')) closeModal(); }

async function loadWAGroups(selectedId = null, selectedName = null) {
  try {
    const res = await fetch('/api/wa-groups');
    if (!res.ok) throw new Error('No conectado');
    const waGroups = await res.json();
    const sel = document.getElementById('groupSelect');
    sel.innerHTML = '<option value="">— Selecciona —</option>';
    waGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id; opt.textContent = g.name;
      if (g.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
    if (selectedId && !waGroups.find(g => g.id === selectedId) && selectedName) {
      const opt = document.createElement('option');
      opt.value = selectedId; opt.textContent = selectedName; opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) { showToast('Error: ' + e.message, true); }
}

function addNumber() {
  const nameInput = document.getElementById('numberNameInput');
  const phoneInput = document.getElementById('numberInput');
  const phone = phoneInput.value.trim().replace(/\D/g, '');
  const name = nameInput.value.trim();
  if (!phone) return;
  if (modalNums.some(n => n.number === phone)) return;
  modalNums.push({ number: phone, name: name || phone, active: true });
  renderModalNums();
  nameInput.value = ''; phoneInput.value = '';
}

function toggleModalNum(i) {
  modalNums[i] = { ...modalNums[i], active: !modalNums[i].active };
  renderModalNums();
}

function removeModalNum(i) {
  modalNums.splice(i, 1);
  renderModalNums();
}

function toggleAllModal(value) {
  modalNums = modalNums.map(n => ({ ...n, active: value }));
  renderModalNums();
}

function renderModalNums() {
  const list = document.getElementById('numberList');
  if (!modalNums.length) {
    list.innerHTML = '<li class="empty" style="padding:12px 0;">Sin negocios · agrega arriba</li>';
    return;
  }
  list.innerHTML = modalNums.map((n, i) => `
    <li class="number-item ${!n.active ? 'inactive' : ''}">
      <div class="number-item-info">
        <span class="number-item-name">${n.name || n.number}</span>
        <span class="number-item-phone">${n.number}</span>
      </div>
      <button class="num-toggle ${n.active ? 'on' : 'off'}" onclick="toggleModalNum(${i})">
        ${n.active ? 'ON' : 'OFF'}
      </button>
      <button class="num-del" onclick="removeModalNum(${i})">✕</button>
    </li>
  `).join('');
}

async function saveGroup() {
  const sel = document.getElementById('groupSelect');
  const msg = document.getElementById('replyMessage').value.trim() || 'yo';
  if (!sel.value) { showToast('Selecciona un grupo', true); return; }
  const data = {
    groupId: sel.value,
    groupName: sel.options[sel.selectedIndex]?.text || 'Sin nombre',
    replyMessage: msg,
    numbers: modalNums
  };
  if (editingId) {
    await fetch(`/api/groups/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    showToast('Grupo actualizado ✓');
  } else {
    await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    showToast('Grupo agregado ✓');
  }
  closeModal();
}

async function deleteGroup() {
  if (!editingId) return;
  await fetch(`/api/groups/${editingId}`, { method: 'DELETE' });
  showToast('Grupo eliminado');
  closeModal();
}

function updateNotifBtn() {
  const btn = document.getElementById('btnNotif');
  if (!('Notification' in window)) { btn.style.display = 'none'; return; }
  btn.className = 'btn-notif ' + Notification.permission;
}

async function requestNotifPermission() {
  if (!('Notification' in window)) { showToast('No soportado', true); return; }
  if (Notification.permission === 'denied') { showToast('Bloqueadas en ajustes', true); return; }
  await Notification.requestPermission();
  updateNotifBtn();
  if (Notification.permission === 'granted') showToast('¡Alertas activadas! 🔔');
}

function alertPedido(groupName) {
  if ('vibrate' in navigator) navigator.vibrate([400, 150, 400, 150, 800]);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[0, 880], [0.25, 1100], [0.5, 880], [0.75, 1320]].forEach(([delay, freq]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.6, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.22);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.22);
    });
  } catch (e) {}
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🛵 ¡PEDIDO TOMADO!', { body: groupName, requireInteraction: true });
  }
}

async function confirmLogout() {
  if (!confirm('¿Cerrar sesión de WhatsApp?\nTendrás que vincular el dispositivo de nuevo.')) return;
  await fetch('/api/logout', { method: 'POST' });
  showToast('Sesión cerrada');
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.background = isError ? '#e74c3c' : '#25d366';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

document.getElementById('numberInput').addEventListener('keydown', e => { if (e.key === 'Enter') addNumber(); });
document.getElementById('numberNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('numberInput').focus(); });

// Inicialización
fetch('/api/status').then(r => r.json()).then(s => updateStatusDot(s)).catch(()=>{});
fetch('/api/groups').then(r => r.json()).then(g => { groups = g; renderGroups(); }).catch(()=>{});
updateNotifBtn();
