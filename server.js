const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

bot.setIO(io);

// RUTA PARA SOLICITAR EL CÓDIGO DE VINCULACIÓN DE 8 DÍGITOS
app.post('/api/request-code', async (req, res) => {
  try {
    const code = await bot.requestPairingCodeAuth(req.body.phone);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (req, res) => res.json(bot.getStatus()));
app.get('/api/groups', (req, res) => res.json(bot.getGroupsConfig()));

app.post('/api/groups', (req, res) => res.json(bot.addGroup(req.body)));

app.put('/api/groups/:id', (req, res) => {
  try { res.json(bot.updateGroup(req.params.id, req.body)); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.delete('/api/groups/:id', (req, res) => {
  bot.removeGroup(req.params.id);
  res.json({ ok: true });
});

app.post('/api/groups/:id/activate', (req, res) => {
  try { bot.activateGroup(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/groups/:id/deactivate', (req, res) => {
  try { bot.deactivateGroup(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.patch('/api/groups/:id/numbers/:index', (req, res) => {
  try {
    const result = bot.toggleNumber(req.params.id, parseInt(req.params.index));
    res.json(result);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/groups/:id/numbers/toggle-all', (req, res) => {
  try {
    bot.toggleAllNumbers(req.params.id, req.body.value);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/wa-groups', async (req, res) => {
  try { res.json(await bot.getWAGroups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  try { await bot.logout(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

io.on('connection', (socket) => {
  socket.emit('status', bot.getStatus());
  socket.emit('groups', bot.getGroupsConfig());
});

server.listen(PORT, () => {
  console.log(`[SERVER] Sistema inicializado en el puerto ${PORT}`);
  bot.init();
});
