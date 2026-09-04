'use strict';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';

// A window this wide cannot exclude anything, so a value beyond it means "retain
// everything" — and must be treated as retention OFF rather than fed to the cutoff
// calculation. Feeding it through produces an out-of-range Date, and the string that
// used to fall out of that ("Invalid Da") compares ABOVE every real Taipei-dated
// filename ('I' is 73, '2' is 50), so `filename.slice(0, 10) >= cutoffStr` was
// false for every file: a
// plausible "never prune" setting of LOG_RETENTION_DAYS=999999999 silently pruned
// EVERYTHING. NaN here lands on the same safe no-op path a non-numeric setting takes
// (`pruneLogs` returns on `!days`, restore skips its window on `days > 0`).
const MAX_RETENTION_DAYS = 36500; // ~100 years

// Every day-count entry point must go through this. Guarding only
// LOG_RETENTION_DAYS left an explicit RESTORE_DAYS on bare parseInt, so
// RESTORE_DAYS=999999999 still reached the cutoff calculation.
function boundedDays(raw) {
  const parsed = parseInt(raw, 10);
  return Math.abs(parsed) > MAX_RETENTION_DAYS ? NaN : parsed;
}

function retentionDays(env = process.env) {
  return boundedDays(env.LOG_RETENTION_DAYS || '14');
}

function taipeiDate(instant) {
  return new Date(instant).toLocaleString('sv-SE', { timeZone: TAIPEI_TIME_ZONE }).slice(0, 10);
}

function retentionCutoffDate(days, now = new Date()) {
  // The subtraction happens in the TAIPEI calendar, because that is the calendar
  // the result is compared against: index filenames and entry ids are Taipei-dated
  // (`filename.slice(0, 10) >= cutoffStr`). Subtracting with the host's local
  // getDate()/setDate() and only THEN formatting in Taipei splits the calculation
  // across two calendars, and the two disagree by a day whenever the host zone
  // crosses a DST boundary in the window — a Los Angeles host would prune one
  // extra Taipei-dated day. Anchoring to the Taipei date first makes the result
  // depend only on `now` and `days`, never on where the process runs.
  const [year, month, day] = taipeiDate(now).split('-').map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  anchor.setUTCDate(anchor.getUTCDate() - days);
  return anchor.toISOString().slice(0, 10);
}

module.exports = { retentionDays, retentionCutoffDate, taipeiDate, boundedDays, MAX_RETENTION_DAYS };
