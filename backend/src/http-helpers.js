export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function parsePositiveId(raw, field = 'id') {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `invalid_${field}`);
  return n;
}

export function requireStringField(body, field, { min = 1, max = 2000, trim = true } = {}) {
  const raw = body?.[field];
  if (typeof raw !== 'string') throw new HttpError(400, `${field}_required`);
  const value = trim ? raw.trim() : raw;
  if (value.length < min) throw new HttpError(400, `${field}_required`);
  if (value.length > max) throw new HttpError(400, `${field}_too_long`);
  return value;
}

export function optionalStringField(body, field, { max = 2000, trim = true, fallback = '' } = {}) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') throw new HttpError(400, `invalid_${field}`);
  const value = trim ? raw.trim() : raw;
  if (value.length > max) throw new HttpError(400, `${field}_too_long`);
  return value;
}

export function validateUsername(value) {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(value)) {
    throw new HttpError(400, 'invalid_username');
  }
  return value;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new HttpError(400, 'invalid_password');
  }
  return value;
}
