const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- BASE DE DATOS INICIAL AUTOMÁTICA ---
const configInicial = {
    miNumero: "5219981234567", // Cambia esto por tu número real con código de país
    claveAcceso: "admin123",     // Esta será tu contraseña para entrar a la página web
    botActivo: true,
    negocios: {},
    grupos: {}
};

if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configInicial, null, 2));
}

function leerConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function guardarConfig(nuevaConfig) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria temporal para capturar los IDs que van cayendo (para que los copies desde la web)
let historialLogs = [];
function registrarLog(texto) {
    const hora = new Date().toLocaleTimeString();
    historialLogs.unshift(`[${hora}] ${texto}`);
    if (historialLogs.length > 50) historialLogs.pop();
}

// --- FRONTEND: DISEÑO DE LA PÁGINA WEB ---
const HTML_PANEL = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>D-Bot Panel de Control</title>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; }
        body { background-color: #121824; color: #e2e8f0; padding: 15px; }
        .container { max-width: 600px; margin: 0 auto; }
        header { text-align: center; margin-bottom: 20px; padding: 15px; background: #1e293b; border-radius: 12px; border-bottom: 4px solid #3b82f6; }
        h1 { font-size: 20px; color: #fff; }
        .status-box { display: flex; justify-content: space-between; align-items: center; background: #1e293b; padding: 15px; border-radius: 12px; margin-bottom: 15px; }
        .btn { padding: 10px 16px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%; text-align: center; display: block; }
        .btn-active { background: #22c55e; color: white; }
        .btn-inactive { background: #ef4444; color: white; }
        .btn-submit { background: #3b82f6; color: white; margin-top: 10px; }
        .btn-danger { background: #dc2626; color: white; padding: 6px 10px; font-size: 12px; border-radius: 6px; width: auto; }
        .card { background: #1e293b; padding: 15px; border-radius: 12px; margin-bottom: 15px; }
        h2 { font-size: 16px; margin-bottom: 12px; color: #3b82f6; border-left: 4px solid #3b82f6; padding-left: 8px; }
        label { display: block; font-size: 12px; margin-bottom: 4px; color: #94a3b8; }
        input, select { width: 100%; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: white; margin-bottom: 12px; font-size: 14px; }
        .list-item { background: #0f172a; padding: 10px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
        .logs-box { background: #0f172a; border: 1px solid #334155; padding: 10px; border-radius: 8px; height: 150px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #38bdf8; }
        .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .badge-on { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
        .badge-off { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    </style>
</head>
<body>
    <div class="container" id="app-login">
        <header><h1>🔓 Acceso Seguro D-Bot</h1></header>
        <div class="card">
            <label>Introduce tu Clave de Acceso:</label>
            <input type="password" id="pass-input" placeholder="Contraseña...">
            <button class="btn btn-submit" onclick="verificarLogin()">Entrar al Panel</button>
        </div>
    </div>

    <div class="container" id="app-panel" style="display: none;">
        <header>
            <h1>⚡ PANEL D-BOT SAAS ⚡</h1>
            <p style="font-size: 11px; color: #94a3b8; margin-top: 5px;">Control Remoto de Alta Velocidad</p>
        </header>

        <div class="status-box">
            <div>
                <span style="font-size: 14px;">Estado del Bot:</span>
                <div id="status-text" style="font-weight: bold; font-size: 18px; margin-top: 2px;">Cargando...</div>
            </div>
            <button id="toggle-bot-btn" class="btn" style="width: auto;" onclick="cambiarEstadoBot()"></button>
        </div>

        <div class="card">
            <h2>⚙️ Configuración Maestra</h2>
            <form id="form-global" onsubmit="guardarGlobal(event)">
                <label>Mi Número de WhatsApp (Con código de país, ej: 5219981234567):</label>
                <input type="text" id="cfg-numero" required>
                <label>Nueva Clave de Acceso Web:</label>
                <input type="text" id="cfg-clave" required>
                <button type="submit" class="btn btn-submit">Actualizar Datos</button>
            </form>
        </div>

        <div class="card">
            <h2>👥 Mis Grupos de WhatsApp</h2>
            <form onsubmit="agregarGrupo(event)" style="margin-bottom: 15px;">
                <input type="text" id="grp-id" placeholder="ID del Grupo (ej: 1203632... @g.us)" required>
                <input type="text" id="grp-nombre" placeholder="Nombre Alias (ej: Grupo Norte)" required>
                <input type="text" id="grp-msg" placeholder="Mensaje de Respuesta (ej: Yo)" value="Yo" required>
                <button type="submit" class="btn btn-submit">+ Agregar / Editar Grupo</button>
            </form>
            <div id="lista-grupos"></div>
        </div>

        <div class="card">
            <h2>🏢 Negocios Autorizados</h2>
            <form onsubmit="agregarNegocio(event)" style="margin-bottom: 15px;">
                <input type="text" id="neg-id" placeholder="ID del Negocio (ej: 521998... @s.whatsapp.net)" required>
                <input type="text" id="neg-nombre" placeholder="Nombre del Negocio (ej: Pizza Plaza)" required>
                <button type="submit" class="btn btn-submit">+ Agregar / Editar Negocio</button>
            </form>
            <div id="lista-negocios"></div>
        </div>

        <div class="card">
            <h2>📡 Rastreador de IDs (Copia desde aquí)</h2>
            <p style="font-size: 11px; color: #94a3b8; margin-bottom: 8px;">Cuando alguien hable en un grupo, aquí verás los códigos exactos para agregarlos arriba.</p>
            <div class="logs-box" id="logs-view">Esperando actividad...</div>
        </div>
    </div>

    <script>
        let tokenAcceso = "";

        function verificarLogin() {
            const pass = document.getElementById('pass-input').value;
            fetch('/api/get-config', {
                headers: { 'Authorization': pass }
            })
            .then(res => {
                if(res.status === 401) { alert('Clave incorrecta'); throw new Error(); }
                return res.json();
            })
            .then(data => {
                tokenAcceso = pass;
                document.getElementById('app-login').style.display = 'none';
                document.getElementById('app-panel').style.display = 'block';
                renderizarTodo(data);
                setInterval(actualizarLogsYEstado, 3000);
            }).catch(()=>{});
        }

        function renderizarTodo(data) {
            // Estado global
            const statusText = document.getElementById('status-text');
            const toggleBtn = document.getElementById('toggle-bot-btn');
            if(data.botActivo) {
                statusText.innerHTML = '<span style="color:#22c55e;">BUSCANDO PEDIDOS 🟢</span>';
                toggleBtn.innerText = "Pausar Bot";
                toggleBtn.className = "btn btn-inactive";
            } else {
                statusText.innerHTML = '<span style="color:#ef4444;">EN PAUSA / OCUPADO 🔴</span>';
                toggleBtn.innerText = "Activar Bot";
                toggleBtn.className = "btn btn-active";
            }

            // Inputs maestros
            document.getElementById('cfg-numero').value = data.miNumero;
            document.getElementById('cfg-clave').value = data.claveAcceso;

            // Listar grupos
            const divGrupos = document.getElementById('lista-grupos');
            divGrupos.innerHTML = "";
            for(let id in data.grupos) {
                const g = data.grupos[id];
                divGrupos.innerHTML += \`
                    <div class="list-item">
                        <div>
                            <b>\${g.nombre}</b> <span class="badge \${g.activo?'badge-on':'badge-off'}">\${g.activo?'Activo':'Apagado'}</span><br>
                            <span style="font-size:11px; color:#94a3b8;">ID: \${id}</span><br>
                            <span style="font-size:11px; color:#3b82f6;">Responde: "\${g.mensajeRespuesta}"</span>
                        </div>
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-submit" style="padding:4px 8px; font-size:11px;" onclick="switchEstado('grupo', '\${id}')">On/Off</button>
                            <button class="btn btn-danger" onclick="eliminarElemento('grupo', '\${id}')">X</button>
                        </div>
                    </div>
                \`;
            }

            // Listar negocios
            const divNegocios = document.getElementById('lista-negocios');
            divNegocios.innerHTML = "";
            for(let id in data.negocios) {
                const n = data.negocios[id];
                divNegocios.innerHTML += \`
                    <div class="list-item">
                        <div>
                            <b>\${n.nombre}</b> <span class="badge \${n.activo?'badge-on':'badge-off'}">\${n.activo?'Autorizado':'Bloqueado'}</span><br>
                            <span style="font-size:11px; color:#94a3b8;">ID: \${id}</span>
                        </div>
                        <div style="display:flex; gap:5px;">
                            <button class="btn btn-submit" style="padding:4px 8px; font-size:11px;" onclick="switchEstado('negocio', '\${id}')">On/Off</button>
                            <button class="btn btn-danger" onclick="eliminarElemento('negocio', '\${id}')">X</button>
                        </div>
                    </div>
                \`;
            }
        }

        function actualizarLogsYEstado() {
            fetch('/api/live-data', { headers: { 'Authorization': tokenAcceso } })
            .then(res => res.json())
            .then(data => {
                // Actualizar logs
                const logsView = document.getElementById('logs-view');
                if(data.logs.length > 0) {
                    logsView.innerHTML = data.logs.join('<br>');
                } else {
                    logsView.innerHTML = "Esperando actividad en WhatsApp...";
                }
                
                // Actualizar switch de estado dinámicamente si cambió por WhatsApp (#libre/#ocupado)
                const statusText = document.getElementById('status-text');
                const toggleBtn = document.getElementById('toggle-bot-btn');
                if(data.botActivo) {
                    statusText.innerHTML = '<span style="color:#22c55e;">BUSCANDO PEDIDOS 🟢</span>';
                    toggleBtn.innerText = "Pausar Bot";
                    toggleBtn.className = "btn btn-inactive";
                } else {
                    statusText.innerHTML = '<span style="color:#ef4444;">EN PAUSA / OCUPADO 🔴</span>';
                    toggleBtn.innerText = "Activar Bot";
                    toggleBtn.className = "btn btn-active";
                }
            });
        }

        function enviarAccion(endpoint, payload) {
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': tokenAcceso },
                body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => renderizarTodo(data));
        }

        function cambiarEstadoBot() { enviarAccion('/api/toggle-bot', {}); }
        function guardarGlobal(e) { e.preventDefault(); enviarAccion('/api/save-global', { miNumero: document.getElementById('cfg-numero').value, claveAcceso: document.getElementById('cfg-clave').value }); }
        function agregarGrupo(e) { e.preventDefault(); enviarAccion('/api/add-grupo', { id: document.getElementById('grp-id').value.trim(), nombre: document.getElementById('grp-nombre').value, msg: document.getElementById('grp-msg').value }); document.getElementById('grp-id').value=''; document.getElementById('grp-nombre').value=''; }
        function agregarNegocio(e) { e.preventDefault(); enviarAccion('/api/add-negocio', { id: document.getElementById('neg-id').value.trim(), nombre: document.getElementById('neg-nombre').value }); document.getElementById('neg-id').value=''; document.getElementById('neg-nombre').value=''; }
        function switchEstado(tipo, id) { enviarAccion('/api/switch-estado', { tipo, id }); }
        function eliminarElemento(tipo, id) { if(confirm('¿Seguro?')) enviarAccion('/api/delete-item', { tipo, id }); }
    </script>
</body>
</html>
`;

// --- RUTAS DE LA API WEB (BACKEND) ---
const middlewareAuth = (req, res, next) => {
    const config = leerConfig();
    if (req.headers.authorization !== config.claveAcceso) return res.status(401).send("No autorizado");
    next();
};

app.get('/', (req, res) => res.send(HTML_PANEL));
app.get('/api/get-config', middlewareAuth, (req, res) => res.json(leerConfig()));
app.get('/api/live-data', middlewareAuth, (req, res) => {
    const config = leerConfig();
    res.json({ botActivo: config.botActivo, logs: historialLogs });
});

app.post('/api/toggle-bot', middlewareAuth, (req, res) => {
    let config = leerConfig();
    config.botActivo = !config.botActivo;
    guardarConfig(config);
    registrarLog(`Bot cambiado manualmente a: ${config.botActivo ? '🟢 BUSCANDO' : '🔴 PAUSA'}`);
    res.json(config);
});

app.post('/api/save-global', middlewareAuth, (req, res) => {
    let config = leerConfig();
    config.miNumero = req.body.miNumero;
    config.claveAcceso = req.body.claveAcceso;
    guardarConfig(config);
    res.json(config);
});

app.post('/api/add-grupo', middlewareAuth, (req, res) => {
    let config = leerConfig();
    config.grupos[req.body.id] = { nombre: req.body.nombre, mensajeRespuesta: req.body.msg, activo: true };
    guardarConfig(config);
    res.json(config);
});

app.post('/api/add-negocio', middlewareAuth, (req, res) => {
    let config = leerConfig();
    config.negocios[req.body.id] = { nombre: req.body.nombre, activo: true };
    guardarConfig(config);
    res.json(config);
});

app.post('/api/switch-estado', middlewareAuth, (req, res) => {
    let config = leerConfig();
    const { tipo, id } = req.body;
    if (tipo === 'grupo' && config.grupos[id]) config.grupos[id].activo = !config.grupos[id].activo;
    if (tipo === 'negocio' && config.negocios[id]) config.negocios[id].activo = !config.negocios[id].activo;
    guardarConfig(config);
    res.json(config);
});

app.post('/api/delete-item', middlewareAuth, (req, res) => {
    let config = leerConfig();
    const { tipo, id } = req.body;
    if (tipo === 'grupo') delete config.grupos[id];
    if (tipo === 'negocio') delete config.negocios[id];
    guardarConfig(config);
    res.json(config);
});

app.listen(PORT, () => console.log(`[WEB] Servidor UI corriendo en puerto ${PORT}`));


// =========================================================================
// --- MOTOR AUTOMÁTICO DE WHATSAPP (BAILEYS DE ALTA VELOCIDAD) ---
// =========================================================================

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_auth');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    // Código de vinculación directo a pantalla de Railway
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const config = leerConfig();
                let numeroLimpio = config.miNumero.replace(/[^0-9]/g, '');
                if (numeroLimpio && numeroLimpio !== "5219981234567") {
                    let codigo = await sock.requestPairingCode(numeroLimpio);
                    console.log(`\n=================================================`);
                    console.log(`🔑 CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${codigo}`);
                    console.log(`=================================================\n`);
                    registrarLog(`CÓDIGO DE VINCULACIÓN GENERADO: ${codigo}`);
                } else {
                    console.log("[ALERTA] Ingresa a tu panel web y coloca tu número real para vincular.");
                }
            } catch (e) {
                console.error("Error pidiendo código vinculación", e);
            }
        }, 6000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const debeReiniciar = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (debeReiniciar) iniciarBot();
        } else if (connection === 'open') {
            console.log('[SISTEMA] Conectado a WhatsApp.');
            registrarLog("¡Bot conectado con éxito a WhatsApp! 🎉");
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        let config = leerConfig(); // Lectura en tiempo real para no cruzar configuraciones

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const idChat = msg.key.remoteJid; 
            const deMi = msg.key.fromMe;
            const idEmisor = msg.key.participant || msg.key.remoteJid; 

            // CONTROL REMOTO MEDIANTE CHAT WHATSAPP
            if (deMi) {
                const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                if (texto.trim().toLowerCase() === '#libre') {
                    config.botActivo = true;
                    guardarConfig(config);
                    registrarLog("Bot activado por comando de WhatsApp (#libre) 🟢");
                    await sock.sendMessage(idChat, { text: "✅ D-Bot listo. Buscando pedidos... 🟢" });
                    continue;
                }
                if (texto.trim().toLowerCase() === '#ocupado') {
                    config.botActivo = false;
                    guardarConfig(config);
                    registrarLog("Bot pausado por comando de WhatsApp (#ocupado) 🔴");
                    await sock.sendMessage(idChat, { text: "❌ D-Bot pausado. 🔴" });
                    continue;
                }
            }

            // Monitoreo en vivo para capturar IDs desde la interfaz web
            if (idChat.endsWith('@g.us')) {
                registrarLog(`Detectado chat en grupo. ID Grupo: "${idChat}" | ID Persona: "${idEmisor}"`);
            }

            // --- FILTROS AUTOMÁTICOS ATÓMICOS ---
            if (!config.botActivo) continue;

            const grupoConf = config.grupos[idChat];
            if (!grupoConf || !grupoConf.activo) continue;

            const negocioConf = config.negocios[idEmisor];
            if (!negocioConf || !negocioConf.activo) continue;

            // ¡PEDIDO DETECTADO! - ACCIÓN ATÓMICA DE MILISEGUNDOS
            try {
                // 1. Apagamos el bot inmediatamente en memoria y archivo para evitar respuestas múltiples
                config.botActivo = false;
                guardarConfig(config);
                
                registrarLog(`🔥 ¡DISPARANDO RESPUESTA! Pedido de [${negocioConf.nombre}] en [${grupoConf.nombre}]`);
                
                // 2. Ejecutamos la respuesta ultra rápida citando el mensaje del negocio
                const respuestaText = grupoConf.mensajeRespuesta || "Yo";
                await sock.sendMessage(idChat, { text: respuestaText }, { quoted: msg });
                
                registrarLog(`✅ Respondido exitosamente con "${respuestaText}". Bot puesto en PAUSA 🔴.`);
            } catch (err) {
                console.error("Error en disparo atómico:", err);
            }
        }
    });
}

iniciarBot();
