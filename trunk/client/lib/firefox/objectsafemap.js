// Copyright (C) 2005 and onwards Google, Inc.
//
// ObjectSafeMap is, shockingly, a Map with which it is safe to use
// objects as keys. It currently uses parallel arrays for storage,
// rendering it inefficient (linear) for large maps. We can always
// swap out the implementation if this becomes a problem. Note that
// this class uses strict equality to determine equivalent keys.
// 
// Interface:
//
//   insert(key, value)
//   erase(key)          // Returns true if key erased, false if not found
//   find(key)           // Returns undefined if key not found
//   replace(otherMap)   // Clones otherMap, replacing the current map
//   size()              // Returns number of items in the map


/**
 * Create a new ObjectSafeMap.
 *
 * @param opt_name A string used to name the map
 *
 * @constructor
 */
function G_ObjectSafeMap(opt_name) {
  this.debugZone = "objectsafemap";
  this.name_ = opt_name ? opt_name : "noname";
  this.keys_ = [];
  this.values_ = [];
};

/**
 * Helper function to return the index of a key. 
 *
 * @param key An key to find
 *
 * @returns {number} Index in the keys array where the key is found, -1 if not
 */
G_ObjectSafeMap.prototype.indexOfKey_ = function(key) {
  for (var i = 0; i < this.keys_.length; i++)
    if (this.keys_[i] === key)
      return i;
  return -1;
};

/**
 * Add an item
 *
 * @param key An key to add (overwrites previous key)
 *
 * @param value The value to store at that key
 */
G_ObjectSafeMap.prototype.insert = function(key, value) {
  if (key === null)
    throw new Error("Can't use null as a key");
  if (value === undefined)
    throw new Error("Can't store undefined values in this map");

  var i = this.indexOfKey_(key);
  if (i == -1) {
    this.keys_.push(key);
    this.values_.push(value);
  } else {
    this.keys_[i] = key;
    this.values_[i] = value;
  }

  G_Assert(this, this.keys_.length == this.values_.length, 
           "Different number of keys than values!");
};

/**
 * Remove a key from the map
 *
 * @param key The key to remove
 *
 * @returns Boolean indicating if the key was removed
 */
G_ObjectSafeMap.prototype.erase = function(key) {
  var keyLocation = this.indexOfKey_(key);
  var keyFound = keyLocation != -1;
  if (keyFound) {
    this.keys_.splice(keyLocation, 1);
    this.values_.splice(keyLocation, 1);
  }
  G_Assert(this, this.keys_.length == this.values_.length, 
           "Different number of keys than values!");

  return keyFound;
};

/**
 * Look up a key in the map
 *
 * @param key The key to look up
 * 
 * @returns {number?} The value at that key or undefined if it doesn't exist
 */
G_ObjectSafeMap.prototype.find = function(key) {
  var keyLocation = this.indexOfKey_(key);
  return keyLocation == -1 ? undefined : this.values_[keyLocation];
};

/**
 * Replace one map with the content of another
 *
 * @param {G_ObjectSafeMap} other map input map that needs to be merged into our 
 *                          map
 */
G_ObjectSafeMap.prototype.replace = function(other) {
  this.keys_ = [];
  this.values_ = [];
  for (var i = 0; i < other.keys_.length; i++) {
    this.keys_.push(other.keys_[i]);
    this.values_.push(other.values_[i]);
  }

  G_Assert(this, this.keys_.length == this.values_.length, 
           "Different number of keys than values!");
};

/**
 * Apply a function to each of the key value pairs.
 *
 * @param func Function to apply to the map's key value pairs
 */
G_ObjectSafeMap.prototype.forEach = function(func) {
  if (typeof func != "function")
    throw new Error("argument to forEach is not a function, it's a(n) " + 
                    typeof func);

  for (var i = 0; i < this.keys_.length; i++)
    func(this.keys_[i], this.values_[i]);
};

/**
 * @returns {Array.<Object>} Array of all keys in the map in some random order.
 */
G_ObjectSafeMap.prototype.getAllKeys = function() {
  return this.keys_;
};

/**
 * @returns {Array.<Object>} Array of all values in the map. The array may
 *     contain duplicates. Value at i-th position will correspond to the i-th
 *     key in the result of getAllKeys. 
 */
G_ObjectSafeMap.prototype.getAllValues = function() {
  return this.values_;
};

/**
 * @returns {number} The number of keys in the map
 */
G_ObjectSafeMap.prototype.size = function() {
  return this.keys_.length;
};

// Cheesey, yes, but it's what we've got
function TEST_G_ObjectSafeMap() {
  if (G_GDEBUG) {
    var z = "map UNITTEST";
    G_debugService.enableZone(z);
    G_Debug(z, "Starting");

    var m = new G_ObjectSafeMap();
    G_Assert(z, m.size() == 0, "Initial size not zero");

    var o1 = new Object;
    var v1 = "1";
    var o2 = new Object;
    var v2 = "1";

    G_Assert(z, m.find(o1) == undefined, "Found non-existent item");

    m.insert(o1, v1);
    m.insert(o2, v2);

    G_Assert(z, m.size() == 2, "Size not 2");
    G_Assert(z, m.size() == m.getAllKeys().length, "Wrong size of keys");
    G_Assert(z, m.size() == m.getAllValues().length, "Wrong size of values");

    G_Assert(z, m.find(o1) == "1", "Didn't find item 1");
    G_Assert(z, m.find(o2) == "1", "Didn't find item 2");
    
    G_Assert(z, m.getAllKeys().indexOf(o1) != -1, "Didn't find item 1 in keys");
    G_Assert(z, m.getAllKeys().indexOf(o2) != -1, "Didn't find item 2 in keys");

    m.insert(o1, "2");

    G_Assert(z, m.size() == 2, "Size not 2");
    G_Assert(z, m.find(o1) == "2", "Didn't find item 1");
    G_Assert(z, m.find(o2) == "1", "Didn't find item 1");

    m.erase(o1);

    G_Assert(z, m.size() == 1, "Size not 1");
    G_Assert(z, m.size() == m.getAllKeys().length, "Wrong size of keys");
    G_Assert(z, m.size() == m.getAllValues().length, "Wrong size of values");
    G_Assert(z, m.find(o1) == undefined, "Found item1");
    G_Assert(z, m.find(o2) == "1", "Didn't find item 2");
    G_Assert(z, m.getAllKeys().indexOf(o1) == -1, "Found item 1 in keys");
    G_Assert(z, m.getAllKeys().indexOf(o2) != -1, "Didn't find item 2 in keys");

    m.erase(o1);

    G_Assert(z, m.size() == 1, "Size not 1");
    G_Assert(z, m.size() == m.getAllKeys().length, "Wrong size of keys");
    G_Assert(z, m.size() == m.getAllValues().length, "Wrong size of values");
    G_Assert(z, m.find(o1) == undefined, "Found item1");
    G_Assert(z, m.find(o2) == "1", "Didn't find item 2");
    G_Assert(z, m.getAllKeys().indexOf(o1) == -1, "Found item 1 in keys");
    G_Assert(z, m.getAllKeys().indexOf(o2) != -1, "Didn't find item 2 in keys");

    m.erase(o2);

    G_Assert(z, m.size() == 0, "Size not 0");
    G_Assert(z, m.size() == m.getAllKeys().length, "Wrong size of keys");
    G_Assert(z, m.size() == m.getAllValues().length, "Wrong size of values");
    G_Assert(z, m.find(o2) == undefined, "Found item2");
    G_Assert(z, m.getAllKeys().indexOf(o2) == -1, "Found item 2 in keys");

    G_Debug(z, "PASSED");
  }
}
