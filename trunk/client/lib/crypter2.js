// Copyright (C) 2006 and onwards Google, Inc.

/**
 * Encrypt or decrypt a string. In Clobber, strings are encrypted with
 * AES-CBC-256. The IV is an HMAC of the original value, along with any
 * additional data we can scrape together that will be known and stable at
 * both encryption and decryption time.
 *
 * This class relies on bits of CLB_Crypter. Once all clients are upgraded, we
 * can remove CLB_Crypter and move those bits into this class.
 */
function CLB_Crypter2(keyBytes) {
  bindMethods(this);

  // Old keys only have 20 bytes. We just add zeros to bring it up to 32, which
  // is what newer keys have. 20 is still a lot, so no wories.
  if (keyBytes.length == 20) {
    for (var i = 20; i < 32; i++) {
      keyBytes.push(0);
    }
  }

  var aes = new G_AES(keyBytes);
  var hasher = new G_CryptoHasher();
  hasher.init(G_CryptoHasher.algorithms.SHA1);

  this.hmacer_ = new G_HMAC(hasher, keyBytes);
  this.cbcer_ = new G_CBC(aes);

  this.temp_ = [];
}


/**
 * Encrypt a string. Returns base64 encoded string.
 */
CLB_Crypter2.prototype.encryptString = function(str, ivStr) {
  if (!isString(str)) {
    throw new Error("encryptString expects a string. Received '%s'."
                    .subs(typeof str));
  }
  
  if (!str) {
    return "";
  }

  var dataBytes = CLB_Crypter.toByteArray(str);
  var ivBytes = CLB_Crypter.toByteArray(ivStr);

  // Compute an IV which is unique to this value and IV combination. We only
  // use 128 bits of the hmac since that is the block size of aes.
  this.hmacer_.reset();
  this.hmacer_.update(dataBytes);
  this.hmacer_.update(ivBytes);

  ivBytes = this.hmacer_.digest();
  ivBytes.length = 16;

  var encryptedBytes = [];
  this.cbcer_.encrypt(dataBytes, encryptedBytes, ivBytes);

  return CLB_app.base64r.encodeByteArray(encryptedBytes)
    + CLB_Crypter.DELIMITER
    + CLB_app.base64r.encodeByteArray(ivBytes)
    + CLB_Crypter.VERSION_DELIMITER
    + "3";
};


/**
 * Decrypt a string.
 */
CLB_Crypter2.prototype.decryptString = function(str, ivData) {
  // if str is blank, it will decrypt to blank
  // if its length is not mod-4, base64 encoder
  // will throw an error.
  if (!isString(str)) {
    throw new Error("encryptString expects a string. Received '%s'."
                    .subs(typeof str));
  }

  if (!str) {
    return "";
  }

  var versionSplit = str.split(CLB_Crypter.VERSION_DELIMITER);

  // There is only one version of AES encryption for now (hopefully ever).
  if (versionSplit[1] != "3") {
    G_Debug(this, "ERROR. Unexpected version for encrypted string: " + str);
    return null;
  }
  
  str = versionSplit[0];
  var split = str.split(CLB_Crypter.DELIMITER);
  var strBytes = CLB_app.base64r.decodeString(split[0]);
  var ivBytes = CLB_app.base64r.decodeString(split[1]);
  var resultBytes = [];

  this.cbcer_.decrypt(strBytes, resultBytes, ivBytes);

  this.hmacer_.reset();
  this.hmacer_.update(resultBytes);
  this.hmacer_.update(CLB_Crypter.toByteArray(ivData));

  var ivCheck = this.hmacer_.digest();
  ivCheck.length = 16;

  for (var i = 0; i < ivBytes.length; i++) {
    if (ivBytes[i] != ivCheck[i]) {
      G_DebugL(this, "Corrupt IV at pos {%s}. Skipping.".subs(i));
      return null;
    }
  }

  return CLB_Crypter.fromByteArray(resultBytes);
};


CLB_Crypter2.prototype.debugZone = "CLB_Crypter2";


if (G_GDEBUG) {
  function TEST_CLB_Crypter2() {
    var c = new CLB_Crypter2([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
                              0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0])

    var zone = "TEST_CLB_Crypter2";

    G_AssertEqual(zone,
                  "nyQvpQ8IgtvtUE+9eed74lfpHhTVyRMwlUuKmUy/ulXdoabogbC9NMTi7d7iKj42CUu8nrHBVgevh8rJl4kIJA==|9ZrNbA/tqD94ftze7GvcNg==*3",
                  c.encryptString("hello! this is a very wonderful day -- I'm going to hawaii!", "abc"),
                  "Test 1 failed");

    G_AssertEqual(zone,
                  "yG4ZQx9Yydmosjeuv+/iGA==|o/TGFG3nAdgL1TrlDGuKQA==*3",
                  c.encryptString("abc", "xyz"),
                  "Test 2 failed");

    G_AssertEqual(zone, "", c.encryptString(""), "Test 3 failed");

    G_AssertEqual(zone, "abc", 
                  c.decryptString("yG4ZQx9Yydmosjeuv+/iGA==|o/TGFG3nAdgL1TrlDGuKQA==*3", "xyz"),
                  "Test 2 failed");

    G_AssertEqual(zone,
                  "hello! this is a very wonderful day -- I'm going to hawaii!",
                  c.decryptString("nyQvpQ8IgtvtUE+9eed74lfpHhTVyRMwlUuKmUy/ulXdoabogbC9NMTi7d7iKj42CUu8nrHBVgevh8rJl4kIJA==|9ZrNbA/tqD94ftze7GvcNg==*3", "abc"),
                  "Test 1 failed");
  }
}
