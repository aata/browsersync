// Copyright (C) 2006 and onwards Google Inc.

/**
 * Implements the CBC mode for block ciphers.
 * 
 * NOTE: References to "byte" in this code mean JavaScript integers in
 * {0, 255}.
 *
 * @param cipher         The block cipher to use. Must support encrypt() and
 *                       decrypt() methods like the ones on
 *                       google3/javascript/aes.js.
 *
 * @constructor
 * @param opt_blockSize  The block size of @cipher in bytes. If not specified,
 *                       16 is assumed.
 */
function G_CBC(cipher, opt_blockSize) {
  this.cipher_ = cipher;
  this.blockSize_ = opt_blockSize || 16;
  this.temp_ = new Array(this.blockSize_);
}

G_CBC.prototype.padding = true;
G_CBC.prototype.testMode = false;
G_CBC.prototype.testPlaintextBlock =
G_CBC.prototype.testInputBlock =
G_CBC.prototype.testOutputBlock = function() {};

/**
 * Encrypt a message.
 *
 * @param plaintext   An array of bytes to be crypted.
 *
 * @param ciphertext  An array which will receive the crypted bytes. Any
 *                    existing data is overwritten. The length of the array will
 *                    be reset to the exact length of the ciphertext.
 *
 * @param iv          An array of @blockSize bytes which will be the
 *                    initialization vector for crypting. The IV should never
 *                    be reused with the same key and plaintext.
 */
G_CBC.prototype.encrypt = function(plaintext, ciphertext, iv) {
  if (iv.length != this.blockSize_) {
    throw new Error("Invalid IV length. Must be equal to blockSize.");
  }

  if (!this.padding && plaintext.length % this.blockSize_ != 0) {
    throw new Error("Invalid plaintext length for non-padded encryption.");
  }

  var blockStart = 0;
  var blockNum = 0;
  var contentLength = plaintext.length;
  var finalLength;

  if (this.padding) {
    finalLength = Math.ceil((contentLength + 1) / this.blockSize_)
                  * this.blockSize_;
  } else {
    finalLength = contentLength;
  }

  var i; // position in temp_
  var j; // position in plaintext
  var k; // position in previous ciphertext block
  var prevCiphertext;

  while (blockStart < finalLength) {
    if (this.testMode) {
      this.testPlaintextBlock(blockNum, plaintext, blockStart);
    }

    i = 0;
    j = blockStart;

    // The first block is special: it gets xored with the IV, not previous
    // ciphertexts.
    if (blockStart == 0) {
      k = 0;
      prevCiphertext = iv;
    } else {
      k = blockStart - this.blockSize_;
      prevCiphertext = ciphertext;
    }

    while (i < this.blockSize_ && j < contentLength) {
      this.temp_[i++] = plaintext[j++] ^ prevCiphertext[k++];
    }

    if (j == contentLength) {
      if (this.padding) {
        this.temp_[i++] = 1 ^ prevCiphertext[k++];

        while (i < this.blockSize_) {
          this.temp_[i++] = 0 ^ prevCiphertext[k++];
        }
      }
    }

    if (this.testMode) {
      this.testInputBlock(blockNum, this.temp_, 0);
    }

    this.cipher_.encrypt(this.temp_, ciphertext, 0, blockStart);

    if (this.testMode) {
      this.testOutputBlock(blockNum, ciphertext, blockStart);
    }

    blockStart += this.blockSize_;
    blockNum++;
  }

  ciphertext.length = blockStart;
};


/**
 * Decrypt a message.
 *
 * @param ciphertext  An array of bytes to be decrypted.
 *
 * @param plaintext   An array which will receive the decrypted bytes. Any
 *                    existing data is overwritten. The length of the array will
 *                    be reset to the exact length of the plaintext.
 *
 * @param iv          An array of @blockSize bytes which contains the
 *                    initialization vector which was used for encrypting. 
 */
G_CBC.prototype.decrypt = function(ciphertext, plaintext, iv) {
  if (iv.length != this.blockSize_) {
    throw new Error("Invalid IV length. Must be equal to block size.");
  }

  if (ciphertext.length % this.blockSize_ != 0) {
    throw new Error("Invalid ciphertext length. Must be multiple of block "
                    + "size.");
  }

  var blockStart = 0;
  var blockNum = 0;

  while (blockStart < ciphertext.length) {
    if (this.testMode) {
      this.testInputBlock(blockNum, ciphertext, blockStart);
    }

    this.cipher_.decrypt(ciphertext, plaintext, blockStart, blockStart);

    if (this.testMode) {
      this.testOutputBlock(blockNum, plaintext, blockStart);
    }

    if (blockStart == 0) {
      // The first block is special -- we xor with the IV, not the previous
      // ciphertext block.
      for (var i = 0; i < this.blockSize_; i++) {
        plaintext[i] ^= iv[i];
      }
    } else {
      // Otherwise, we xor with the previous ciphertext block
      var j = blockStart;
      var k = blockStart - this.blockSize_;

      for (var i = 0; i < this.blockSize_; i++) {
        plaintext[j++] ^= ciphertext[k++];
      }
    }

    if (this.testMode) {
      this.testPlaintextBlock(blockNum, plaintext, blockStart);
    }

    blockStart += this.blockSize_;
    blockNum++;
  }

  // Now strip off the padding which should be 1 followed by a bunch of zeros.
  if (!this.padding) {
    return;
  }

  for (var i = plaintext.length - 1;
       i >= plaintext.length - this.blockSize_; i--) {
    if (plaintext[i] == 0) {
      // This is a padding byte. Do nothing.
      continue;
    } else if (plaintext[i] == 1) {
      // This is the last padding byte. Reset the array length and stop.
      plaintext.length = i;
      break;
    } else {
      throw new Error("Invalid padding start " + plaintext[i] + " at pos " + i);
    }
  }

  if (i == ciphertext.length - this.blockSize - 1) {
    throw new Error("Could not find end of padding.");
  }
}
