'use strict';

// Pure, timezone-local calendar helpers for persisted chat timestamps.
// Kept browser/Node compatible so transitions can be unit-tested without a DOM.
(function attachMessageDateUtils(root) {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function asDate(timestamp) {
    const date = timestamp instanceof Date ? new Date(timestamp.getTime()) : new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function dayKey(timestamp) {
    const date = asDate(timestamp);
    if (!date) return null;
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function calendarOrdinal(date) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
  }

  function dayLabel(timestamp, now) {
    const date = asDate(timestamp);
    const current = asDate(now === undefined ? new Date() : now);
    if (!date || !current) return '';

    const daysAgo = calendarOrdinal(current) - calendarOrdinal(date);
    if (daysAgo === 0) return '';
    if (daysAgo === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const api = Object.freeze({ dayKey, dayLabel });
  if (root) root.AAMessageDateUtils = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
