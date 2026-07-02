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

// Load env
dotenv.config();

// Imports from project
import { authenticateToken, requireDocsAuth } from './middleware/auth.js';
import {
  loginGoogle,
  googleCallback,
  refresh,
  status,
  devLogin,
  nativeAuthGoogle,
  authVKMiniApp,
  authFacebookInstant,
  authYandexGames,
  authGuest,
  mintToken
} from './controllers/auth.js';
import { updateStats, getProfile, resetTournament } from './controllers/stats.js';

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
app.get('/api/v2/auth/dev', devLogin);
app.post('/api/v2/auth/refresh', refresh);
app.get('/api/v2/auth/status', authenticateToken, status);
app.post('/api/v2/auth/mint-token', mintToken);

app.get('/api/v2/profile', authenticateToken, getProfile);
app.post('/api/v2/stats/update', authenticateToken, updateStats);
app.post('/api/v2/stats/reset-tournament', authenticateToken, resetTournament);

// Extensible Social/Native Stubs
app.post('/api/v2/auth/google-native', nativeAuthGoogle);
app.post('/api/v2/auth/vk', authVKMiniApp);
app.post('/api/v2/auth/facebook', authFacebookInstant);
app.post('/api/v2/auth/yandex', authYandexGames);
app.post('/api/v2/auth/guest', authGuest);

// Serve Static built files for React Native Web Client
const clientDistPath = path.join(__dirname, '../../client/dist');
const botsStaticPath = path.join(__dirname, '../../shared/ai/bots');
const docsStaticPath = path.join(__dirname, '../../docs');
// Bot avatars (public) — must be registered before SPA fallback
app.use('/js/bots', express.static(botsStaticPath));
app.use('/v2/js/bots', express.static(botsStaticPath));
// Docs (protected) — must be registered before SPA fallback
app.use('/docs', requireDocsAuth, express.static(docsStaticPath));
app.use('/', express.static(clientDistPath));
app.use('/v2', express.static(clientDistPath));
// VK Mini Apps открывает игру по адресу /vk — та же сборка, клиент по пути
// понимает, что запущен внутри VK (скрывает выход из аккаунта и т.п.)
app.use('/vk', express.static(clientDistPath));

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

// Start listening
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`RPS Battle V2 Backend server running on http://localhost:${PORT}`);
});
