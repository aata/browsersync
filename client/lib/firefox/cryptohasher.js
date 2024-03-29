// Copyright (C) 2005 and onwards Google, Inc.
//
// A very thin wrapper around nsICryptoHash. It's not strictly
// necessary, but makes the code a bit cleaner and gives us the
// opportunity to verify that our implementations give the results that
// we expect, for example if we have to interoperate with a server.
//
// The digest* methods reset the state of the hasher, so it's
// necessary to call init() explicitly after them.
//
// Works only in Firefox 1.5+.
//
// IMPORTANT NOTE: Due to https://bugzilla.mozilla.org/show_bug.cgi?id=321024
// you cannot use the cryptohasher before app-startup. The symptom of doing
// so is a segfault in NSS.

/**
 * Instantiate a new hasher. You must explicitly call init() before use!
 * @constructor
 */
function G_CryptoHasher() {
  this.debugZone = "cryptohasher";
  this.hasher_ = Cc["@mozilla.org/security/hash;1"]
                 .createInstance(Ci.nsICryptoHash);

  this.initialized_ = false;
}

G_CryptoHasher.algorithms = {
  MD2: Ci.nsICryptoHash.MD2,
  MD5: Ci.nsICryptoHash.MD5,
  SHA1: Ci.nsICryptoHash.SHA1,
  SHA256: Ci.nsICryptoHash.SHA256,
  SHA384: Ci.nsICryptoHash.SHA384,
  SHA512: Ci.nsICryptoHash.SHA512
};

/**
 * Initialize the hasher. This function must be called after every call
 * to one of the digest* methods.
 *
 * @param algorithm Constant from G_CryptoHasher.algorithms specifying the
 *                  algorithm this hasher will use
 */ 
G_CryptoHasher.prototype.init = function(algorithm) {
  var validAlgorithm = false;
  for (var alg in G_CryptoHasher.algorithms)
    if (algorithm == G_CryptoHasher.algorithms[alg])
      validAlgorithm = true;

  if (!validAlgorithm)
    throw new Error("Invalid algorithm: " + algorithm);

  this.initialized_ = true;
  this.algo_ = algorithm;
  this.reset();
};

G_CryptoHasher.prototype.reset = function() {
  this.hasher_.init(this.algo_);
};

/**
 * Update the hash's internal state with input given in a string. Can be
 * called multiple times for incremental hash updates.  Doesn't work
 * with Firefox 1.0.x.
 *
 * @param input String containing data to hash.
 */
G_CryptoHasher.prototype.updateFromString = function(input) {
  if (!this.initialized_)
    throw new Error("You must initialize the hasher first!");

  var stream = Cc['@mozilla.org/io/string-input-stream;1']
               .createInstance(Ci.nsIStringInputStream);
  stream.setData(input, input.length);
  this.updateFromStream(stream);
}

/**
 * Update the hash's internal state with input given in an array. Can be
 * called multiple times for incremental hash updates.
 *
 * @param input Array containing data to hash.
 */ 
G_CryptoHasher.prototype.updateFromArray = function(input) {
  if (!this.initialized_)
    throw new Error("You must initialize the hasher first!");

  this.hasher_.update(input, input.length);
}

/**
 * Update the hash's internal state with input given in a stream. Can be
 * called multiple times from incremental hash updates.
 */
G_CryptoHasher.prototype.updateFromStream = function(stream) {
  if (!this.initialized_)
    throw new Error("You must initialize the hasher first!");

  if (stream.available()) {
    this.hasher_.updateFromStream(stream, stream.available());
  }
}

G_CryptoHasher.prototype.update = function(arr) {
  this.updateFromArray(arr);
}

G_CryptoHasher.prototype.digest = function() {
  var str = this.digestRaw();
  var arr = new Array(str.length);

  for (var i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i);
  }

  return arr;
}

/**
 * @returns {string} The hash value as a string (sequence of 8-bit values)
 */ 
G_CryptoHasher.prototype.digestRaw = function() {
  return this.hasher_.finish(false /* not b64 encoded */);
}

/**
 * @returns {string} The hash value as a base64-encoded string
 */ 
G_CryptoHasher.prototype.digestBase64 = function() {
  return this.hasher_.finish(true /* b64 encoded */);
}

/**
 * @returns {string} The hash value as a hex-encoded string
 */ 
G_CryptoHasher.prototype.digestHex = function() {
  var raw = this.digestRaw();
  return this.toHex_(raw);
}

/**
 * Converts a sequence of values to a hex-encoded string. The input is a
 * a string, so you can stick 16-bit values in each character.
 *
 * @param str String to conver to hex. (Often this is just a sequence of
 *            16-bit values)
 *
 * @returns String containing the hex representation of the input
 */ 
G_CryptoHasher.prototype.toHex_ = function(str) {
  var hexchars = '0123456789ABCDEF';
  var hexrep = new Array(str.length * 2);

  for (var i = 0; i < str.length; ++i) {
    hexrep[i * 2] = hexchars.charAt((str.charCodeAt(i) >> 4) & 15);
    hexrep[i * 2 + 1] = hexchars.charAt(str.charCodeAt(i) & 15);
  }
  return hexrep.join('');
}

/**
 * Lame unittest function
 */
function TEST_G_CryptoHasher() {
  if (G_GDEBUG) {
    var z = "cryptohasher UNITTEST";
    G_debugService.enableZone(z);

    G_Debug(z, "Starting");

    // test vectors from: http://www.faqs.org/rfcs/rfc1321.html
    var vectors = {"": "d41d8cd98f00b204e9800998ecf8427e",
                   "a": "0cc175b9c0f1b6a831c399e269772661",
                   "abc": "900150983cd24fb0d6963f7d28e17f72",
                   "message digest": "f96b697d7cb7938d525a2f31aaf161d0",
                   "abcdefghijklmnopqrstuvwxyz": "c3fcd3d76192e4007dfb496cca67e13b",
                   "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789": "d174ab98d277d9f5a5611c2c9f419d9f",
                   "12345678901234567890123456789012345678901234567890123456789012345678901234567890": "57edf4a22be3c955ac49da2e2107b67a"};

    for (var message in vectors) {
      var hasher = new G_CryptoHasher();
      hasher.init(G_CryptoHasher.algorithms.MD5);
      hasher.updateFromString(message);
      G_AssertEqual(z, vectors[message], hasher.digestHex().toLowerCase(),
                    "Incorrect hash result for message '%s'".subs(message));
      hasher.reset();
    }

    G_Debug(z, "PASSED");
  }
}
