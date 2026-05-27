const { webcrypto } = require('node:crypto');
if (!global.crypto) global.crypto = webcrypto;

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore 
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
const HISTORIAL_FILE = path.join(DATA_DIR, 'historial.json');

let sock = null;
let io = null;
let groups = [];
let discovered = [];
let settings = { messages: ['yo'] };
let historial = [];
let status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
let typingInterval = null;
let disparando = false;

function loadFiles() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            groups = data.map(g => ({
                ...g,
                active: false,
                blocked: g.blocked || [],
                numbers: (g.numbers || []).map(n =>
                    typeof n === 'string'
                        ? { number: n, name: n, active: true, favorite: false }
                        : { favorite: false, ...n }
                )
            }));
        }
        if (fs.existsSync(DISCOVERED_FILE)) discovered = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
        if (fs.existsSync(SETTINGS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (parsed && Array.isArray(parsed.messages)) settings = parsed;
        }
        if (fs.existsSync(HISTORIAL_FILE)) historial = JSON.parse(fs.readFileSync(HISTORIAL_FILE, 'utf8'));
    } catch (e) {
        console.error('[BOT] Error leyendo archivos:', e.message);
    }
}

function saveGroups() {
    try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } catch (e) {}
}
function saveDiscovered() {
    try { fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(discovered, null, 2)); } catch (e) {}
}
function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) {}
}
function saveHistorial() {
    try { fs.writeFileSync(HISTORIAL_FILE, JSON.stringify(historial, null, 2)); } catch (e) {}
}

function numbersMatch(senderId, storedNumber) {
    const cleanStored = storedNumber.replace(/\D/g, '');
    const cleanSender = senderId.replace(/\D/g, '');
    if (cleanSender.includes(cleanStored)) return true;
    if (cleanStored.startsWith('52') && !cleanStored.startsWith('521')) {
        if (cleanSender.includes('521' + cleanStored.slice(2))) return true;
    }
    if (cleanStored.startsWith('521')) {
        if (cleanSender.includes('52' + cleanStored.slice(3))) return true;
    }
    return false;
}

function startPassiveTypingSimulation() {
    if (typingInterval) clearInterval(typingInterval);
    typingInterval = setInterval(async () => {
        if (!sock || !status.connected) return;
        const activeGroups = groups.filter(g => g.active);
        if (activeGroups.length === 0) return;
        const randomGroup = activeGroups[Math.floor(Math.random() * activeGroups.length)];
        try {
            await sock.sendPresenceUpdate('composing', randomGroup.groupId);
            setTimeout(async () => {
                if (sock && status.connected) await sock.sendPresenceUpdate('paused', randomGroup.groupId);
            }, 5000);
        } catch (e) {}
    }, 180000);
}

async function handleMessage(m) {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const group = groups.find(g => g.groupId === from);
    if (!group) return;

    let isSticker = false;
    const mc = msg.message;
    if (mc.stickerMessage) isSticker = true;
    else if (mc.ephemeralMessage?.message?.stickerMessage) isSticker = true;
    else if (mc.viewOnceMessage?.message?.stickerMessage) isSticker = true;
    else if (mc.viewOnceMessageV2?.message?.stickerMessage) isSticker = true;
    if (!isSticker) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const cleanId = sender.replace('@lid', '').replace('@s.whatsapp.net', '');

    const negocioConfig = group.numbers.find(n => {
        const num = typeof n === 'string' ? n : n.number;
        return numbersMatch(sender, num);
    });

    if (!negocioConfig) {
        const senderName = msg.pushName || 'Negocio Desconocido';
        const yaExiste = discovered.find(d => d.groupId === from && d.lid === cleanId);
        if (!yaExiste) {
            discovered.push({
                id: Date.now().toString(),
                groupId: from,
                lid: cleanId,
                name: senderName,
                time: Date.now()
            });
            if (discovered.length > 500) discovered.shift();
            saveDiscovered();
            if (io) io.emit('nuevo-descubierto', { groupId: from });
        }
        return;
    }

    if (!group.active) return;
    const isActive = typeof negocioConfig === 'string' ? true : negocioConfig.active !== false;
    if (!isActive) return;

    if (disparando) return;
    disparando = true;

    const listaMensajes = settings?.messages?.length > 0 ? settings.messages : ['yo'];
    const mensajeAleatorio = listaMensajes[Math.floor(Math.random() * listaMensajes.length)];

    groups.forEach(g => { g.active = false; });
    saveGroups();
    if (io) io.emit('groups', groups);

    sock.sendMessage(from, { text: mensajeAleatorio })
        .then(async () => {
            if (sock) {
                await sock.sendPresenceUpdate('composing', from);
                setTimeout(() => { if (sock) sock.sendPresenceUpdate('paused', from); }, 3000);
            }
        })
        .catch(e => console.error('[BOT] Error al disparar:', e))
        .finally(() => { disparando = false; });

    const nuevoRegistro = {
        id: 'ped_' + Date.now(),
        groupName: group.groupName,
        businessName: negocioConfig.name || cleanId,
        time: Date.now(),
        phraseUsed: mensajeAleatorio,
        status: 'pending'
    };
    historial.unshift(nuevoRegistro);
    if (historial.length > 300) historial.pop();
    saveHistorial();
    if (io) {
        io.emit('historial', historial);
        io.emit('pedido-tomado', nuevoRegistro);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    status.needsPairing = !state.creds.registered;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            status = { connected: false, whatsappStatus: 'pairing_ready', needsPairing: true };
            if (io) io.emit('status', status);
        }
        if (connection === 'close') {
            if (typingInterval) clearInterval(typingInterval);
            disparando = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
            if (io) io.emit('status', status);
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            status = { connected: true, whatsappStatus: 'ready', needsPairing: false };
            if (io) io.emit('status', status);
            console.log('[BOT] ¡Conectado con éxito!');
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
    getHistorial: () => historial,

    saveSettingsConfig: (data) => {
        if (data && Array.isArray(data.messages)) {
            settings.messages = data.messages.length > 0 ? data.messages : ['yo'];
            saveSettings();
        }
        if (io) io.emit('settings', settings);
        return settings;
    },
    resolvePedido: (id, targetStatus) => {
        const item = historial.find(p => p.id === id);
        if (item) { item.status = targetStatus; saveHistorial(); }
        if (io) io.emit('historial', historial);
        return historial;
    },
    getDiscovered: (waGroupId) => discovered.filter(d => d.groupId === waGroupId).reverse(),
    removeDiscovered: (id) => {
        discovered = discovered.filter(d => d.id !== id);
        saveDiscovered();
    },
    requestPairingCodeAuth: async (phoneNumber) => {
        if (!sock) throw new Error('Iniciando sistema...');
        try {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            return await sock.requestPairingCode(cleanNumber);
        } catch (error) {
            throw new Error('Error al solicitar código.');
        }
    },
    addGroup: (data) => {
        const newGroup = {
            id: Date.now().toString(),
            groupId: data.groupId,
            groupName: data.groupName,
            numbers: (data.numbers || []).map(n =>
                typeof n === 'string'
                    ? { number: n, name: n, active: true, favorite: false }
                    : { favorite: false, ...n }
            ),
            blocked: data.blocked || [],
            active: false
        };
        groups.push(newGroup);
        saveGroups();
        if (io) io.emit('groups', groups);
        return newGroup;
    },
    updateGroup: (id, data) => {
        const index = groups.findIndex(g => g.id === id);
        if (index === -1) throw new Error('No encontrado');
        const wasActive = groups[index].active;
        const numbers = (data.numbers || groups[index].numbers).map(n =>
            typeof n === 'string'
                ? { number: n, name: n, active: true, favorite: false }
                : { favorite: false, ...n }
        );
        const blocked = data.blocked !== undefined ? data.blocked : (groups[index].blocked || []);
        groups[index] = { ...groups[index], ...data, id, active: wasActive, numbers, blocked };
        saveGroups();
        if (io) io.emit('groups', groups);
        return groups[index];
    },
    removeGroup: (id) => {
        groups = groups.filter(g => g.id !== id);
        saveGroups();
        if (io) io.emit('groups', groups);
    },
    activateGroup: (id) => {
        const g = groups.find(g => g.id === id);
        if (g) { g.active = true; saveGroups(); if (io) io.emit('groups', groups); }
    },
    deactivateGroup: (id) => {
        const g = groups.find(g => g.id === id);
        if (g) { g.active = false; saveGroups(); if (io) io.emit('groups', groups); }
    },
    blockNumber: (groupId, lid) => {
        const g = groups.find(g => g.id === groupId);
        if (!g) throw new Error('Grupo no encontrado');
        if (!g.blocked) g.blocked = [];
        if (!g.blocked.includes(lid)) g.blocked.push(lid);
        g.numbers = g.numbers.filter(n => {
            const num = typeof n === 'string' ? n : n.number;
            return num !== lid;
        });
        saveGroups();
        if (io) io.emit('groups', groups);
    },
    unblockNumber: (groupId, lid) => {
        const g = groups.find(g => g.id === groupId);
        if (!g) throw new Error('Grupo no encontrado');
        g.blocked = (g.blocked || []).filter(b => b !== lid);
        saveGroups();
        if (io) io.emit('groups', groups);
    },
    toggleFavorite: (groupId, numberIndex) => {
        const g = groups.find(g => g.id === groupId);
        if (!g) throw new Error('Grupo no encontrado');
        if (!g.numbers[numberIndex]) throw new Error('Número no encontrado');
        g.numbers[numberIndex].favorite = !g.numbers[numberIndex].favorite;
        saveGroups();
        if (io) io.emit('groups', groups);
        return g.numbers[numberIndex];
    },
    getWAGroups: async () => {
        if (!status.connected || !sock) throw new Error('Desconectado');
        const chats = await sock.groupFetchAllParticipating();
        return Object.values(chats).map(c => ({ id: c.id, name: c.subject }));
    },
    logout: async () => {
        if (typingInterval) clearInterval(typingInterval);
        disparando = false;
        if (sock) { try { await sock.logout(); } catch (e) {} }
        if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
        if (io) io.emit('status', status);
        setTimeout(() => connectToWhatsApp(), 2000);
    }
};