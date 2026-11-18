'use strict';

// Whole coins and base units (satoshi, wei), with bigint arithmetic only.

/** 123000n with 8 decimals gives "0.00123"; no trailing zeros. */
function formatUnits(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** "0.5" with 8 decimals gives 50000000n. The text must already be a plain decimal ("12", "1.5", "2."). */
function parseUnits(text, decimals) {
  const [whole, fraction = ''] = String(text).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) throw new Error(`not an amount: ${text}`);
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

module.exports = { formatUnits, parseUnits };
