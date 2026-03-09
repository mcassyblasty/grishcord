const BURST_WINDOW_MS = 5 * 1000;
const SUSTAINED_WINDOW_MS = 60 * 1000;

export function resolveAntiSpamPreset(level, presets, fallbackLevel = 5) {
  const numeric = Number(level);
  if (numeric <= 0) return null;
  return presets[numeric] || presets[fallbackLevel] || null;
}

export function enforceAntiSpamForUser(stateMap, userId, preset, nowMs = Date.now()) {
  if (!preset) return { ok: true };
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { ok: true };

  const entry = stateMap.get(uid) || { burstHits: [], sustainedHits: [], blockedUntil: 0 };
  const now = Number(nowMs);

  if (entry.blockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    stateMap.set(uid, entry);
    return { ok: false, retryAfterSeconds };
  }

  entry.burstHits = entry.burstHits.filter((t) => now - t < BURST_WINDOW_MS);
  entry.sustainedHits = entry.sustainedHits.filter((t) => now - t < SUSTAINED_WINDOW_MS);

  const burstExceeded = entry.burstHits.length >= Number(preset.burst || 0);
  const sustainedExceeded = entry.sustainedHits.length >= Number(preset.sustained || 0);
  if (burstExceeded || sustainedExceeded) {
    entry.blockedUntil = now + (Number(preset.cooldown || 0) * 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    stateMap.set(uid, entry);
    return { ok: false, retryAfterSeconds, reason: burstExceeded ? 'burst' : 'sustained' };
  }

  entry.burstHits.push(now);
  entry.sustainedHits.push(now);
  entry.blockedUntil = 0;
  stateMap.set(uid, entry);
  return { ok: true };
}
