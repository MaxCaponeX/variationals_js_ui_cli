'use strict';
/**
 * Ethereum wallet — wraps ethers.Wallet to provide message signing.
 */

const { ethers } = require('ethers');

class Wallet {
  constructor({ privatekey, encodedPk, label, db }) {
    this.privatekey = privatekey;
    this.encodedPk = encodedPk;
    this.label = label;
    this.db = db;

    if (privatekey) {
      const normalised = privatekey.startsWith('0x') ? privatekey : '0x' + privatekey;
      this._wallet = new ethers.Wallet(normalised);
      this.address = this._wallet.address;
    } else {
      this._wallet = null;
      this.address = null;
    }
  }

  /**
   * Sign a plain-text message (EIP-191 personal_sign).
   * Returns the hex signature without the leading 0x.
   */
  signMessage(text) {
    if (!this._wallet) throw new Error('Wallet has no private key');
    // ethers.Wallet.signMessageSync is synchronous in ethers v6
    const sig = this._wallet.signMessageSync(text);
    return sig.startsWith('0x') ? sig.slice(2) : sig;
  }

  /**
   * Sign EIP-712 typed data.
   * @param {object} typedData — full EIP-712 message with domain, types, message
   */
  async signTypedData(typedData) {
    if (!this._wallet) throw new Error('Wallet has no private key');
    const { domain, types, message } = typedData;
    return await this._wallet.signTypedData(domain, types, message);
  }
}

module.exports = Wallet;
