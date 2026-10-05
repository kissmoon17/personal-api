// Input validation for manual writes.
// Each validator returns { ok, errors, value }. Only `value` (cleaned, with
// unknown fields dropped) should ever be sent to the database.

const MIN_DATE = '2000-01-01';
const MAX_MINUTES_PER_DAY = 1440;
const MAX_SOURCE_LENGTH = 50;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// "Today" in Nepal (UTC+5:45), as YYYY-MM-DD. Entries dated after it are rejected.
function todayInKathmandu(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

// Real calendar date in strict YYYY-MM-DD form (rejects 2026-02-30, 10/02/2026, ...).
function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function checkDate(value, errors, now) {
  if (!isRealDate(value)) {
    errors.push('date must be a real calendar date formatted YYYY-MM-DD');
    return null;
  }
  if (value < MIN_DATE) {
    errors.push(`date must be ${MIN_DATE} or later`);
    return null;
  }
  if (value > todayInKathmandu(now)) {
    errors.push('date cannot be in the future');
    return null;
  }
  return value;
}

function checkSource(value, errors) {
  if (value === undefined || value === null) return 'manual';
  if (typeof value !== 'string') {
    errors.push('source must be a string');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_LENGTH || !/^[A-Za-z0-9 _.:-]+$/.test(trimmed)) {
    errors.push(`source must be 1-${MAX_SOURCE_LENGTH} characters: letters, numbers, spaces, and _ . : -`);
    return null;
  }
  return trimmed;
}

function checkMinutes(value, name, errors, { required }) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${name} is required`);
    return required ? null : 0;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_MINUTES_PER_DAY) {
    errors.push(`${name} must be a whole number of minutes from 0 to ${MAX_MINUTES_PER_DAY}`);
    return null;
  }
  return value;
}

function validateSleepInput(body, now = new Date()) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be a JSON object'], value: null };
  }

  const date = checkDate(body.date, errors, now);

  let hours_slept = null;
  if (!isFiniteNumber(body.hours_slept) || body.hours_slept < 0 || body.hours_slept > 24) {
    errors.push('hours_slept must be a number from 0 to 24');
  } else {
    hours_slept = body.hours_slept;
  }

  let quality = null;
  if (!isFiniteNumber(body.quality) || body.quality < 0 || body.quality > 1) {
    errors.push('quality must be a number from 0 to 1');
  } else {
    quality = body.quality;
  }

  const source = checkSource(body.source, errors);

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? { date, hours_slept, quality, source } : null
  };
}

function validateScreenTimeInput(body, now = new Date()) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be a JSON object'], value: null };
  }

  const date = checkDate(body.date, errors, now);
  const total_minutes = checkMinutes(body.total_minutes, 'total_minutes', errors, { required: true });
  const work_minutes = checkMinutes(body.work_minutes, 'work_minutes', errors, { required: false });
  const social_minutes = checkMinutes(body.social_minutes, 'social_minutes', errors, { required: false });
  const entertainment_minutes = checkMinutes(body.entertainment_minutes, 'entertainment_minutes', errors, { required: false });
  const source = checkSource(body.source, errors);

  if (errors.length === 0 && work_minutes + social_minutes + entertainment_minutes > total_minutes) {
    errors.push('work_minutes + social_minutes + entertainment_minutes cannot exceed total_minutes');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0
      ? { date, total_minutes, work_minutes, social_minutes, entertainment_minutes, source }
      : null
  };
}

module.exports = {
  validateSleepInput,
  validateScreenTimeInput,
  isRealDate,
  todayInKathmandu
};
