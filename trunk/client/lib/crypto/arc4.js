// (c) Copyright Google Inc. 2005

/**
 * ARC4 streamcipher implementation
 * @constructor
 */
function ARC4() {
  this.S_ = new Array(256);
  this.i_ = 0;
  this.j_ = 0;
}

/**
 * Initialize the cipher for use with new key.
 * @param {Array} key is byte array containing key
 * @param {number} opt_length indicates # of bytes to take from key
 */
ARC4.prototype.setKey = function(key, opt_length) {
  if (key.constructor != Array) {
    throw new Error("Key parameter must be a byte array");
  }

  if (!opt_length) {
    opt_length = key.length;
  }

  var S = this.S_;

  for (var i = 0; i < 256; ++i) {
    S[i] = i;
  }

  var j = 0;
  for (var i = 0; i < 256; ++i) {
    j = (j + S[i] + key[i % opt_length]) & 255;

    var tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
    
  this.i_ = 0;
  this.j_ = 0;
}

/**
 * Discard n bytes of the keystream.
 * These days 1536 is considered a decent amount to drop to get
 * the key state warmed-up enough for secure usage.
 * This is not done in the constructor to preserve efficiency for
 * use cases that do not need this.
 * @param {number} n is # of bytes to disregard from stream
 */
ARC4.prototype.discard = function(n) {
  var devnul = new Array(n);
  this.crypt(devnul);
}

/**
 * En- or decrypt (same operation for streamciphers like ARC4)
 * @param {Array} data gets xor-ed in place
 * @param {number} opt_length indicated # of bytes to crypt
 */
ARC4.prototype.crypt = function(data, opt_length) {
  if (!opt_length) {
    opt_length = data.length;
  }

  if (data.constructor != Array) {
    throw new Error("Data parameter must be a byte array");
  }

  var i = this.i_;
  var j = this.j_;
  var S = this.S_;

  for (var n = 0; n < opt_length; ++n) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;

    var tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;

    data[n] ^= S[(S[i] + S[j]) & 255];
  }

  this.i_ = i;
  this.j_ = j;
}
