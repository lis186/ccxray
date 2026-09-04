'use strict';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';

function retentionDays(env = process.env) {
  return parseInt(env.LOG_RETENTION_DAYS || '14', 10);
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

module.exports = { retentionDays, retentionCutoffDate, taipeiDate };
