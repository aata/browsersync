// Copyright (C) 2006 and onwards Google Inc.

/**
 * Implementation of HMAC in JavaScript.
 *
 * @constructor
 * @param hasher    An object implementing reset(), update(), and digest() to
 *                  serve as a hash function. See google3/javascript/sha1.js for
 *                  example.
 *
 * @param key       The secret key to use to calculate the hmac. Should be an
 *                  array of not more than @blockSize integers in {0, 255}.
 *
 * @param opt_blockSize Optional. The block size @hasher uses. If not specified, 16.
 */
function G_HMAC(hasher, key, opt_blockSize) {
  if (!hasher || typeof hasher != "object" || !hasher.reset ||
      !hasher.update || !hasher.digest) {
    throw new Error("Invalid hasher object. Hasher unspecified or does not " +
                    "implement expected interface.");
  }

  if (key.constructor != Array) {
    throw new Error("Invalid key.");
  }

  if (opt_blockSize && typeof opt_blockSize != "number") {
    throw new Error("Invalid block size.");
  }

  this.hasher_ = hasher;
  this.blockSize_ = opt_blockSize || 16;
  this.keyO_ = new Array(this.blockSize_);
  this.keyI_ = new Array(this.blockSize_);

  // If key is too long, first hash it per spec.
  if (key.length > this.blockSize_) {
    this.hasher_.update(key);
    key = this.hasher_.digest();
  }

  // precalculate padded and xor'd keys.
  var keyByte;
  for (var i = 0; i < this.blockSize_; i++) {
    if (i < key.length) {
      keyByte = key[i];
    } else {
      keyByte = 0; 
    }
    
    this.keyO_[i] = keyByte ^ G_HMAC.OPAD;
    this.keyI_[i] = keyByte ^ G_HMAC.IPAD;
  }
}

G_HMAC.OPAD = 0x5c;
G_HMAC.IPAD = 0x36;

/**
 * Resets the HMAC to the state it was in after construction.
 */
G_HMAC.prototype.reset = function() {
  this.hasher_.reset();
  this.hasher_.update(this.keyI_);
};

/**
 * Updates the hash with additional data.
 */
G_HMAC.prototype.update = function(data) {
  if (data.constructor != Array) {
    throw new Error("Invalid data. Data must be an array.");
  }

  this.hasher_.update(data);
};

/**
 * Completes hashing and returns a digest as a byte array.
 */
G_HMAC.prototype.digest = function() {
  var temp = this.hasher_.digest();

  this.hasher_.reset();
  this.hasher_.update(this.keyO_);
  this.hasher_.update(temp);

  return this.hasher_.digest();
};

/**
 * Calculates an HMAC for a given message.
 *
 * @param message  An array of integers in {0, 255}.
 */
G_HMAC.prototype.getHMac = function(message) {
  this.reset();
  this.update(message);

  return this.digest();
}

