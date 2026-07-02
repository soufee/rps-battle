import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../models/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'rps_jwt_secret_key_random_2026_medium';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'rps_jwt_refresh_secret_key_random_2026_high';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://rps-battles.com';
const VK_APP_SECRET = process.env.VK_APP_SECRET;
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const YANDEX_APP_SECRET = process.env.YANDEX_APP_SECRET;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USER_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
// Same URI as v1 — already whitelisted in Google Cloud Console
const GOOGLE_REDIRECT_URI = `${BASE_URL}/auth/google/callback`;

/** Signed OAuth state (survives Google redirect without cookies). */
function createOAuthState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(nonce)
    .digest('hex')
    .slice(0, 24);
  return `v2.${nonce}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || typeof state !== 'string' || !state.startsWith('v2.')) {
    return false;
  }
  const rest = state.slice(3);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return false;
  const nonce = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{24}$/.test(sig)) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(nonce)
    .digest('hex')
    .slice(0, 24);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function v2CookieOptions() {
  const opts = {
    maxAge: 600000,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  };
  if (process.env.COOKIE_DOMAIN) {
    opts.domain = process.env.COOKIE_DOMAIN;
  }
  return opts;
}

function generateTokens(user) {
  const payload = { id: user.id, nickname: user.nickname, role: user.role };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
}

export function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function loginGoogle(req, res) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google OAuth not configured on server' });
  }
  const state = createOAuthState();
  // Backup for nginx routing; primary router uses v2. prefix in ?state=
  res.cookie('v2_oauth', '1', v2CookieOptions());

  const authUrl = buildGoogleAuthUrl(state);
  res.redirect(authUrl);
}

export async function googleCallback(req, res) {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      throw new Error(String(oauthError));
    }
    if (!code) {
      throw new Error('Отсутствует код авторизации от Google');
    }

    if (!verifyOAuthState(state)) {
      throw new Error('Некорректный state (возможна подмена или устаревшая сессия)');
    }
    const clearOpts = { path: '/' };
    if (process.env.COOKIE_DOMAIN) clearOpts.domain = process.env.COOKIE_DOMAIN;
    res.clearCookie('v2_oauth', clearOpts);

    const body = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', tokenData);
      throw new Error(tokenData.error_description || tokenData.error || 'Google token exchange failed');
    }

    const userRes = await fetch(GOOGLE_USER_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!userRes.ok) {
      throw new Error(googleUser.error?.message || 'Google user info failed');
    }

    const externalId = String(googleUser.id);
    const email = googleUser.email;
    const name = googleUser.name || googleUser.given_name || 'Google User';
    const avatar = googleUser.picture || null;

    // Check if user exists in database, or create them
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { externalId, platform: 'web' },
          { email }
        ]
      }
    });

    if (!user) {
      // Create user and initialize stats
      user = await prisma.user.create({
        data: {
          email,
          nickname: name + '_' + crypto.randomBytes(3).toString('hex'),
          avatarUrl: avatar,
          platform: 'web',
          externalId,
          stats: {
            create: {} // Default stats
          }
        }
      });
    } else {
      // Update existing user properties if needed
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          externalId, // In case they matched by email first
          avatarUrl: avatar || user.avatarUrl
        }
      });
    }

    if (user.isBanned) {
      // Check if ban is expired
      if (user.bannedUntil && new Date() < user.bannedUntil) {
        return res.status(403).send(`Вы забанены до ${user.bannedUntil.toLocaleString()}. Причина: ${user.bannedReason}`);
      } else {
        // Unban
        await prisma.user.update({
          where: { id: user.id },
          data: { isBanned: false, bannedReason: null, bannedUntil: null }
        });
      }
    }

    const { accessToken, refreshToken } = generateTokens(user);

    // Set cookie for browser auth (docs access)
    res.cookie('token', accessToken, {
      ...v2CookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.redirect(`/?token=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`);

  } catch (error) {
    console.error('Google callback error:', error);
    res.status(500).send(`Ошибка аутентификации: ${error.message}`);
  }
}

// --- VK ID (OAuth 2.1 + PKCE) — вход через VK-аккаунт на обычном вебе ---
// Флоу: /api/v2/auth/vkid → id.vk.com/authorize → /auth/vk/callback →
// обмен кода (без client_secret, PKCE) → user_info → JWT как у Google.
const VKID_AUTH_URL = 'https://id.vk.com/authorize';
const VKID_TOKEN_URL = 'https://id.vk.com/oauth2/auth';
const VKID_USER_URL = 'https://id.vk.com/oauth2/user_info';
const VKID_REDIRECT_URI = `${BASE_URL}/auth/vk/callback`;

function signVkidVerifier(verifier) {
  return crypto.createHmac('sha256', JWT_SECRET).update('vkid:' + verifier).digest('hex').slice(0, 24);
}

export async function loginVKID(req, res) {
  const clientId = process.env.VK_APP_ID;
  if (!clientId) {
    return res.status(400).json({ error: 'VK ID is not configured on server (VK_APP_ID)' });
  }

  const state = createOAuthState();
  // PKCE: verifier переживает редирект в подписанной httpOnly-куке
  const verifier = crypto.randomBytes(48).toString('base64url');
  res.cookie('vkid_pkce', `${verifier}.${signVkidVerifier(verifier)}`, v2CookieOptions());

  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'vkid.personal_info',
    redirect_uri: VKID_REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  res.redirect(`${VKID_AUTH_URL}?${params}`);
}

export async function vkidCallback(req, res) {
  try {
    const { code, state, device_id: deviceId, error: oauthError, error_description: errorDesc } = req.query;
    if (oauthError) {
      throw new Error(errorDesc || String(oauthError));
    }
    if (!code) {
      throw new Error('Отсутствует код авторизации от VK ID');
    }
    if (!verifyOAuthState(state)) {
      throw new Error('Некорректный state (возможна подмена или устаревшая сессия)');
    }

    const raw = (req.cookies && req.cookies.vkid_pkce) || '';
    const dot = raw.lastIndexOf('.');
    const verifier = dot > 0 ? raw.slice(0, dot) : '';
    const sig = dot > 0 ? raw.slice(dot + 1) : '';
    if (!verifier || sig !== signVkidVerifier(verifier)) {
      throw new Error('Сессия авторизации истекла — попробуйте войти ещё раз');
    }
    const clearOpts = { path: '/' };
    if (process.env.COOKIE_DOMAIN) clearOpts.domain = process.env.COOKIE_DOMAIN;
    res.clearCookie('vkid_pkce', clearOpts);

    const tokenRes = await fetch(VKID_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        code_verifier: verifier,
        client_id: process.env.VK_APP_ID,
        device_id: String(deviceId || ''),
        redirect_uri: VKID_REDIRECT_URI,
        state: String(state)
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      console.error('VK ID token exchange failed:', tokenData);
      throw new Error(tokenData.error_description || tokenData.error || 'VK ID token exchange failed');
    }

    // Имя/аватар — косметика: если user_info недоступен, входим по user_id из токена
    let vkUser = {};
    try {
      const userRes = await fetch(VKID_USER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.VK_APP_ID,
          access_token: tokenData.access_token
        })
      });
      const userData = await userRes.json();
      if (userRes.ok && userData.user) vkUser = userData.user;
    } catch (e) {
      console.warn('VK ID user_info failed:', e.message);
    }

    const externalId = String(vkUser.user_id || tokenData.user_id || '');
    if (!externalId) {
      throw new Error('VK ID не вернул идентификатор пользователя');
    }

    // Тот же platform/externalId, что и у входа из VK Mini Apps:
    // один VK-аккаунт = один и тот же игрок в игре и в вебе
    let user = await prisma.user.findFirst({ where: { externalId, platform: 'vk' } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: `${vkUser.first_name || 'VK'}_${vkUser.last_name || 'User'}_${crypto.randomBytes(3).toString('hex')}`,
          avatarUrl: vkUser.avatar || null,
          platform: 'vk',
          externalId,
          stats: { create: {} }
        }
      });
    }

    if (user.isBanned && user.bannedUntil && new Date() < user.bannedUntil) {
      return res.status(403).send(`Вы забанены до ${user.bannedUntil.toLocaleString()}. Причина: ${user.bannedReason}`);
    }

    const { accessToken, refreshToken } = generateTokens(user);
    res.cookie('token', accessToken, {
      ...v2CookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.redirect(`/?token=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`);
  } catch (error) {
    console.error('VK ID callback error:', error);
    res.status(500).send(`Ошибка входа через VK ID: ${error.message}`);
  }
}

// --- Facebook Login (OAuth) — вход через FB-аккаунт на обычном вебе ---
// Флоу: /api/v2/auth/facebook-web → facebook.com/dialog/oauth → /auth/facebook/callback →
// обмен кода → /me → JWT. Тот же platform/externalId, что у Facebook Instant Games.
const FB_AUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/v21.0/oauth/access_token';
const FB_USER_URL = 'https://graph.facebook.com/v21.0/me';
const FB_REDIRECT_URI = `${BASE_URL}/auth/facebook/callback`;

export async function loginFacebookWeb(req, res) {
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(400).json({ error: 'Facebook OAuth is not configured on server (FB_APP_ID / FB_APP_SECRET)' });
  }

  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: FB_APP_ID,
    redirect_uri: FB_REDIRECT_URI,
    state,
    scope: 'public_profile',
    response_type: 'code'
  });
  res.redirect(`${FB_AUTH_URL}?${params}`);
}

export async function facebookWebCallback(req, res) {
  try {
    const { code, state, error: oauthError, error_description: errorDesc } = req.query;
    if (oauthError) {
      throw new Error(errorDesc || String(oauthError));
    }
    if (!code) {
      throw new Error('Отсутствует код авторизации от Facebook');
    }
    if (!verifyOAuthState(state)) {
      throw new Error('Некорректный state (возможна подмена или устаревшая сессия)');
    }

    const tokenRes = await fetch(
      `${FB_TOKEN_URL}?${new URLSearchParams({
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: FB_REDIRECT_URI,
        code: String(code)
      })}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Facebook token exchange failed:', tokenData);
      throw new Error(tokenData.error?.message || tokenData.error || 'Facebook token exchange failed');
    }

    const userRes = await fetch(
      `${FB_USER_URL}?${new URLSearchParams({
        fields: 'id,name,picture.type(large)',
        access_token: tokenData.access_token
      })}`
    );
    const fbUser = await userRes.json();
    if (!userRes.ok || !fbUser.id) {
      console.error('Facebook user info failed:', fbUser);
      throw new Error(fbUser.error?.message || 'Facebook user info failed');
    }

    const externalId = String(fbUser.id);
    const avatar = fbUser.picture?.data?.url || null;

    let user = await prisma.user.findFirst({ where: { externalId, platform: 'facebook' } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: `${fbUser.name || 'FB_Player'}_${crypto.randomBytes(3).toString('hex')}`,
          avatarUrl: avatar,
          platform: 'facebook',
          externalId,
          stats: { create: {} }
        }
      });
    } else if (avatar && avatar !== user.avatarUrl) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: avatar }
      });
    }

    if (user.isBanned && user.bannedUntil && new Date() < user.bannedUntil) {
      return res.status(403).send(`Вы забанены до ${user.bannedUntil.toLocaleString()}. Причина: ${user.bannedReason}`);
    }

    const { accessToken, refreshToken } = generateTokens(user);
    res.cookie('token', accessToken, {
      ...v2CookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.redirect(`/?token=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`);
  } catch (error) {
    console.error('Facebook web callback error:', error);
    res.status(500).send(`Ошибка входа через Facebook: ${error.message}`);
  }
}

export async function refresh(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });

    if (!user || user.isBanned) {
      return res.status(403).json({ error: 'User not found or banned' });
    }

    const tokens = generateTokens(user);
    res.cookie('token', tokens.accessToken, {
      ...v2CookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    res.json(tokens);
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired refresh token' });
  }
}

export async function status(req, res) {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        stats: true,
        botOpponentStats: {
          orderBy: [{ gamesPlayed: 'desc' }, { lastPlayedAt: 'desc' }]
        },
        pvpOpponentStats: {
          orderBy: [{ gamesPlayed: 'desc' }, { lastPlayedAt: 'desc' }],
          include: {
            opponent: {
              select: { id: true, nickname: true, avatarUrl: true }
            }
          }
        }
      }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Auto-transition stage 0 to version 2
    if (user.stats && user.stats.tournamentStage === 0 && user.stats.tournamentVersion !== 2) {
      const updatedStats = await prisma.stats.update({
        where: { userId: user.id },
        data: { tournamentVersion: 2 }
      });
      user.stats = updatedStats;
    }

    res.json({ authenticated: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function devLogin(req, res) {
  // Разрешён ТОЛЬКО при явном NODE_ENV=development: если переменная не задана
  // (например, на боевом сервере), вход закрыт по умолчанию.
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('Forbidden: Dev login is only allowed in development mode');
  }
  try {
    let user = await prisma.user.findFirst({
      where: { nickname: 'DevTester' }
    });
    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: 'DevTester',
          email: 'dev@test.local',
          avatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80',
          platform: 'web',
          externalId: 'dev_tester_123',
          role: 'admin',
          stats: {
            create: {
              ratingMmr: 1200,
              wins: 10,
              losses: 5,
              draws: 2
            }
          }
        }
      });
    }

    const { accessToken, refreshToken } = generateTokens(user);
    res.cookie('token', accessToken, {
      ...v2CookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    // CLIENT_URL: dev-only redirect target when client runs on a separate dev server (e.g. Expo on :8081)
    const clientUrl = process.env.CLIENT_URL || '';
    res.redirect(`${clientUrl}/?token=${accessToken}&refreshToken=${refreshToken}`);
  } catch (error) {
    res.status(500).send(`Dev Auth Error: ${error.message}`);
  }
}

// --- VK, Facebook, Apple SDK and Native Auth Stubs ---

export async function nativeAuthGoogle(req, res) {
  // Mobile client passes idToken from native SDK
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken is required' });

  try {
    // Stub validation: in production, validate with google-auth-library
    // For now we mock it to show extensibility
    const mockGoogleId = 'native_goog_' + crypto.randomBytes(8).toString('hex');
    const nickname = 'GoogleNativePlayer_' + crypto.randomBytes(3).toString('hex');

    let user = await prisma.user.findFirst({
      where: { externalId: mockGoogleId, platform: 'android' },
      include: { stats: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname,
          platform: 'android',
          externalId: mockGoogleId,
          stats: { create: {} }
        },
        include: { stats: true }
      });
    }

    const tokens = generateTokens(user);
    res.json({ user, ...tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function authVKMiniApp(req, res) {
  // VK passes launching query params with sign verification
  const { sign, vk_user_id, vk_app_id, first_name, last_name, photo_200 } = req.body;
  if (!sign || !vk_user_id) return res.status(400).json({ error: 'sign and vk_user_id are required' });

  // Validate VK launching params sign
  if (VK_APP_SECRET) {
    if (!verifyVKSign(req.body, VK_APP_SECRET)) {
      return res.status(401).json({ error: 'Invalid VK Mini App signature' });
    }
    // Если задан VK_APP_ID — дополнительно сверяем, что запуск был из нашего приложения
    if (process.env.VK_APP_ID && String(vk_app_id) !== String(process.env.VK_APP_ID)) {
      return res.status(401).json({ error: 'VK app id mismatch' });
    }
  } else {
    console.warn('VK_APP_SECRET is not configured — accepting VK login without signature check.');
  }

  try {
    const externalId = String(vk_user_id);
    let user = await prisma.user.findFirst({
      where: { externalId, platform: 'vk' },
      include: { stats: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: `${first_name || 'VK'}_${last_name || 'User'}_${crypto.randomBytes(3).toString('hex')}`,
          avatarUrl: photo_200 || null,
          platform: 'vk',
          externalId,
          stats: { create: {} }
        },
        include: { stats: true }
      });
    }

    const tokens = generateTokens(user);
    res.json({ user, ...tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Проверка подписи параметров запуска VK Mini Apps.
 * Алгоритм (официальный пример VKCOM/vk-apps-launch-params):
 * vk_-параметры сортируются по ключу, собираются в строку
 * key=encodeURIComponent(value)&..., подписываются HMAC-SHA256 секретным
 * ключом приложения, результат кодируется base64url (без хвостовых '=').
 */
function verifyVKSign(params, secret) {
  const sign = params.sign;
  if (!sign || typeof sign !== 'string') return false;

  const queryStr = Object.keys(params)
    .filter(key => key.startsWith('vk_') && typeof params[key] === 'string')
    .sort((a, b) => a.localeCompare(b))
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');
  if (!queryStr) return false;

  const calculatedSign = crypto
    .createHmac('sha256', secret)
    .update(queryStr)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const normalizedSign = sign.replace(/=+$/, '');

  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSign, 'utf8'), Buffer.from(normalizedSign, 'utf8'));
  } catch {
    return false;
  }
}

export async function authFacebookInstant(req, res) {
  const { signedRequest, signature, playerId, name, photo, provider, identityType } = req.body;
  const signed = signedRequest || signature;

  let externalId = playerId ? String(playerId).trim() : null;
  if (externalId === '' || externalId === '0') externalId = null;

  let fbData = null;

  if (signed) {
    fbData = verifyFacebookSignedRequest(signed, FB_APP_SECRET);
    if (!fbData) {
      console.error('[FB Instant auth] invalid signature', {
        identityType: identityType || 'player',
        hasPlayerId: !!externalId,
      });
      return res.status(401).json({ error: 'Invalid Facebook signedRequest signature' });
    }
    const signedPlayerId = String(
      fbData.player_id || fbData.user_id || fbData.asid || ''
    ).trim();
    if (signedPlayerId && signedPlayerId !== '0') {
      if (externalId && externalId !== signedPlayerId) {
        return res.status(401).json({ error: 'playerId does not match signed payload' });
      }
      externalId = signedPlayerId;
    }
  }

  if (!externalId) {
    if (FB_APP_SECRET) {
      return res.status(400).json({
        error: provider === 'facebook_instant'
          ? 'Valid signature is required when playerId is empty (Facebook Instant Games)'
          : 'signature (signedRequest) is required for Facebook Instant auth',
      });
    }
    if (!playerId) {
      return res.status(400).json({ error: 'playerId or signature is required' });
    }
    externalId = String(playerId);
  }

  try {
    let user = await prisma.user.findFirst({
      where: { externalId, platform: 'facebook' },
      include: { stats: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: `${name || 'FB_Player'}_${crypto.randomBytes(3).toString('hex')}`,
          avatarUrl: photo || null,
          platform: 'facebook',
          externalId,
          stats: { create: {} }
        },
        include: { stats: true }
      });
    } else if (photo && photo !== user.avatarUrl) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: photo },
        include: { stats: true }
      });
    }

    const tokens = generateTokens(user);
    res.json({ user, ...tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function verifyFacebookSignedRequest(signedRequest, secret) {
  if (!secret) {
    console.warn('FB_APP_SECRET is not configured. Using fallback player_id.');
    return { player_id: 'fb_mock_' + crypto.randomBytes(8).toString('hex') };
  }

  const parts = signedRequest.split('.');
  if (parts.length !== 2) {
    console.error('FB auth failed: signedRequest split length !== 2');
    return null;
  }

  const [encodedSig, payload] = parts;

  // Decode signature and payload from base64url
  const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const decodedPayloadText = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  
  let data;
  try {
    data = JSON.parse(decodedPayloadText);
  } catch (e) {
    console.error('FB auth failed: failed to parse JSON payload', e.message);
    return null;
  }

  if (data.algorithm !== 'HMAC-SHA256') {
    console.error('FB auth failed: algorithm mismatch', data.algorithm);
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest();

  try {
    if (crypto.timingSafeEqual(sig, expectedSig)) {
      return data;
    }
  } catch (e) {
    console.error('FB auth failed: timingSafeEqual error', e.message);
    return null;
  }

  console.error('FB auth failed: signature mismatch');
  return null;
}

/**
 * Гостевой вход: анонимный аккаунт, привязанный к deviceId, который клиент
 * генерирует один раз и хранит локально. Основной способ входа на iOS/Android.
 */
export async function authGuest(req, res) {
  const { deviceId, platform } = req.body;
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 128) {
    return res.status(400).json({ error: 'deviceId is required (8-128 chars)' });
  }
  const allowedPlatforms = ['web', 'android', 'ios'];
  const plat = allowedPlatforms.includes(platform) ? platform : 'web';

  try {
    const externalId = `guest:${deviceId}`;
    let user = await prisma.user.findFirst({
      where: { externalId, platform: plat },
      include: { stats: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: 'Гость_' + crypto.randomBytes(3).toString('hex'),
          platform: plat,
          externalId,
          stats: { create: {} }
        },
        include: { stats: true }
      });
    }

    if (user.isBanned && user.bannedUntil && new Date() < user.bannedUntil) {
      return res.status(403).json({ error: `User is banned: ${user.bannedReason}` });
    }

    const tokens = generateTokens(user);
    res.json({ user, ...tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Яндекс Игры: клиент передаёт данные игрока из ysdk.getPlayer({ signed: true }).
 * Если задан YANDEX_APP_SECRET, проверяем подпись формата "<hmac>.<base64(json)>".
 */
export async function authYandexGames(req, res) {
  const { signature, id, name, avatar } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  let externalId = String(id);
  let verifiedName = name || null;
  let verifiedAvatar = avatar || null;

  if (YANDEX_APP_SECRET) {
    const data = verifyYandexSignature(signature, YANDEX_APP_SECRET);
    if (!data) {
      return res.status(401).json({ error: 'Invalid Yandex Games signature' });
    }
    // Доверяем только подписанным данным
    if (data.playerId || data.uniqueID || data.id) {
      externalId = String(data.playerId || data.uniqueID || data.id);
    }
    if (data.name) verifiedName = data.name;
    if (data.avatar || data.photo) verifiedAvatar = data.avatar || data.photo;
  } else if (signature) {
    console.warn('YANDEX_APP_SECRET is not configured — accepting Yandex player without signature check.');
  }

  try {
    let user = await prisma.user.findFirst({
      where: { externalId, platform: 'yandex' },
      include: { stats: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          nickname: (verifiedName || 'Yandex_Player') + '_' + crypto.randomBytes(3).toString('hex'),
          avatarUrl: verifiedAvatar,
          platform: 'yandex',
          externalId,
          stats: { create: {} }
        },
        include: { stats: true }
      });
    }

    if (user.isBanned && user.bannedUntil && new Date() < user.bannedUntil) {
      return res.status(403).json({ error: `User is banned: ${user.bannedReason}` });
    }

    const tokens = generateTokens(user);
    res.json({ user, ...tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function verifyYandexSignature(signature, secret) {
  if (!signature || typeof signature !== 'string') return null;
  const dot = signature.indexOf('.');
  if (dot <= 0) return null;

  const sig = signature.slice(0, dot);
  const payload = signature.slice(dot + 1);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const normalizedSig = sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(normalizedSig, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export async function mintToken(req, res) {
  const localIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  if (!localIps.includes(req.ip)) {
    return res.status(403).json({ error: 'Access denied: local loopback only' });
  }

  const { email, id: externalId, name, avatar } = req.body;
  if (!email || !externalId) {
    return res.status(400).json({ error: 'Email and ID are required' });
  }

  try {
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { externalId, platform: 'web' },
          { email }
        ]
      }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          nickname: name + '_' + crypto.randomBytes(3).toString('hex'),
          avatarUrl: avatar || null,
          platform: 'web',
          externalId,
          stats: {
            create: {}
          }
        }
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          externalId,
          avatarUrl: avatar || user.avatarUrl
        }
      });
    }

    if (user.isBanned) {
      if (user.bannedUntil && new Date() < user.bannedUntil) {
        return res.status(403).json({ error: `User is banned: ${user.bannedReason}` });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { isBanned: false, bannedReason: null, bannedUntil: null }
        });
      }
    }

    const { accessToken, refreshToken } = generateTokens(user);
    res.json({ accessToken, refreshToken });
  } catch (error) {
    console.error('Error in mintToken:', error);
    res.status(500).json({ error: error.message });
  }
}
