'use strict';

const TAIPEI_TIME_ZONE = 'Asia/Taipei';

function retentionDays(env = process.env) {
  return parseInt(env.LOG_RETENTION_DAYS || '14', 10);
}

function taipeiDate(instant) {
  return new Date(instant).toLocaleString('sv-SE', { timeZone: TAIPEI_TIME_ZONE }).slice(0, 10);
}

function retentionCutoffDate(days, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return taipeiDate(cutoff);
}

module.exports = { retentionDays, retentionCutoffDate, taipeiDate };
