import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate } from './date.mjs';

test('localDate: 手元の日付を YYYY-MM-DD で返す（UTC ではない）', () => {
  const d = new Date(2026, 9, 13, 1, 30); // 手元の時刻で 10月13日 1:30
  assert.equal(localDate(d), '2026-10-13');
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});
