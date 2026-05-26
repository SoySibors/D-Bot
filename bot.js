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

let sock = null;
let io = null;
let groups = [];
let discovered = []; 
let status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true }; 

function loadFiles() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            groups = data.map(g => ({ ...g, active: false }));
        }
        if (fs.existsSync(DISCOVERED_FILE)) {
            discovered = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[BOT] Error leyendo archivos:', e.message);
    }
}

function saveGroups() {
    try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)); } 
    catch (e) { }
}

function saveDiscovered() {
    try { fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(discovered, null, 2)); } 
    catch (e) { }
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

async function handleMessage(m) {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const group = groups.find(g => g.groupId === from);
    
    // Si el grupo no está creado en el panel, ignoramos todo
    if (!group) return;

    let isSticker = false;
    const messageContent = msg.message;
    if (messageContent.stickerMessage) isSticker = true;
    else if (messageContent.ephemeralMessage?.message?.stickerMessage) isSticker = true;
    else if (messageContent.viewOnceMessage?.message?.stickerMessage) isSticker = true;
    else if (messageContent.viewOnceMessageV2?.message?.stickerMessage) isSticker = true;

    if (!isSticker) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderName = msg.pushName || 'Negocio Desconocido';
    const cleanId = sender.replace('@lid', '').replace('@s.whatsapp.net', '');

    // 1. REVISAR SI EL NEGOCIO YA ESTÁ EN LA LISTA (prendido o apagado)
    const negocioConfig = group.numbers.find(n => {
        const num = typeof n === 'string' ? n : n.number;
        return numbersMatch(sender, num);
    });

    // 2. LÓGICA DEL RADAR (Siempre activo)
    if (!negocioConfig) {
        const yaExiste = discovered.find(d => d.groupId === from && d.lid === cleanId);
        if (!yaExiste) {
            discovered.push({
                id: Date.now().toString(),
                groupId: from,
                lid: cleanId,
                name: senderName,
                time: Date.now()
            });
            // Subimos el límite a 500 para que sea un buen historial
            if (discovered.length > 500) discovered.shift(); 
            saveDiscovered();
            console.log(`[BOT] 📡 Nuevo en radar: ${senderName}`);
            if (io) io.emit('nuevo-descubierto', { groupId: from });
        }
        return; // Si es nuevo, lo guardamos y abortamos el disparo
    }

    // 3. LÓGICA DEL GATILLO (Solo si el grupo y el número están activos)
    if (!group.active) return;
    
    const isActive = typeof negocioConfig === 'string' ? true : negocioConfig.active !== false;
    if (!isActive) return;

    // ¡FUEGO!
    groups.forEach(g => g.active = false);
    if (io) io.emit('groups', groups);

    try {
        await sock.sendMessage(from, { text: group.replyMessage });
        console.log(`[BOT] ✅ ¡Pedido tomado en ${group.groupName}!`);
        if (io) io.emit('pedido-tomado', { groupName: group.groupName });
        saveGroups();
    } catch (e) {
        console.error('[BOT] Error al enviar respuesta:', e.message);
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
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
            if (io) io.emit('status', status);
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            status = { connected: true, whatsappStatus: 'ready', needsPairing: false };
            if (io) io.emit('status', status);
            console.log('[BOT] ¡Conectado a WhatsApp con éxito!');
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
    
    getDiscovered: (waGroupId) => discovered.filter(d => d.groupId === waGroupId).reverse(),
    removeDiscovered: (id) => {
        discovered = discovered.filter(d => d.id !== id);
        saveDiscovered();
    },

    requestPairingCodeAuth: async (phoneNumber) => {
        if (!sock) throw new Error('El sistema está iniciando.');
        if (!status.needsPairing) throw new Error('Ya hay una sesión iniciada.');
        try {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            return await sock.requestPairingCode(cleanNumber);
        } catch (error) {
            if (error?.message?.includes('Connection Closed')) throw new Error('El servidor de WA no está listo. Espera unos segundos.');
            else if (error?.message?.includes('rate-overlimit')) throw new Error('WhatsApp bloqueó temporalmente este número. Intenta más tarde.');
            throw new Error('Asegúrate de incluir el código de país correcto.');
        }
    },
    addGroup: (data) => {
        const newGroup = {
            id: Date.now().toString(),
            groupId: data.groupId,
            groupName: data.groupName,
            replyMessage: data.replyMessage || 'yo',
            numbers: (data.numbers || []).map(n => typeof n === 'string' ? { number: n, name: n, active: true } : n),
            active: false
        };
        groups.push(newGroup);
        saveGroups();
        if (io) io.emit('groups', groups);
        return newGroup;
    },
    updateGroup: (id, data) => {
        const index = groups.findIndex(g => g.id === id);
        if (index === -1) throw new Error('Grupo no encontrado');
        const wasActive = groups[index].active;
        const numbers = (data.numbers || groups[index].numbers).map(n => typeof n === 'string' ? { number: n, name: n, active: true } : n);
        groups[index] = { ...groups[index], ...data, active: wasActive, numbers };
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
        const group = groups.find(g => g.id === id);
        if (group) { group.active = true; saveGroups(); if (io) io.emit('groups', groups); }
    },
    deactivateGroup: (id) => {
        const group = groups.find(g => g.id === id);
        if (group) { group.active = false; saveGroups(); if (io) io.emit('groups', groups); }
    },
    toggleNumber: (groupId, numIndex) => {
        const group = groups.find(g => g.id === groupId);
        if (group && group.numbers[numIndex]) {
            const n = group.numbers[numIndex];
            group.numbers[numIndex] = typeof n === 'string' ? { number: n, name: n, active: false } : { ...n, active: !n.active };
            saveGroups();
            if (io) io.emit('groups', groups);
            return group.numbers[numIndex];
        }
    },
    toggleAllNumbers: (groupId, value) => {
        const group = groups.find(g => g.id === groupId);
        if (group) {
            group.numbers = group.numbers.map(n => typeof n === 'string' ? { number: n, name: n, active: value } : { ...n, active: value });
            saveGroups();
            if (io) io.emit('groups', groups);
        }
    },
    getWAGroups: async () => {
        if (!status.connected) throw new Error('WhatsApp no conectado');
        const chats = await sock.groupFetchAllParticipating();
        return Object.values(chats).map(c => ({ id: c.id, name: c.subject }));
    },
    logout: async () => {
        if (sock) { try { await sock.logout(); } catch (e) { } }
        if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        status = { connected: false, whatsappStatus: 'disconnected', needsPairing: true };
        if (io) io.emit('status', status);
        setTimeout(() => connectToWhatsApp(), 2000);
    }
};
