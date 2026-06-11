import jwt from 'jsonwebtoken';
import prisma from '../models/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'rps_jwt_secret_key_random_2026_medium';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token && req.cookies) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired access token' });
    }
    req.user = user;
    next();
  });
}

export async function requireDocsAuth(req, res, next) {
  let token = req.cookies && req.cookies.token;
  if (!token) {
    const authHeader = req.headers['authorization'];
    token = authHeader && authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).send('Необходима авторизация. Войдите в игру на главной странице.');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (user && user.email === 'irozoyicawoy97@gmail.com') {
      req.user = user;
      return next();
    }
    return res.status(403).send('Доступ запрещен. Этот раздел доступен только пользователю irozoyicawoy97@gmail.com.');
  } catch (err) {
    return res.status(403).send('Неверный или просроченный токен авторизации.');
  }
}

export function socketAuthenticate(socket, next) {
  // Check token in handshake auth or headers
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

  if (!token) {
    return next(new Error('AUTH_REQUIRED'));
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return next(new Error('INVALID_TOKEN'));
    }
    socket.user = user;
    next();
  });
}

