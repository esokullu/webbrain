'use strict';

// The wallet's own error: `code` names a string under wallet.error.* in
// app/locales. Kept apart from the crypto modules so that loading it costs
// nothing (see app/wallet/store.js on what loads when).

class WalletError extends Error {
  /** @param {string} code a key under wallet.error.* in app/locales */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

module.exports = { WalletError };
