// Copyright (C) 2005 and onwards Google, Inc.
//
// Base64 en/decoding. Not much to say here except that we work with
// decoded values in arrays of bytes. By "byte" I mean a number in [0,
// 255].


/**
 * Base64 en/decoder. Useful in contexts that don't have atob/btoa, or
 * when you need a custom encoding function (e.g., websafe base64).
 * websafe-base64).
 *
 * @constructor
 */
function G_Base64() {
  this.byteToCharMap_ = {};
  this.charToByteMap_ = {};
  this.byteToCharMapWebSafe_ = {};
  this.charToByteMapWebSafe_ = {};
  this.init_();
}

/**
 * Our default alphabet. Value 64 (=) is special; it means "nothing."
 */ 
G_Base64.ENCODED_VALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
                        "abcdefghijklmnopqrstuvwxyz" +
                        "0123456789+/=";

/**
 * Our websafe alphabet. Value 64 (=) is special; it means "nothing."
 */ 
G_Base64.ENCODED_VALS_WEBSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
                                "abcdefghijklmnopqrstuvwxyz" +
                                "0123456789-_=";

/**
 * We want quick mappings back and forth, so we precompute two maps.
 */
G_Base64.prototype.init_ = function() {
  for (var i = 0; i < G_Base64.ENCODED_VALS.length; i++) {
    this.byteToCharMap_[i] = G_Base64.ENCODED_VALS.charAt(i);
    this.charToByteMap_[this.byteToCharMap_[i]] = i;
    this.byteToCharMapWebSafe_[i] = G_Base64.ENCODED_VALS_WEBSAFE.charAt(i);
    this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[i]] = i;
  }
}

/**
 * Base64-encode an array of bytes.
 *
 * @param input An array of bytes (numbers with value in [0, 255]) to encode
 *
 * @param opt_webSafe Boolean indicating we should use the alternative alphabet 
 *
 * @returns String containing the base64 encoding
 */
G_Base64.prototype.encodeByteArray = function(input, opt_webSafe) {

  if (!(input instanceof Array))
    throw new Error("encodeByteArray takes an array as a parameter");

  var byteToCharMap = opt_webSafe ? 
                      this.byteToCharMapWebSafe_ :
                      this.byteToCharMap_;

  var output = [];

  var i = 0;
  while (i < input.length) {

    var byte1 = input[i];
    var haveByte2 = i + 1 < input.length;
    var byte2 = haveByte2 ? input[i + 1] : 0;
    var haveByte3 = i + 2 < input.length;
    var byte3 = haveByte3 ? input[i + 2] : 0;

    var outByte1 = byte1 >> 2;
    var outByte2 = ((byte1 & 0x03) << 4) | (byte2 >> 4);
    var outByte3 = ((byte2 & 0x0F) << 2) | (byte3 >> 6);
    var outByte4 = byte3 & 0x3F;

    if (!haveByte3) {
      outByte4 = 64;
      
      if (!haveByte2)
        outByte3 = 64;
    }
    
    output.push(byteToCharMap[outByte1]);
    output.push(byteToCharMap[outByte2]);
    output.push(byteToCharMap[outByte3]);
    output.push(byteToCharMap[outByte4]);

    i += 3;
  }

  return output.join("");
}

/**
 * Base64-decode a string.
 *
 * @param input String to decode
 *
 * @param opt_webSafe Boolean indicating we should use the alternative alphabet 
 * 
 * @returns Array of bytes representing the decoded value.
 */
G_Base64.prototype.decodeString = function(input, opt_webSafe) {

  if (input.length % 4)
    throw new Error("Length of b64-encoded data must be zero mod four");

  var charToByteMap = opt_webSafe ? 
                      this.charToByteMapWebSafe_ :
                      this.charToByteMap_;

  var output = [];

  var i = 0;
  while (i < input.length) {

    var byte1 = charToByteMap[input.charAt(i)];
    var byte2 = charToByteMap[input.charAt(i + 1)];
    var byte3 = charToByteMap[input.charAt(i + 2)];
    var byte4 = charToByteMap[input.charAt(i + 3)];

    if (byte1 === undefined || byte2 === undefined ||
        byte3 === undefined || byte4 === undefined)
      throw new Error("String contains characters not in our alphabet: " +
                      input);

    var outByte1 = (byte1 << 2) | (byte2 >> 4);
    output.push(outByte1);
    
    if (byte3 != 64) {
      var outByte2 = ((byte2 << 4) & 0xF0) | (byte3 >> 2);
      output.push(outByte2);
      
      if (byte4 != 64) {
        var outByte3 = ((byte3 << 6) & 0xC0) | byte4;
        output.push(outByte3);
      }
    }

    i += 4;
  }

  return output;
}

/**
 * Helper function that turns a string into an array of numbers. 
 *
 * @param str String to arrify
 *
 * @returns Array holding numbers corresponding to the UCS character codes
 *          of each character in str
 */
G_Base64.prototype.arrayifyString = function(str) {
  var output = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    while (c > 0xff) {
      output.push(c & 0xff);
      c >>= 8;
    }
    output.push(c);
  }
  return output;
}

/**
 * Helper function that turns an array of numbers into the string
 * given by the concatenation of the characters to which the numbesr
 * correspond (got that?).
 *
 * @param array Array of numbers representing characters
 *
 * @returns {string} Stringification of the array
 */ 
G_Base64.prototype.stringifyArray = function(array) {
  var output = [];
  for (var i = 0; i < array.length; i++)
    output[i] = String.fromCharCode(array[i]);
  return output.join("");
}


/**
 * Lame unittesting function
 */
function TEST_G_Base64() {
  if (G_GDEBUG) {
    var z = "base64 UNITTEST";
    G_debugService.enableZone(z);
    G_Debug(z, "Starting");

    var b = new G_Base64();

    // Let's see if it's sane by feeding it some well-known values. Index i
    // has the input and index i+1 has the expected value.

    var tests = 
      [ "", "",
        "f", "Zg==",
        "fo", "Zm8=",
        "foo", "Zm9v",
        "foob", "Zm9vYg==",
        "fooba", "Zm9vYmE=",
        "foobar", "Zm9vYmFy",

        // Testing non-ascii characters (1-10 in chinese)
        "\xe4\xb8\x80\xe4\xba\x8c\xe4\xb8\x89\xe5\x9b\x9b\xe4\xba\x94\xe5" +
        "\x85\xad\xe4\xb8\x83\xe5\x85\xab\xe4\xb9\x9d\xe5\x8d\x81",
            "5LiA5LqM5LiJ5Zub5LqU5YWt5LiD5YWr5Lmd5Y2B"];

    for (var i = 0; i < tests.length; i += 2) {
      var enc = b.encodeByteArray(b.arrayifyString(tests[i]));
      G_Assert(z, enc === tests[i + 1],
               "Error encoding: " + tests[i] + " (got " + enc +
               " but wanted " + tests[i + 1] + ")");
      var dec = b.stringifyArray(b.decodeString(enc));
      G_Assert(z, dec === tests[i], 
               "Error deocding " + enc + " (got " + dec + 
               " but wanted " + tests[i] + ")");
    }

    // Now run it through its paces

    var numIterations = 100;
    for (var i = 0; i < numIterations; i++) {

      var input = [];
      for (var j = 0; j < i; j++)
        input[j] = j % 256;
      
      var encoded = b.encodeByteArray(input);
      var decoded = b.decodeString(encoded);
      G_Assert(z, !(encoded.length % 4), "Encoded length not a multiple of 4?");
      G_Assert(z, input.length == decoded.length, 
               "Decoded length not equal to input length?");

      for (var j = 0; j < i; j++)
        G_Assert(z, input[j] === decoded[j], "Values differ at position " + j);
    }

    // Test non-websafe / websafe difference
    var test = ">>>???>>>???";
    var enc = b.encodeByteArray(b.arrayifyString(test));
    G_Assert(z, enc == "Pj4+Pz8/Pj4+Pz8/", "Non-websafe broken?");
    enc = b.encodeByteArray(b.arrayifyString(test), true /* websafe */);
    G_Assert(z, enc == "Pj4-Pz8_Pj4-Pz8_", "Websafe encoding broken");
    var dec = b.stringifyArray(b.decodeString(enc, true /* websafe */));
    G_Assert(z, dec === test, "Websafe dencoding broken");

    // Test parsing malformed characters
    var caught = false;
    try {
      b.decodeString("foooooo+oooo", true /*websafe*/);
    } catch(e) {
      caught = true;
    }
    G_Assert(z, caught, "Didn't throw on malformed input");

    G_Debug(z, "PASSED");

  }
}
