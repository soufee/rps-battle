/**
 * Общие хелперы platform-auth: детекция окружения без смешивания VK / FB / web.
 */

/** VK Mini Apps передаёт vk_user_id и sign в query при запуске из iframe VK. */
export function hasVkLaunchParams(search) {
  if (typeof window === 'undefined' && !search) return false;
  const qs = search ?? window.location?.search ?? '';
  const params = new URLSearchParams(qs);
  return !!(params.get('vk_user_id') && params.get('sign'));
}

export function isVkEntryPath() {
  if (typeof window === 'undefined' || !window.location) return false;
  return /^\/vk(\/|$)/.test(window.location.pathname);
}

/** Активная VK platform-сессия: путь /vk И подписанные launch params. */
export function isVkPlatformSession() {
  return isVkEntryPath() && hasVkLaunchParams();
}

/**
 * facebook-instant: только когда реально доступен FBInstant SDK.
 * Не путаем с web OAuth Facebook.
 */
export function isFacebookInstantRuntime() {
  if (typeof window === 'undefined') return false;
  return !!window.FBInstant;
}

export function detectPlatform() {
  if (isVkPlatformSession()) return 'vk';
  if (isFacebookInstantRuntime()) return 'facebook-instant';
  return 'web';
}