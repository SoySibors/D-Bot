const { webcrypto } = require('node:crypto');
if (!global.crypto) global.crypto = webcrypto;

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_PATH = path.join(DATA_DIR, 'session_auth');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const DISCOVERED_FILE = path.join(DATA_DIR, 'discovered.json'); 
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json'); 

let sock = null;
let io = null;
let groups = [];
let discovered = {}; 
let settings = { messages: ['yo'] }; 
let status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true }; 
let passiveTypingInterval = null;

// ── MANEJO DE ARCHIVOS (PERSISTENCIA LIGERA) ──
function loadFiles() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            groups = data.map(g => ({ 
                ...g, 
                active: false, 
                radarActive: g.radarActive !== false, 
                blocked: g.blocked || [],
                numbers: (g.numbers || []).map(n => ({ ...n, favorite: n.favorite || false }))
            }));
        }
        if (fs.existsSync(DISCOVERED_FILE)) {
            discovered = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
        }
        if (fs.existsSync(SETTINGS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (parsed && Array.isArray(parsed.messages)) settings = parsed;
        }
    } catch (e) { console.error('[BOT] Error leyendo archivos:', e.message); }
}

function saveGroups() { try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } catch (e) {} }
function saveDiscovered() { try { fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(discovered, null, 2)); } catch (e) {} }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) {} }

function numbersMatch(senderId, storedNumber) {
    const cleanStored = storedNumber.replace(/\D/g, '');
    const cleanSender = senderId.replace(/\D/g, '');
    if (cleanSender.includes(cleanStored)) return true;
    if (cleanStored.startsWith('52') && !cleanStored.startsWith('521') && cleanSender.includes('521' + cleanStored.slice(2))) return true;
    if (cleanStored.startsWith('521') && cleanSender.includes('52' + cleanStored.slice(3))) return true;
    return false;
}

// ── PRESENCIA FANTASMA PASIVA (NO BLOQUEANTE) ──
function startPassiveTypingSimulation() {
    if (passiveTypingInterval) clearInterval(passiveTypingInterval);
    passiveTypingInterval = setInterval(async () => {
        if (!sock || !status.connected) return;
        const activeGroups = groups.filter(g => g.active);
        if (activeGroups.length === 0) return;
        
        const randomGroup = activeGroups[Math.floor(Math.random() * activeGroups.length)];
        try {
            await sock.sendPresenceUpdate('composing', randomGroup.groupId);
            setTimeout(async () => {
                if (sock && status.connected) await sock.sendPresenceUpdate('paused', randomGroup.groupId);
            }, 4000);
        } catch (e) {}
    }, 120000); 
}

// ── CEREBRO DE CAZA EXTREMA (GATILLO EN 0 MILISEGUNDOS) ──
async function handleMessage(m) {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const group = groups.find(g => g.groupId === from);
    if (!group) return; 

    const msgContent = msg.message;
    const isSticker = msgContent.stickerMessage || 
                      msgContent.ephemeralMessage?.message?.stickerMessage || 
                      msgContent.viewOnceMessage?.message?.stickerMessage || 
                      msgContent.viewOnceMessageV2?.message?.stickerMessage;
    
    if (!isSticker) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const cleanId = sender.replace('@lid', '').replace('@s.whatsapp.net', '');

    const negocioConfig = group.numbers.find(n => numbersMatch(sender, n.number));

    if (!negocioConfig) {
        if (group.radarActive) {
            const blockedSet = new Set(group.blocked || []);
            if (blockedSet.has(cleanId)) return; 

            const senderName = msg.pushName || 'Negocio Desconocido';
            if (!discovered[from]) discovered[from] = [];
            
            const yaExiste = discovered[from].find(d => d.lid === cleanId);
            if (!yaExiste) {
                discovered[from].unshift({ id: Date.now().toString(), lid: cleanId, name: senderName, time: Date.now() });
                if (discovered[from].length > 300) discovered[from].pop(); 
                saveDiscovered();
                if (io) io.emit('nuevo-descubierto', { groupId: from });
            }
        }
        return; 
    }

    if (group.active && negocioConfig.active !== false) {
        const phrases = settings?.messages?.length > 0 ? settings.messages : ['yo'];
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

        sock.sendMessage(from, { text: randomPhrase }, { quoted: msg }).catch(() => {});

        groups.forEach(g => g.active = false);
        saveGroups();
        if (io) {
            io.emit('groups', groups);
            io.emit('pedido-tomado', { groupName: group.groupName, businessName: negocioConfig.name });
        }
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    // RESTAURADO A LA VERSIÓN QUE FUNCIONA 100%
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        mobile: false,
        syncFullHistory: false, 
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    status.needsPairing = !state.creds.registered;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { status = { connected: false, whatsappStatus: 'pairing_ready', needsPairing: true }; if (io) io.emit('status', status); }
        if (connection === 'close') {
            if (passiveTypingInterval) clearInterval(passiveTypingInterval);
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
            if (io) io.emit('status', status);
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            status = { connected: true, whatsappStatus: 'ready', needsPairing: false };
            if (io) io.emit('status', status);
            console.log('[BOT] Conectado en Modo Espartano VIP.');
            startPassiveTypingSimulation();
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleMessage);
}

module.exports = {
    init: () => { loadFiles(); connectToWhatsApp(); },
    setIO: (ioInstance) => { io = ioInstance; },
    getStatus: () => status,
    getGroupsConfig: () => groups,
    getSettings: () => settings,
    
    saveSettingsConfig: (data) => {
        if (data && Array.isArray(data.messages)) { settings.messages = data.messages.length > 0 ? data.messages : ['yo']; saveSettings(); }
        if (io) io.emit('settings', settings);
        return settings;
    },
    
    getDiscovered: (waGroupId) => discovered[waGroupId] || [],
    blockFromRadar: (waGroupId, lid) => {
        const group = groups.find(g => g.groupId === waGroupId);
        if (group) {
            if (!group.blocked) group.blocked = [];
            if (!group.blocked.includes(lid)) group.blocked.push(lid);
            saveGroups();
        }
        if (discovered[waGroupId]) {
            discovered[waGroupId] = discovered[waGroupId].filter(d => d.lid !== lid);
            saveDiscovered();
        }
        return discovered[waGroupId] || [];
    },

    requestPairingCodeAuth: async (phoneNumber) => {
        if (!sock) throw new Error('Iniciando sistema...');
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        return await sock.requestPairingCode(cleanNumber);
    },
    
    addGroup: (data) => {
        const newGroup = {
            id: Date.now().toString(),
            groupId: data.groupId,
            groupName: data.groupName,
            radarActive: true,
            blocked: [],
            numbers: (data.numbers || []).map(n => typeof n === 'string' ? { number: n, name: n, active: true, favorite: false } : n),
            active: false
        };
        groups.push(newGroup); saveGroups();
        if (io) io.emit('groups', groups);
        return newGroup;
    },
    updateGroup: (id, data) => {
        const index = groups.findIndex(g => g.id === id);
        if (index === -1) throw new Error('No encontrado');
        groups[index] = { ...groups[index], ...data };
        saveGroups();
        if (io) io.emit('groups', groups);
        return groups[index];
    },
    removeGroup: (id) => {
        groups = groups.filter(g => g.id !== id); saveGroups();
        if (io) io.emit('groups', groups);
    },
    activateGroup: (id) => {
        const group = groups.find(g => g.id === id);
        if (group) { group.active = true; saveGroups(); if (io) io.emit('groups', groups); }
    },
    deactivateGroup: (id) => {
        const group = groups.find(g => g.id === id);
        if (group) { group.active = false; saveGroups(); if (io) io.emit('groups', groups); }
    },
    getWAGroups: async () => {
        if (!status.connected || !sock) throw new Error('Desconectado');
        const chats = await sock.groupFetchAllParticipating();
        return Object.values(chats).map(c => ({ id: c.id, name: c.subject }));
    },
    logout: async () => {
        if (passiveTypingInterval) clearInterval(passiveTypingInterval);
        if (sock) { try { await sock.logout(); } catch (e) {} }
        if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
        if (io) io.emit('status', status);
        setTimeout(() => connectToWhatsApp(), 2000);
    }
};
