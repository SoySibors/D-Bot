const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Archivos de persistencia locales
const GROUPS_FILE = path.join(__dirname, 'groups-config.json');
const SETTINGS_FILE = path.join(__dirname, 'global-settings.json');
const HISTORIAL_FILE = path.join(__dirname, 'historial.json');

let groupsData = fs.existsSync(GROUPS_FILE) ? JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')) : [];
let settingsData = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : { messages: ['yo'] };
let historialData = fs.existsSync(HISTORIAL_FILE) ? JSON.parse(fs.readFileSync(HISTORIAL_FILE, 'utf8')) : [];

let sock = null;
let connectionStatus = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
let radarCache = {}; // waGroupId -> Array de descubiertos

// Guardado seguro
function saveGroups() { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupsData, null, 2)); io.emit('groups', groupsData); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsData, null, 2)); io.emit('settings', settingsData); }
function saveHistorial() { fs.writeFileSync(HISTORIAL_FILE, JSON.stringify(historialData, null, 2)); io.emit('historial', historialData); }

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    mobile: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
      io.emit('status', connectionStatus);
      if (shouldReconnect) initWhatsApp();
    } else if (connection === 'open') {
      connectionStatus = { connected: true, whatsappStatus: 'connected', needsPairing: false };
      io.emit('status', connectionStatus);
      io.emit('groups', groupsData);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid; 
      if (!from.endsWith('@g.us')) continue; // Solo grupos

      // Detectar Sticker de pedido
      if (msg.message.stickerMessage) {
        const matchingGroup = groupsData.find(g => g.groupId === from && g.active);
        if (!matchingGroup) continue;

        // Extraer ID o datos del sticker (usamos el fileLength o hash para identificar el negocio)
        const stickerId = msg.message.stickerMessage.fileLength || 'N/A';
        const senderName = msg.pushName || 'Negocio Detectado';

        // 1. Guardar en el radar en tiempo real
        if (!radarCache[from]) radarCache[from] = [];
        if (!radarCache[from].some(item => item.lid === stickerId)) {
          radarCache[from].unshift({ lid: stickerId, name: senderName, time: Date.now() });
          if (radarCache[from].length > 30) radarCache[from].pop();
          io.emit('nuevo-descubierto', { groupId: from });
        }

        // 2. Verificar si el negocio está en la lista activa de cacería de este grupo
        const targetBusiness = matchingGroup.numbers.find(n => n.number == stickerId && n.active !== false);
        if (targetBusiness) {
          // Seleccionar frase rotativa al azar
          const phrases = settingsData.messages.length > 0 ? settingsData.messages : ['yo'];
          const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

          // SIMULACIÓN FANTASMA: Mandar estado "Escribiendo..." por 300ms antes del gatillazo
          await sock.presenceSubscribe(from);
          await sock.sendPresenceUpdate('composing', from);
          
          setTimeout(async () => {
            await sock.sendPresenceUpdate('paused', from);
            // DISPARAR EL GATILLO
            await sock.sendMessage(from, { text: randomPhrase }, { quoted: msg });

            // 3. Registrar de inmediato en el Historial Permanente
            const nuevoPedido = {
              id: 'ped_' + Date.now(),
              groupName: matchingGroup.groupName,
              businessName: targetBusiness.name,
              time: Date.now(),
              phraseUsed: randomPhrase,
              status: 'pending' // pending, won, lost
            };
            historialData.unshift(nuevoPedido);
            saveHistorial();

            io.emit('pedido-tomado', nuevoPedido);
          }, 300);
        }
      }
    }
  });
}

// ── API ENDPOINTS ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json(connectionStatus));

app.post('/api/request-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !sock) return res.status(400).json({ error: 'Número inválido o bot no iniciado' });
  try {
    connectionStatus.whatsappStatus = 'pairing_ready';
    io.emit('status', connectionStatus);
    const code = await sock.requestPairingCode(phone.replace(/[+\s]/g, ''));
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: 'Error al generar código de vinculación' });
  }
});

app.get('/api/wa-groups', async (req, res) => {
  if (!connectionStatus.connected || !sock) return res.status(400).json([]);
  try {
    const chats = await sock.groupFetchAllParticipating();
    const list = Object.values(chats).map(c => ({ id: c.id, name: c.subject }));
    res.json(list);
  } catch (e) { res.status(500).json([]); }
});

app.get('/api/groups', (req, res) => res.json(groupsData));
app.post('/api/groups', (req, res) => {
  const newG = { id: 'g_' + Date.now(), ...req.body, active: true };
  groupsData.push(newG); saveGroups(); res.json(newG);
});
app.put('/api/groups/:id', (req, res) => {
  const idx = groupsData.findIndex(g => g.id === req.params.id);
  if (idx !== -1) { groupsData[idx] = { ...groupsData[idx], ...req.body }; saveGroups(); }
  res.json({ success: true });
});
app.delete('/api/groups/:id', (req, res) => {
  groupsData = groupsData.filter(g => g.id !== req.params.id); saveGroups(); res.json({ success: true });
});
app.post('/api/groups/:id/activate', (req, res) => {
  const g = groupsData.find(g => g.id === req.params.id); if (g) g.active = true; saveGroups(); res.json({ success: true });
});
app.post('/api/groups/:id/deactivate', (req, res) => {
  const g = groupsData.find(g => g.id === req.params.id); if (g) g.active = false; saveGroups(); res.json({ success: true });
});

app.get('/api/groups/:waGroupId/discovered', (req, res) => {
  res.json(radarCache[req.params.waGroupId] || []);
});

app.get('/api/settings', (req, res) => res.json(settingsData));
app.post('/api/settings', (req, res) => { settingsData = req.body; saveSettings(); res.json(settingsData); });

// Endpoints de Historial y Métricas
app.get('/api/historial', (req, res) => res.json(historialData));
app.post('/api/historial/:id/resolve', (req, res) => {
  const { status } = req.body; // 'won' o 'lost'
  const pedido = historialData.find(p => p.id === req.params.id);
  if (pedido) {
    pedido.status = status;
    saveHistorial();
  }
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
    connectionStatus = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
    io.emit('status', connectionStatus);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo cerrar sesión' }); }
});

server.listen(PORT, () => {
  console.log(`=== PROYECTO D-BOT CORRIENDO EN PUERTO ${PORT} ===`);
  initWhatsApp().catch(err => console.error("Error inicializando bot:", err));
});