import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';

// Bot Championship Imports
import {
  extractEnabledBots,
  getBotDisplayName,
  getBotEmoji,
  getAllBots
} from './botchamp/BotDiscovery.js';
import TournamentEngine from './botchamp/TournamentEngine.js';
import { buildBotCatalog, resolveBotCode } from './bots/catalogService.js';

// Load env
dotenv.config();

// Imports from project
import { authenticateToken, requireDocsAuth } from './middleware/auth.js';
import {
  loginGoogle,
  googleCallback,
  loginVKID,
  vkidCallback,
  loginFacebookWeb,
  facebookWebCallback,
  refresh,
  status,
  devLogin,
  nativeAuthGoogle,
  authVKMiniApp,
  authFacebookInstant,
  authYandexGames,
  authGuest,
  authItch,
  itchOAuthCallbackPage,
  mintToken
} from './controllers/auth.js';
import { updateStats, getProfile, resetTournament, updateNickname } from './controllers/stats.js';

import prisma from './models/db.js';
import { initSocket } from './socket/gameManager.js';
import { initOnlineLobby } from './socket/onlineLobby.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3001;

const app = express();
const httpServer = http.createServer(app);

app.set('trust proxy', 1);

// CORS config
app.use(cors({
  origin: true, // Allow all origins for dev/mobile testing, restrict in prod if needed
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// REST routes
app.get('/api/v2/health', (req, res) => {
  res.json({ status: 'ok', v2: true });
});

// Auth endpoints
app.get('/api/v2/auth/google', loginGoogle);
app.get('/api/v2/auth/google/callback', googleCallback);
app.get('/auth/google/callback', googleCallback);
app.get('/api/v2/auth/vkid', loginVKID);
app.get('/auth/vk/callback', vkidCallback);
app.get('/api/v2/auth/facebook-web', loginFacebookWeb);
app.get('/auth/facebook/callback', facebookWebCallback);
app.get('/api/v2/auth/dev', devLogin);
app.post('/api/v2/auth/refresh', refresh);
app.get('/api/v2/auth/status', authenticateToken, status);
app.post('/api/v2/auth/mint-token', mintToken);

app.get('/api/v2/profile', authenticateToken, getProfile);
app.post('/api/v2/profile/update-nickname', authenticateToken, updateNickname);
app.post('/api/v2/stats/update', authenticateToken, updateStats);
app.post('/api/v2/stats/reset-tournament', authenticateToken, resetTournament);

// Extensible Social/Native Stubs
app.post('/api/v2/auth/google-native', nativeAuthGoogle);
app.post('/api/v2/auth/vk', authVKMiniApp);
app.post('/api/v2/auth/facebook', authFacebookInstant);
// FB Instant клиент шлёт сюда снимок состояния FBInstant, когда identity недоступна;
// смотреть: journalctl -u rps-v2-backend | grep 'FB Instant diagnostics'
app.post('/api/v2/auth/facebook/diagnostics', (req, res) => {
  try {
    console.log('[FB Instant diagnostics]', JSON.stringify(req.body).slice(0, 8000));
  } catch (_) {}
  res.json({ ok: true });
});
app.post('/api/v2/auth/yandex', authYandexGames);
app.post('/api/v2/auth/guest', authGuest);
// itch.io OAuth: обмен access_token на наш JWT + страница-приёмник redirect
app.post('/api/v2/auth/itch', authItch);
app.get('/auth/itch/callback', itchOAuthCallbackPage);

// Serve Static built files for React Native Web Client
const clientDistPath = path.join(__dirname, '../../client/dist');
const botsStaticPath = path.join(__dirname, '../../shared/ai/bots');
const docsStaticPath = path.join(__dirname, '../../docs');
// Bot roster metadata (public) — the client fetches this at startup to build
// the selection screen without bundling any bot code.
app.get(['/api/v2/bots', '/v2/api/v2/bots'], (req, res) => {
  try {
    res.set('Cache-Control', 'no-cache');
    res.json(buildBotCatalog());
  } catch (e) {
    console.error('[bots] failed to build catalog:', e);
    res.status(500).json({ error: 'bot_catalog_failed' });
  }
});
// Hash-validated bot code for client-side caching. The client sends the hash of
// its cached copy via ?have=<hash>; the server replies "up_to_date" (reuse the
// cache) or "updated" (here is the new code). This avoids re-downloading a bot
// the client already holds while guaranteeing it always runs the latest logic.
app.get(['/api/v2/bots/:id/code', '/v2/api/v2/bots/:id/code'], (req, res) => {
  try {
    const result = resolveBotCode(req.params.id, req.query.have);
    if (result.status === 'not_found') {
      return res.status(404).json({ error: 'bot_not_found' });
    }
    res.set('Cache-Control', 'no-cache');
    return res.json(result);
  } catch (e) {
    console.error('[bots] failed to resolve bot code:', e);
    return res.status(500).json({ error: 'bot_code_failed' });
  }
});
// Bot code + avatars (public) — must be registered before SPA fallback.
// Bot logic is fetched on demand from /js/bots/<id>/bot.js at match start.
app.use('/js/bots', express.static(botsStaticPath));
app.use('/v2/js/bots', express.static(botsStaticPath));
// Публичные инструкции — доступны по прямому URL без авторизации
// (регистрируются ДО requireDocsAuth, остальные доки остаются закрытыми)
const PUBLIC_DOCS = ['VK-INTEGRATION.md', 'DIARY-DEPLOY.md', 'LANGUAGEFLASH-DEPLOY.md'];
for (const doc of PUBLIC_DOCS) {
  app.get(`/docs/${doc}`, (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(docsStaticPath, doc));
  });
}
// Docs (protected) — must be registered before SPA fallback
app.use('/docs', requireDocsAuth, express.static(docsStaticPath));

// Legal pages
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'terms.html'));
});

app.use('/', express.static(clientDistPath));
app.use('/v2', express.static(clientDistPath));
// VK Mini Apps открывает игру по адресу /vk — та же сборка, клиент по пути
// понимает, что запущен внутри VK (скрывает выход из аккаунта и т.п.)
app.use('/vk', express.static(clientDistPath));

// ======================================================================
//  BOT CHAMPIONSHIP PLATFORM
// ======================================================================

function requireChampionshipAuth(req, res, next) {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }
  
  let token = req.query.token;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  
  if (!token) {
    if (req.method === 'GET' && req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.status(401).send('<h1>Unauthorized: Admins only</h1><p>Пожалуйста, войдите в игру как администратор.</p>');
    }
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    if (decoded && (decoded.email === 'irozoyicawoy97@gmail.com' || decoded.role === 'admin')) {
      req.user = decoded;
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Admins only' });
  } catch (err) {
    if (req.method === 'GET' && req.headers.accept && req.headers.accept.includes('text/html')) {
      return res.status(401).send('<h1>Unauthorized: Invalid token</h1>');
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

const tournamentEngine = new TournamentEngine({
  serverPort: PORT,
  headed: false,
  concurrency: 1
});

app.use('/botchamp/screenshots', requireChampionshipAuth, express.static(path.join(__dirname, 'botchamp/screenshots')));

app.get('/botchamp/api/bots', requireChampionshipAuth, (req, res) => {
  res.json(getAllBots());
});

app.get('/botchamp/api/schedules', requireChampionshipAuth, (req, res) => {
  const configsDir = path.join(__dirname, 'botchamp/configs');
  try {
    const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.json'));
    const schedulesList = files.map(file => {
      const filePath = path.join(configsDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let matchCount = 0;
      (data.rounds || []).forEach(r => matchCount += (r.matches || []).length);
      return {
        file,
        name: data.name || file,
        rounds: (data.rounds || []).length,
        matches: matchCount
      };
    });
    res.json(schedulesList);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read schedules' });
  }
});

/**
 * Current draw if the engine is running; otherwise the previous finished/stopped draw.
 * Stale DB rows with status=running (e.g. after a server restart) are closed out so
 * they don't shadow the real last tournament in «Сыгранные матчи».
 */
async function resolveDisplayChampionship() {
  // Prefer the championship the in-memory engine is actually running
  if (tournamentEngine.isRunning() && tournamentEngine.championshipId) {
    const live = await prisma.championship.findUnique({
      where: { id: tournamentEngine.championshipId }
    });
    if (live) return live;
  }

  // Close orphaned "running" records that are no longer in the engine
  if (!tournamentEngine.isRunning()) {
    try {
      await prisma.championship.updateMany({
        where: { status: 'running' },
        data: {
          status: 'stopped',
          finishedAt: new Date()
        }
      });
    } catch (err) {
      console.error('[BotChamp] Failed to close stale running championships:', err);
    }
  }

  return prisma.championship.findFirst({
    where: { status: { in: ['finished', 'stopped'] } },
    orderBy: { startedAt: 'desc' }
  });
}

app.post('/botchamp/api/tournament/start', requireChampionshipAuth, async (req, res) => {
  if (tournamentEngine.isRunning()) {
    return res.status(409).json({ error: 'Championship is already running' });
  }
  
  const { scheduleFile, options = {} } = req.body;

  if (!scheduleFile) {
    return res.status(400).json({ error: 'scheduleFile is required' });
  }

  let schedule = null;
  const filePath = path.join(__dirname, 'botchamp/configs', scheduleFile);
  try {
    schedule = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Schedule file not found' });
  }

  tournamentEngine.options.headed = !!options.headed;
  tournamentEngine.options.concurrency = Number(options.concurrency) || 1;
  tournamentEngine.options.accelerate = options.accelerate !== false;

  try {
    // Await only championship create + kickoff (not the full tournament)
    const info = await tournamentEngine.runTournament(schedule);
    io.emit('tournament:started', {
      schedule: info.name,
      championshipId: info.championshipId,
      totalMatches: info.totalMatches
    });
    res.json({
      ok: true,
      championshipId: info.championshipId,
      name: info.name,
      totalMatches: info.totalMatches
    });
  } catch (err) {
    console.error('[BotChamp API] Tournament failed to start:', err);
    res.status(500).json({ error: 'Failed to start championship' });
  }
});

app.post('/botchamp/api/tournament/stop', requireChampionshipAuth, async (req, res) => {
  try {
    const result = await tournamentEngine.stop();
    res.json({
      ok: true,
      stopped: true,
      alreadyStopped: !!result?.alreadyStopped,
      standings: tournamentEngine.standings.toJSON(),
      progress: tournamentEngine.progress
    });
  } catch (err) {
    console.error('[BotChamp API] Stop failed:', err);
    res.status(500).json({ error: 'Failed to stop championship' });
  }
});

app.get('/botchamp/api/tournament/state', requireChampionshipAuth, (req, res) => {
  res.json(tournamentEngine.getLiveState());
});

app.get('/botchamp/api/standings', requireChampionshipAuth, async (req, res) => {
  const champ = await resolveDisplayChampionship();
  if (!champ) {
    return res.json({
      standings: [],
      tournamentName: null,
      championshipId: null,
      status: null
    });
  }
  const standings = champ.standings || { standings: [] };
  res.json({
    standings: standings.standings || [],
    tournamentName: champ.name,
    championshipId: champ.id,
    status: champ.status
  });
});

/**
 * Matches of the current draw if a championship is running;
 * otherwise matches of the previous (latest finished/stopped) draw.
 * Never mixes multiple championships.
 */
app.get('/botchamp/api/results', requireChampionshipAuth, async (req, res) => {
  const champ = await resolveDisplayChampionship();
  if (!champ) {
    return res.json({
      championshipId: null,
      championshipName: null,
      status: null,
      matches: []
    });
  }
  const matches = await prisma.championshipMatch.findMany({
    where: { championshipId: champ.id },
    orderBy: { playedAt: 'desc' }
  });
  res.json({
    championshipId: champ.id,
    championshipName: champ.name,
    status: champ.status,
    matches
  });
});

app.get('/botchamp/api/result/:id', requireChampionshipAuth, async (req, res) => {
  const match = await prisma.championshipMatch.findUnique({
    where: { id: req.params.id }
  });
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json(match);
});

app.get('/botchamp/api/archives', requireChampionshipAuth, async (req, res) => {
  const archives = await prisma.championship.findMany({
    where: { status: { in: ['finished', 'stopped'] } },
    orderBy: { startedAt: 'desc' }
  });
  res.json(archives);
});

app.get('/botchamp/api/archive/:id', requireChampionshipAuth, async (req, res) => {
  const champ = await prisma.championship.findUnique({
    where: { id: req.params.id }
  });
  if (!champ) return res.status(404).json({ error: 'Archive not found' });
  
  const matches = await prisma.championshipMatch.findMany({
    where: { championshipId: champ.id },
    orderBy: { playedAt: 'asc' }
  });
  
  res.json({
    id: champ.id,
    name: champ.name,
    startedAt: champ.startedAt,
    finishedAt: champ.finishedAt,
    totalMatches: champ.totalMatches,
    standings: champ.standings,
    matches
  });
});

app.get('/botchamp/api/archive/:id/match/:matchId', requireChampionshipAuth, async (req, res) => {
  const match = await prisma.championshipMatch.findUnique({
    where: { id: req.params.matchId }
  });
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json(match);
});

// For React Navigation HTML5 routing (fallback to index.html)
app.get('/v2/*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});
app.get('/vk/*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});
app.get('/*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Configure Socket.IO
const io = new Server(httpServer, {
  path: '/v2/socket.io', // Path configured in Nginx
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Setup Redis adapter for Socket.IO scaling
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let pubClient;
let subClient;

try {
  pubClient = new Redis(redisUrl);
  subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  console.log('Redis adapter connected for Socket.IO');
} catch (error) {
  console.error('Redis connection failed:', error);
}

// Initialize real-time PvP socket logic
initOnlineLobby(io);
initSocket(io);

// Hook tournament engine events to Socket.io broadcasts
tournamentEngine.on('match:start', (data) => {
  io.emit('match:start', data);
});

tournamentEngine.on('match:finished', (data) => {
  io.emit('match:finished', data);
});

tournamentEngine.on('tournament:finished', (data) => {
  io.emit('tournament:finished', data);
});

tournamentEngine.on('match:error', (data) => {
  io.emit('match:error', data);
});

// Start listening
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`RPS Battle V2 Backend server running on http://localhost:${PORT}`);
});
