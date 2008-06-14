// Copyright 2005 and onwards, Google

/**
 * A dictionary indexed by both keys and values, so lookups in both directions
 * are O(1). Each key and value must be unique.
 *
 * @param {Object} opt_initialValues  An object containing any initial values to
 *                                    populate the dictionary with.
 */
function G_DoubleDictionary(opt_initialValues) {
  this.keysToValues_ = {};
  this.valuesToKeys_ = {};

  if (opt_initialValues) {
    this.addMultiple(opt_initialValues);
  }
}

/**
 * Add an item to the dictionary.
 */
G_DoubleDictionary.prototype.addItem = function(key, value) {
  if (this.hasKey(key)) {
    throw new Error("The specified key {%s} already exists".subs(key));
  }

  if (this.hasValue(value)) {
    throw new Error("The specified value {%s} already exists.".subs(value));
  }

  this.keysToValues_[key] = value;
  this.valuesToKeys_[value] = key;
}

/**
 * Add multiple objects to the dictionary. 
 *
 * @param {Object} obj  An object containing the key/value pairs to add.
 */
G_DoubleDictionary.prototype.addMultiple = function(obj) {
  for (var p in obj) {
    this.addItem(p, obj[p]);
  }
}

/**
 * Get a key given a value.
 */
G_DoubleDictionary.prototype.getKey = function(val) {
  return this.valuesToKeys_[val];
}

/**
 * Get a value given a key.
 */
G_DoubleDictionary.prototype.getValue = function(key) {
  return this.keysToValues_[key];
}

/**
 * Get an array of all keys. This is O(n) by the number of keys.
 */
G_DoubleDictionary.prototype.getKeys = function() {
  return getObjectProps(this.keysToValues_);
}

/**
 * Get an array of all values. This is O(n) by the number of keys.
 */
G_DoubleDictionary.prototype.getValues = function() {
  return getObjectProps(this.valuesToKeys_);
}

/**
 * Returns true if the specified key exists.
 */
G_DoubleDictionary.prototype.hasKey = function(key) {
  return isDef(this.keysToValues_[key]);
}

/**
 * Returns true if the specified value exists.
 */
G_DoubleDictionary.prototype.hasValue = function(value) {
  return isDef(this.valuesToKeys_[value]);
}


if (G_GDEBUG) {
  function TEST_G_DoubleDictionary() {
    var zone = "TEST_G_DoubleDictionary";
    G_Debug(zone, "Starting G_DoubleDictionary unit tests");

    // Run some basic functionality tests
    var dd = new G_DoubleDictionary();

    G_Assert(zone, 0 == dd.getKeys().length,
             "Key length non zero in an empty dictionary");
    G_Assert(zone, 0 == dd.getValues().length,
             "Value length non zero in an empty dictionary");
    G_Assert(zone, !dd.hasKey("foo"),
             "Empty dictionary contains key foo");

    var dd2 = new G_DoubleDictionary({ "foo": "bar",
                                       "hot": "dog" });

    G_Assert(zone, "bar" == dd2.getValue("foo"),
             "Dictionary failed to retrieve value bar for key foo");
    G_Assert(zone, "foo" == dd2.getKey("bar"),
             "Dictionary failed to retrieve key foo for value bar");
    G_Assert(zone, "dog" == dd2.getValue("hot"),
             "Dictionary failed to retrieve value dog for key hot");
    G_Assert(zone, "hot" == dd2.getKey("dog"),
             "Dictionary failed to retrieve key hot for value dog");
    
    var keys = dd2.getKeys();
    var values = dd2.getValues();

    G_Assert(zone, 2 == keys.length,
             "Key length is " + keys.length + " but it should be 2");
    G_Assert(zone, 2 == values.length,
             "Values length is " + values.length + " but it should be 2");

    G_Assert(zone, dd2.hasKey("foo"),
             "Dictionary thinks it doesn't have key foo");
    G_Assert(zone, dd2.hasKey("hot"),
             "Dictionary thinks it doesn't have key hot");
    G_Assert(zone, dd2.hasValue("bar"),
             "Dictionary thinks it doesn't have value bar");
    G_Assert(zone, dd2.hasValue("dog"),
             "Dictionary thinks it doesn't have value dog");

    // Test error handling
    var dd3 = new G_DoubleDictionary();
  
    dd3.addItem("foo", "bar");

    try {
      dd3.addItem("foo", "baz");
    } catch (e) {
      G_Assert(zone, 1 == dd3.getKeys().length,
               "Dictionary added second value with the same key");
      G_Assert(zone, 1 == dd3.getValues().length,
               "Dictionary added second value with the same key");

      try {
        dd3.addItem("hot", "bar");
      } catch (e) {
        G_Assert(zone, 1 == dd3.getKeys().length,
                 "Dictionary added second value with the same value");
        G_Assert(zone, 1 == dd3.getValues().length,
                 "Dictionary added second key with the same value");
        G_Debug(zone, "All G_DoubleDictionary unit tests passed!");
        return;
      }

      G_Assert(zone, 0, "Expected errors when inserting duplicate key.");
    }
    G_Assert(zone, 0, "Expected errors when inserting duplicate value.");
  }
}
