'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dayKey, dayLabel } = require('../public/message-date-utils');

test('dayKey groups persisted timestamps by the browser-local calendar date', () => {
  const morning = new Date(2026, 9, 25, 0, 5);
  const evening = new Date(2026, 9, 25, 23, 55);
  const nextDay = new Date(2026, 9, 26, 0, 1);

  assert.equal(dayKey(morning.toISOString()), dayKey(evening.toISOString()));
  assert.notEqual(dayKey(morning.toISOString()), dayKey(nextDay.toISOString()));
});

test('current-day messages have no Today separator', () => {
  const now = new Date(2026, 9, 25, 12, 0);
  const today = new Date(2026, 9, 25, 0, 1);

  assert.equal(dayLabel(today.toISOString(), now), '');
});

test('yesterday is a calendar day, not a rolling 24-hour window', () => {
  const now = new Date(2026, 9, 25, 2, 0);
  const lateYesterday = new Date(2026, 9, 24, 23, 59);
  const earlyYesterday = new Date(2026, 9, 24, 0, 1);

  assert.equal(dayLabel(lateYesterday.toISOString(), now), 'Yesterday');
  assert.equal(dayLabel(earlyYesterday.toISOString(), now), 'Yesterday');
});

test('older dates include the year and remain based on the stored timestamp', () => {
  const now = new Date(2026, 9, 25, 12, 0);
  const older = new Date(2024, 0, 9, 21, 30);
  const label = dayLabel(older.toISOString(), now);

  assert.match(label, /2024/);
  assert.notEqual(label, 'Today');
  assert.notEqual(label, 'Yesterday');
  assert.equal(dayKey(older.toISOString()), dayKey(older));
});

test('invalid timestamps do not create a date group or label', () => {
  assert.equal(dayKey('not-a-timestamp'), null);
  assert.equal(dayLabel('not-a-timestamp', new Date(2026, 9, 25)), '');
});
