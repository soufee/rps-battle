/**
 * itch.io OAuth (implicit flow) for the browser build.
 *
 * itch does NOT hand identity to an embedded HTML5 game automatically, and it
 * does not provide a JS SDK. The reliable pattern is:
 *   1. open a popup to itch's OAuth authorize page (needs a user gesture);
 *   2. itch redirects the popup to our backend callback page with the
 *      access_token in the URL hash;
 *   3. the callback page postMessage's the token back to this window;
 *   4. we send the token to our backend, which verifies it against the itch
 *      API and mints our own JWT (authorized, non-guest).
 *
 * A full-page redirect is intentionally NOT used: on itch the game runs in a
 * sandboxed iframe on a churning subdomain, so a stable redirect_uri can only
 * live on our own backend.
 */

export function isItchRuntime() {
  return typeof window !== 'undefined'
    && window.__RPS_PLATFORM__ === 'itch';
}

export function getItchClientId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.__ITCH_CLIENT_ID__ || '';
}

function randomState() {
  const cryptoObj = typeof window !== 'undefined'
    ? (window.crypto || window.msCrypto)
    : null;
  if (cryptoObj && cryptoObj.getRandomValues) {
    const arr = new Uint8Array(16);
    cryptoObj.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Run the full itch login. MUST be called from a user gesture (click) so the
 * browser allows the popup. Resolves with { user, accessToken, refreshToken }.
 */
export async function startItchLogin({ baseUrl }) {
  const clientId = getItchClientId();
  if (!clientId) {
    throw new Error('itch client_id is not configured');
  }

  const redirectUri = `${baseUrl}/auth/itch/callback`;
  const state = randomState();
  const authUrl = 'https://itch.io/user/oauth'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent('profile:me')}`
    + '&response_type=token'
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;

  const backendOrigin = new URL(baseUrl).origin;
  const accessToken = await openOAuthPopup(authUrl, backendOrigin, state);

  // Exchange the itch token for our app JWT (backend verifies via api.itch.io).
  const res = await fetch(`${baseUrl}/api/v2/auth/itch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `itch auth HTTP ${res.status}`);
  }
  return res.json();
}

function openOAuthPopup(authUrl, backendOrigin, state) {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      authUrl,
      'itch_oauth',
      'width=520,height=680,menubar=no,toolbar=no,location=yes'
    );
    if (!popup) {
      reject(new Error('popup_blocked'));
      return;
    }

    let settled = false;
    const onMessage = (event) => {
      if (event.origin !== backendOrigin) {
        return;
      }
      const data = event.data;
      if (!data || data.type !== 'itch-oauth' || data.state !== state) {
        return;
      }
      settled = true;
      cleanup();
      try {
        popup.close();
      } catch (_) {
        // ignore
      }
      if (data.accessToken) {
        resolve(data.accessToken);
      } else {
        reject(new Error(data.error || 'itch_oauth_failed'));
      }
    };

    const closeTimer = setInterval(() => {
      if (popup.closed && !settled) {
        cleanup();
        reject(new Error('popup_closed'));
      }
    }, 500);

    function cleanup() {
      window.removeEventListener('message', onMessage);
      clearInterval(closeTimer);
    }

    window.addEventListener('message', onMessage);
  });
}
