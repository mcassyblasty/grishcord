import crypto from 'node:crypto';

function normalize(secret) {
  return String(secret || '').trim();
}

function isPlaceholderSecret(secret) {
  const normalized = normalize(secret).toLowerCase();
  if (!normalized) return true;
  const compact = normalized.replace(/[\s_]/g, '');
  return [
    'change-me',
    'changeme',
    'replace_with_long_random_secret',
    'replacewithlongrandomsecret',
    'bootstrap',
    'bootstrapsecret',
    'rootbootstrapsecret',
    'yourbootstrapsecret'
  ].includes(normalized) || compact.includes('replacewith') || compact.includes('changeme');
}

export function isBootstrapSecretConfigured(secret) {
  const normalized = normalize(secret);
  return normalized.length >= 32 && !isPlaceholderSecret(normalized);
}

export function isBootstrapAuthorized(configuredSecret, providedSecret) {
  const configured = normalize(configuredSecret);
  const provided = normalize(providedSecret);
  if (!isBootstrapSecretConfigured(configured)) return false;
  if (!provided || configured.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(configured), Buffer.from(provided));
}
