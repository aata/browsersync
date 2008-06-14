// Copyright (C) 2006 and onwards Google, Inc.

// Provides encryption and decryption functions.
var CLB_Crypter = {};

CLB_Crypter.uniqueCount_ = 0;
CLB_Crypter.startDate_ = null;

CLB_Crypter.cache_ = {};
CLB_Crypter.debugZone = "CLB_Crypter";

// Note that '|' is not part of the base-64 charset,
// so if you're changing encoders, check that | is
// safe to use.
CLB_Crypter.DELIMITER = '|';

// Same with '*'
CLB_Crypter.VERSION_DELIMITER = '*';

CLB_Crypter.unicodeConverter 
  = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
    .createInstance(Ci.nsIScriptableUnicodeConverter);

CLB_Crypter.unicodeConverter.charset = "UTF-8";

CLB_Crypter.toByteArray = function(str) {
  return this.unicodeConverter.convertToByteArray(str, {});
}

CLB_Crypter.canDecrypt = function(str) {
  // we can decrypt version 1 and 2 strings
  return /\*[12]$/.test(str);
}

CLB_Crypter.fromByteArray = function(bytes) {
  try {
    return this.unicodeConverter.convertFromByteArray(bytes, bytes.length);
  } catch (e) {
    G_Debug(this, "ERROR: unicodeConverter failed");
    // Sometimes unicodeConverter throws errors on some unicode characters
    // (e.g. 55296), so we have our own converter for use in those cases.
    var str = [];

    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] < 128) {
        str.push(String.fromCharCode(bytes[i]));
      } else {
        break;
      }
    }

    return str.join("");
  }
}

/**
 * Decrypts a string
 * If a salt is found appended to the string (delimited by
 * '|'), decryptString will use that with the key.
 *
 * @param {Bool} String to crypt.
 */
CLB_Crypter.decryptString = function(str, key) {
  // if str is blank, it will decrypt to blank
  // if its length is not mod-4, base64 encoder
  // will throw an error.
  if (!isString(str)) {
    G_Debug(this, "Error: decryptString expected a string");
    return "";
  }
  
  var versionSplit = str.split(CLB_Crypter.VERSION_DELIMITER);
  str = versionSplit[0];
  
  if (versionSplit.length == 1 || versionSplit[1] == "1") {
    // This version had a different, slower method of converting
    // strings to arrays of bytes and back again.
    var crypter = new ARC4();

    var split = str.split(CLB_Crypter.DELIMITER);
    var salt = split[1];
    str = split[0];

    if (salt) {
      key += salt;
    }

    if (str.length % 4 != 0) {
      G_Debug(this, "ERROR: String '%s' was not of correct length".subs(str));
      throw new Error("Length of encoded data must be zero mod four");
    }

    if (!salt && CLB_Crypter.cache_[str]) {
      return CLB_Crypter.cache_[str];
    }

    var strArr = CLB_app.base64r.decodeString(str);

    crypter.setKey(CLB_app.base64r.arrayifyString(key));
    crypter.discard(CLB_app.CRYPT_DISCARD_BYTES);
    crypter.crypt(strArr);

    var result = CLB_app.base64r.stringifyArray(strArr);

    if (!salt) {
      CLB_Crypter.cache_[str] = result;
    }

    return result;
  } else if (versionSplit[1] == "2") {
    var crypter = new ARC4();

    var split = str.split(CLB_Crypter.DELIMITER);
    var salt = split[1];
    str = split[0];

    if (salt) {
      key += salt;
    }

    if (str.length % 4 != 0) {
      G_Debug(this, "ERROR: String '%s' was not of correct length".subs(str));
      throw new Error("Length of encoded data must be zero mod four");
    }

    if (!salt && CLB_Crypter.cache_[str]) {
      return CLB_Crypter.cache_[str];
    }

    var strArr = CLB_app.base64r.decodeString(str);

    crypter.setKey(CLB_Crypter.toByteArray(key));
    crypter.discard(CLB_app.CRYPT_DISCARD_BYTES);
    crypter.crypt(strArr);

    var result = CLB_Crypter.fromByteArray(strArr);

    if (!salt) {
      CLB_Crypter.cache_[str] = result;
    }

    return result;
  } else {
    G_DebugL(this, "Error: unknown encryption version encountered");
    throw new Error("Unknown encryption version encountered");
  }
}

/**
 * Encrypts a string.
 * We add an optional 'salt' to the key we used to encrypt
 * then append the salt to the end of the encrypted data.
 * This prevents attacks that rely on similar strings 
 * encrypting in a similar way (e.g. "true" and "false" 
 * always encrypting to the same things.
 *
 * @param {Bool} String to crypt.
 */
CLB_Crypter.encryptString = function(str, key, opt_salt) {
  if (isNumber(str)) {
    str = String(str);
  } else if (!isString(str)) {
    G_Debug(this, "Error: encryptString expected a string");
    return "";
  }
  
  if (!str) {
    return "";
  }

  if (!opt_salt && CLB_Crypter.cache_[str]) {
    return CLB_Crypter.cache_[str];
  }

  var strArr = this.toByteArray(str);
  
  if (opt_salt) {
    var salt = [];
    
    // Uniqueness
    if (isNull(CLB_Crypter.startDate_)) {
      var quotient = (new Date()).getTime();
      var res = [];
      
      // This will generate a base64 version of ittybittytime that is 
      // backwards (we don't care).
      while (quotient != 0) {
        var remainder = quotient % 64;
        quotient = Math.floor(quotient / 64);
        res.push(G_Base64.ENCODED_VALS.charAt(remainder));
      }

      CLB_Crypter.startDate_ = res.join("");
    }
    
    salt.push(CLB_Crypter.startDate_);
    salt.push(CLB_Crypter.uniqueCount_++);
    
    // Randomness
    for (var i = 0; i < 5; i++) {
      salt.push(
        G_Base64.ENCODED_VALS.charAt(
          Math.floor(Math.random() * (G_Base64.ENCODED_VALS.length - 1))
        )
      );
    }
    
    salt = salt.join("");
    key += salt;
  }
  
  var crypter = new ARC4(); 
  
  crypter.setKey(CLB_Crypter.toByteArray(key));
  
  crypter.discard(CLB_app.CRYPT_DISCARD_BYTES);
  crypter.crypt(strArr);
  
  var output = CLB_app.base64r.encodeByteArray(strArr);
  
  if (opt_salt) {
    output += CLB_Crypter.DELIMITER + salt 
              + CLB_Crypter.VERSION_DELIMITER + "2";
  } else {
    output += CLB_Crypter.VERSION_DELIMITER + "2";
    CLB_Crypter.cache_[str] = output;
  }
  
  return output;
}

bindMethods(CLB_Crypter);

if (CLB_DEBUG) {
  function TEST_CLB_Crypter() {
    var zone = "TEST_CLB_Crypter";

    var testStr = "Happy happy monkey day";
    var testArr = [];
    G_Debug(this, "Testing arrayify perf");

    var t0 = new Date().getTime();
    for (var i = 0; i < 1000; i++) {
      testArr = CLB_app.base64r.arrayifyString(testStr);
    }
    var t1 = new Date().getTime();
    for (var i = 0; i < 1000; i++) {
      testArr = CLB_Crypter.toByteArray(testStr);
    }
    var t2 = new Date().getTime();

    G_Debug(this, "G_Base64 took: " + (t1 - t0) + " ms");
    G_Debug(this, "nsScriptableUnicodeConverter took: " + (t2 - t1) + " ms");

    G_Debug(this, "Testing stringify perf");
    var t3 = new Date().getTime();
    for (var i = 0; i < 1000; i++) {
      CLB_app.base64r.stringifyArray(testArr);
    }
    var t4 = new Date().getTime();
    for (var i = 0; i < 1000; i++) {
      testStr = CLB_Crypter.fromByteArray(testArr);
    }
    var t5 = new Date().getTime();

    G_Debug(this, "G_Base64 took: " + (t4 - t3) + " ms");
    G_Debug(this, "nsScriptableUnicodeConverter took: " + (t5 - t4) + " ms");

    var unencrypted = "Encryption $ # 123 | fourty111";
    
    var encryptedPorksSalt = 
      CLB_Crypter.encryptString(unencrypted, "porks", true /* salt */);
    var encryptedPorksSaltless = 
      CLB_Crypter.encryptString(unencrypted, "porks", false /* no salt */);

    // HACK to defeat crypter's cache which will return the same value for
    // cheesesaltless otherwise.
    CLB_Crypter.cache_ = {};
    
    var encryptedCheeseSalt = 
      CLB_Crypter.encryptString(unencrypted, "cheese", true /* salt */);
    var encryptedCheeseSaltless = 
      CLB_Crypter.encryptString(unencrypted, "cheese", false /* no salt */);
      
    G_Debug(this, "porksalt      : '%s'".subs(encryptedPorksSalt));
    G_Debug(this, "porksaltless  : '%s'".subs(encryptedPorksSaltless));
    G_Debug(this, "cheesesalt    : '%s'".subs(encryptedCheeseSalt));
    G_Debug(this, "cheesesaltless: '%s'".subs(encryptedCheeseSaltless));
    
    // Note that we can't compare salted things to known values
    G_AssertEqual(zone, 
                 "Uh4LlcCEuC1W53utSmuFKsTXyE3QH+prd5x+qudM*2", 
                 encryptedPorksSaltless,
                 "String Encrypted with key 'pork' and no salt, did not "
                 + "encrypt correctly");
                       
    G_AssertEqual(zone, 
                 "kBXb7qMDWxwSGnf1gBvHtlexN1jGou+5cM6psFSz*2", 
                 encryptedCheeseSaltless,
                 "String Encrypted with key 'cheese' and no salt, did not "
                 + "encrypt correctly");
    
    // Make sure salting works
    G_Assert(zone, encryptedPorksSalt != encryptedPorksSaltless,
             "String encrypted with 'porks' and salt encrypted to same "
             + "value as string encrypted with 'porks' and no salt");
             
    G_Assert(zone, encryptedCheeseSalt != encryptedCheeseSaltless,
             "String encrypted with 'cheese' and salt encrypted to same "
             + "value as string encrypted with 'cheese' and no salt");
                  
    
    var decryptedPorksSalt = 
      CLB_Crypter.decryptString(encryptedPorksSalt, 
                                    "porks", 
                                    true /* salt */);
    var decryptedPorksSaltless = 
      CLB_Crypter.decryptString(encryptedPorksSaltless, 
                                    "porks", 
                                    false /* no salt */);
    var decryptedCheeseSalt = 
      CLB_Crypter.decryptString(encryptedCheeseSalt, 
                                    "cheese", 
                                    true /* salt */);
    var decryptedCheeseSaltless = 
      CLB_Crypter.decryptString(encryptedCheeseSaltless, 
                                    "cheese", 
                                    false /* no salt */);
                                    
    G_AssertEqual(zone, decryptedPorksSalt, unencrypted,
                  "String encrypted with 'pork' and salt did not decrypt");
                  
    G_AssertEqual(zone, decryptedPorksSaltless, unencrypted,
                  "String encrypted with 'pork' and salt did not decrypt");

    G_AssertEqual(zone, decryptedCheeseSalt, unencrypted,
                  "String encrypted with 'pork' and salt did not decrypt");
                  
    G_AssertEqual(zone, decryptedCheeseSaltless, unencrypted,
                  "String encrypted with 'pork' and salt did not decrypt");
  }
}
