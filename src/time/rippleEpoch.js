/**
 * Ripple Epoch time helpers (CJS mirror of rippleEpoch.ts).
 * NEVER pass raw Unix timestamps into FinishAfter or CancelAfter.
 */
'use strict';

const RIPPLE_EPOCH_OFFSET = 946684800;

function unixToRipple(unixSeconds) {
  const sec = unixSeconds > 1e11 ? Math.floor(unixSeconds / 1000) : Math.floor(unixSeconds);
  return sec - RIPPLE_EPOCH_OFFSET;
}

function rippleToUnix(rippleSeconds) {
  return Math.floor(rippleSeconds) + RIPPLE_EPOCH_OFFSET;
}

function rippleNow(date = new Date()) {
  return unixToRipple(Math.floor(date.getTime() / 1000));
}

module.exports = {
  RIPPLE_EPOCH_OFFSET,
  unixToRipple,
  rippleToUnix,
  rippleNow,
};
