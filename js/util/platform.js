// Platform detection helpers.
export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
