/**
 * Ripple Epoch time helpers.
 *
 * XRPL FinishAfter / CancelAfter / ledger close times use seconds since
 * 2000-01-01T00:00:00Z (Ripple Epoch), NOT Unix epoch.
 *
 * Offset: Unix = Ripple + 946684800
 * NEVER pass raw Unix timestamps into FinishAfter or CancelAfter.
 */

export const RIPPLE_EPOCH_OFFSET = 946684800;

/** Convert Unix seconds (or ms if > 1e12) to Ripple Epoch seconds. */
export function unixToRipple(unixSeconds: number): number {
  const sec = unixSeconds > 1e11 ? Math.floor(unixSeconds / 1000) : Math.floor(unixSeconds);
  return sec - RIPPLE_EPOCH_OFFSET;
}

/** Convert Ripple Epoch seconds to Unix seconds. */
export function rippleToUnix(rippleSeconds: number): number {
  return Math.floor(rippleSeconds) + RIPPLE_EPOCH_OFFSET;
}

/** Current ledger-wall time as Ripple Epoch seconds. */
export function rippleNow(date: Date = new Date()): number {
  return unixToRipple(Math.floor(date.getTime() / 1000));
}
