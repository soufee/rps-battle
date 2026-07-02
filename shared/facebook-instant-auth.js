/**
 * Facebook Instant Games — bootstrap auth через FBInstant SDK.
 * Не использует FB.login() / web OAuth.
 *
 * NEZP (Zero Permissions) на WEB: getSignedPlayerInfoAsync недоступен,
 * используем getSignedASIDAsync + SDK 8.0.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]);
}

function extractSignature(signedInfo) {
  if (!signedInfo) return null;
  if (typeof signedInfo.getSignature === 'function') {
    return signedInfo.getSignature();
  }
  return signedInfo.signature || null;
}

function isNonEmptyPlayerId(raw) {
  if (raw === null || raw === undefined) return false;
  const s = String(raw).trim();
  return s.length > 0 && s !== '0';
}

function supportsPlayerAPI(FBInstant, apiName) {
  const apis = FBInstant.getSupportedAPIs?.();
  return Array.isArray(apis) && apis.includes(apiName);
}

function extractPlayerIdFromSigned(signedInfo, identityType) {
  if (!signedInfo) return null;
  if (identityType === 'asid') {
    if (typeof signedInfo.getASID === 'function') return signedInfo.getASID();
    return signedInfo.asid || signedInfo.user_id || null;
  }
  if (typeof signedInfo.getPlayerID === 'function') return signedInfo.getPlayerID();
  return signedInfo.player_id || signedInfo.playerID || null;
}

/** Runtime: платформа facebook-instant, если доступен FBInstant SDK. */
export function detectFacebookInstant() {
  if (typeof window === 'undefined') return false;
  return !!window.FBInstant;
}

/** Ждём появления FBInstant после загрузки fbinstant.js (FB-сборка). */
export async function waitForFBInstant(maxMs = 10000) {
  if (typeof window === 'undefined') return false;
  if (window.FBInstant) return true;
  const isFbBuild = window.__RPS_PLATFORM__ === 'fb';
  if (!isFbBuild) return false;

  const started = Date.now();
  while (Date.now() - started < maxMs) {
    if (window.FBInstant) return true;
    await sleep(80);
  }
  return !!window.FBInstant;
}

function formatFbError(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  const code = err.code != null ? String(err.code) : '';
  const msg = err.message
    || (typeof err.toString === 'function' && err.toString() !== '[object Object]' ? err.toString() : '');
  const parts = [code, msg].filter(Boolean);
  if (parts.length) return parts.join(': ');
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function formatDiagValue(value) {
  if (value == null) return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const formatted = formatFbError(value);
    if (formatted && formatted !== '[object Object]') return formatted;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Снимок состояния FBInstant для диагностики (все поля best-effort).
 */
async function collectFbDiagnostics(FBInstant, extra = {}) {
  const diag = { ts: new Date().toISOString(), ...extra };
  const grab = (key, fn) => {
    try {
      diag[key] = fn();
      if (diag[key] === undefined) diag[key] = null;
    } catch (e) {
      diag[key] = `err:${formatFbError(e)}`;
    }
  };
  grab('platform', () => FBInstant.getPlatform?.());
  grab('sdkVersion', () => FBInstant.getSDKVersion?.());
  grab('locale', () => FBInstant.getLocale?.());
  grab('contextId', () => FBInstant.context?.getID?.());
  grab('contextType', () => FBInstant.context?.getType?.());
  grab('playerIdRaw', () => FBInstant.player?.getID?.());
  grab('playerName', () => FBInstant.player?.getName?.());
  grab('hasGetSignedPlayerInfo', () => supportsPlayerAPI(FBInstant, 'player.getSignedPlayerInfoAsync'));
  grab('hasGetSignedASID', () => supportsPlayerAPI(FBInstant, 'player.getSignedASIDAsync'));
  grab('supportedPlayerAPIs', () => {
    const apis = FBInstant.getSupportedAPIs?.();
    return Array.isArray(apis) ? apis.filter((a) => a.startsWith('player')) : apis;
  });
  grab('supportedAPICount', () => {
    const apis = FBInstant.getSupportedAPIs?.();
    return Array.isArray(apis) ? apis.length : null;
  });
  try {
    diag.entryPoint = FBInstant.getEntryPointAsync
      ? await withTimeout(FBInstant.getEntryPointAsync(), 3000, 'getEntryPointAsync')
      : null;
  } catch (e) {
    diag.entryPoint = `err:${formatFbError(e)}`;
  }
  return diag;
}

async function reportFbDiagnostics(baseUrl, diag) {
  try {
    await withTimeout(
      fetch(`${baseUrl}/api/v2/auth/facebook/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diag),
      }),
      5000,
      'diagnostics report'
    );
  } catch (e) {
    console.warn('[FB Instant] diagnostics report failed:', e.message);
  }
}

async function readPlayerIdWithRetry(FBInstant) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const raw = FBInstant.player?.getID?.();
    if (isNonEmptyPlayerId(raw)) return String(raw).trim();
    if (attempt < 24) await sleep(120);
  }
  return null;
}

/**
 * После startGameAsync(): NEZP/WEB → getSignedASIDAsync, иначе getSignedPlayerInfoAsync.
 */
async function resolveFacebookPlayerIdentity(FBInstant, timeoutMs) {
  const platform = FBInstant.getPlatform?.() || 'UNKNOWN';
  const hasSignedPlayerInfo = supportsPlayerAPI(FBInstant, 'player.getSignedPlayerInfoAsync');
  const hasSignedASID = supportsPlayerAPI(FBInstant, 'player.getSignedASIDAsync');
  const preferASID = hasSignedASID && (!hasSignedPlayerInfo || platform === 'WEB');

  let playerId = await readPlayerIdWithRetry(FBInstant);
  let signature = null;
  let identityType = 'player';
  const errors = {};

  if (preferASID && typeof FBInstant.player.getSignedASIDAsync === 'function') {
    try {
      const signedAsid = await withTimeout(
        FBInstant.player.getSignedASIDAsync(),
        timeoutMs,
        'FBInstant.player.getSignedASIDAsync'
      );
      signature = extractSignature(signedAsid);
      const asid = extractPlayerIdFromSigned(signedAsid, 'asid');
      if (isNonEmptyPlayerId(asid)) {
        playerId = playerId || String(asid).trim();
        identityType = 'asid';
      }
    } catch (err) {
      errors.signedAsid = formatFbError(err);
      console.warn('[FB Instant] getSignedASIDAsync failed:', formatFbError(err));
    }
  }

  if (!signature && hasSignedPlayerInfo && typeof FBInstant.player.getSignedPlayerInfoAsync === 'function') {
    try {
      const signedInfo = await withTimeout(
        FBInstant.player.getSignedPlayerInfoAsync('auth'),
        timeoutMs,
        'FBInstant.getSignedPlayerInfoAsync'
      );
      signature = extractSignature(signedInfo);
      const pid = extractPlayerIdFromSigned(signedInfo, 'player');
      if (isNonEmptyPlayerId(pid)) {
        playerId = playerId || String(pid).trim();
        identityType = 'player';
      }
    } catch (err) {
      errors.signedInfoAuth = formatFbError(err);
      console.warn('[FB Instant] getSignedPlayerInfoAsync failed:', formatFbError(err));
      try {
        const signedInfo = await withTimeout(
          FBInstant.player.getSignedPlayerInfoAsync(),
          timeoutMs,
          'FBInstant.getSignedPlayerInfoAsync()'
        );
        signature = extractSignature(signedInfo);
        const pid = extractPlayerIdFromSigned(signedInfo, 'player');
        if (isNonEmptyPlayerId(pid)) {
          playerId = playerId || String(pid).trim();
          identityType = 'player';
        }
      } catch (err2) {
        errors.signedInfoNoArg = formatFbError(err2);
        console.warn('[FB Instant] getSignedPlayerInfoAsync() retry failed:', formatFbError(err2));
      }
    }
  }

  if (!playerId && typeof FBInstant.player.getASIDAsync === 'function') {
    try {
      const asid = await withTimeout(
        FBInstant.player.getASIDAsync(),
        5000,
        'FBInstant.player.getASIDAsync'
      );
      if (isNonEmptyPlayerId(asid)) {
        playerId = String(asid).trim();
        if (!signature) identityType = 'asid';
      }
    } catch (err) {
      errors.asid = formatFbError(err);
      console.warn('[FB Instant] getASIDAsync failed:', formatFbError(err));
    }
  }

  const name = typeof FBInstant.player.getName === 'function'
    ? FBInstant.player.getName()
    : null;
  const photo = typeof FBInstant.player.getPhoto === 'function'
    ? FBInstant.player.getPhoto()
    : null;

  console.log('[FB Instant] identity', {
    platform,
    identityType,
    preferASID,
    playerId: playerId ? `…${playerId.slice(-4)}` : null,
    hasSignature: !!signature,
    hasName: !!name,
  });

  return {
    playerId,
    signature,
    identityType,
    name,
    photo,
    errors,
    platform,
    hasSignedPlayerInfo,
    hasSignedASID,
    preferASID,
  };
}

/**
 * FB Instant bootstrap (порядок по документации Meta):
 * initializeAsync → setLoadingProgress(100) → startGameAsync → player identity → backend.
 */
export async function bootFacebookInstantAuth({
  baseUrl,
  onProgress,
  timeoutMs = 30000,
}) {
  const FBInstant = window.FBInstant;
  if (!FBInstant) {
    throw new Error('FBInstant is not available');
  }

  onProgress?.(0.2, 'FBInstant.initializeAsync');
  await withTimeout(FBInstant.initializeAsync(), timeoutMs, 'FBInstant.initializeAsync');

  const progressSteps = [15, 35, 55, 75, 90, 100];
  for (const pct of progressSteps) {
    try {
      await FBInstant.setLoadingProgress(pct);
    } catch (_) {}
    onProgress?.(0.2 + pct / 250);
    if (pct < 100) await sleep(40);
  }

  onProgress?.(0.55, 'FBInstant.startGameAsync');
  await withTimeout(FBInstant.startGameAsync(), timeoutMs, 'FBInstant.startGameAsync');

  onProgress?.(0.65, 'resolve player identity');
  const identity = await resolveFacebookPlayerIdentity(FBInstant, timeoutMs);
  const {
    playerId,
    signature,
    identityType,
    name,
    photo,
    errors,
  } = identity;

  if (!playerId && !signature) {
    const diag = await collectFbDiagnostics(FBInstant, {
      stage: 'identity-unavailable-after-startGameAsync',
      identityErrors: errors,
      identityType,
      preferASID: identity.preferASID,
      hasSignedASID: identity.hasSignedASID,
      hasSignedPlayerInfo: identity.hasSignedPlayerInfo,
    });
    console.error('[FB Instant] identity unavailable, full state:', diag);
    await reportFbDiagnostics(baseUrl, diag);
    const summary = [
      `platform=${diag.platform}`,
      `sdk=${diag.sdkVersion}`,
      `entry=${formatDiagValue(diag.entryPoint)}`,
      `contextType=${diag.contextType}`,
      `playerIdRaw=${JSON.stringify(diag.playerIdRaw)}`,
      `identityType=${identityType}`,
      `preferASID=${identity.preferASID}`,
      `signedAsidErr=${errors.signedAsid || null}`,
      `signedInfoErr=${errors.signedInfoAuth || null}`,
      `asidErr=${errors.asid || null}`,
      `playerAPIs=${JSON.stringify(diag.supportedPlayerAPIs)}`,
    ].join(', ');
    throw new Error(
      `Facebook Instant: player id is empty and signed player info is unavailable after startGameAsync. Diagnostics: ${summary}`
    );
  }

  onProgress?.(0.85, 'backend auth');
  const res = await fetch(`${baseUrl}/api/v2/auth/facebook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'facebook_instant',
      identityType,
      playerId: playerId || null,
      signature,
      signedRequest: signature,
      name,
      photo,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Facebook Instant auth HTTP ${res.status}`);
  }

  return res.json();
}