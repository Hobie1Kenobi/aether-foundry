'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  RIPPLE_EPOCH_OFFSET,
  unixToRipple,
  rippleToUnix,
  rippleNow,
} = require('./rippleEpoch.js');

describe('rippleEpoch', () => {
  it('offset is 946684800', () => {
    assert.equal(RIPPLE_EPOCH_OFFSET, 946684800);
  });

  it('unixToRipple at Ripple epoch start is 0', () => {
    assert.equal(unixToRipple(946684800), 0);
  });

  it('rippleToUnix(0) is Unix epoch of 2000-01-01', () => {
    assert.equal(rippleToUnix(0), 946684800);
  });

  it('round-trips a known wall time', () => {
    const unix = 1758990000; // mid-2025-ish
    assert.equal(rippleToUnix(unixToRipple(unix)), unix);
  });

  it('accepts millisecond unix inputs', () => {
    assert.equal(unixToRipple(946684800000), 0);
  });

  it('rippleNow is roughly unix_now - offset', () => {
    const before = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;
    const now = rippleNow();
    const after = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;
    assert.ok(now >= before - 1 && now <= after + 1);
  });

  it('documents the scar: Unix-as-Ripple is ~2056', () => {
    const unixNow = Math.floor(Date.now() / 1000);
    const wrongRippleInterpretedAsUnix = unixNow; // if used as FinishAfter raw
    // If ledger treats FinishAfter as Ripple, then actual unlock Unix =
    const unlockUnix = rippleToUnix(wrongRippleInterpretedAsUnix);
    const year = new Date(unlockUnix * 1000).getUTCFullYear();
    assert.ok(year >= 2055 && year <= 2057, `expected ~2056, got ${year}`);
  });
});
