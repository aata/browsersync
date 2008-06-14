// Copyright (C) 2005 and onwards Google, Inc.
//
// Class for manipulating preferences. Aside from wrapping the pref
// service, useful functionality includes:
//
// - abstracting prefobserving so that you can observe preferences
//   without implementing nsIObserver 
// 
// - getters that return a default value when the pref doesn't exist 
//   (instead of throwing)
// 
// - get-and-set getters
//
// Example:
// 
// var p = new G_Preferences();
// alert(p.getPref("some-true-pref"));     // shows true
// alert(p.getPref("no-such-pref", true)); // shows true   
// alert(p.getPref("no-such-pref", null)); // shows null
//
// function observe(prefThatChanged) {
//   alert("Pref changed: " + prefThatChanged);
// };
//
// p.addObserver("somepref", observe);
// p.setPref("somepref", true);            // alerts
// p.removeObserver("somepref", observe);


/**
 * A class that wraps the preferences service.
 *
 * @param opt_startPoint        A starting point on the prefs tree to resolve 
 *                              names passed to setPref and getPref.
 *
 * @param opt_getDefaultBranch  Set to true to work against the default 
 *                              preferences tree instead of the profile one.
 *
 * @param opt_noUnicode         Set to true to have strings saved as ascii
 *                              strings.  This is only provided for backward
 *                              compatibility with older extensions and
 *                              shouldn't be used in any other situation.
 * @constructor
 */
function G_Preferences(opt_startPoint, opt_getDefaultBranch, opt_noUnicode) {
  this.debugZone = "prefs";
  this.observers_ = {};

  var startPoint = opt_startPoint || null;
  var prefSvc = Cc["@mozilla.org/preferences-service;1"]
                  .getService(Ci.nsIPrefService);

  if (opt_getDefaultBranch) {
    this.prefs_ = prefSvc.getDefaultBranch(startPoint);
  } else {
    this.prefs_ = prefSvc.getBranch(startPoint);
  }

  // QI to prefinternal in case we want to add observers
  this.prefs_.QueryInterface(Ci.nsIPrefBranchInternal);

  this.noUnicode_ = !!opt_noUnicode;
}

G_Preferences.setterMap_ = { "string": "setCharPref",
                             "boolean": "setBoolPref",
                             "number": "setIntPref" };

G_Preferences.getterMap_ = {};
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_STRING] = "getCharPref";
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_BOOL] = "getBoolPref";
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_INT] = "getIntPref";
  

/**
 * Stores a key/value in a user preference. Valid types for val are string,
 * boolean, and number. Complex values are not yet supported (but feel free to
 * add them!).
 */
G_Preferences.prototype.setPref = function(key, val) {
  var datatype = typeof(val);

  if (datatype == "number" && (val % 1 != 0)) {
    throw new Error("Cannot store non-integer numbers in preferences.");
  }
  
  if (datatype == "string" && !this.noUnicode_) {
    return this.setUnicodePref(key, val);
  }

  var meth = G_Preferences.setterMap_[datatype];

  if (!meth) {
    throw new Error("Pref datatype {" + datatype + "} not supported.");
  }

  return this.prefs_[meth](key, val);
}

/**
 * Retrieves a user preference. Valid types for the value are the same as for
 * setPref. If the preference is not found, opt_default will be returned 
 * instead.
 */
G_Preferences.prototype.getPref = function(key, opt_default) {
  var type = this.prefs_.getPrefType(key);

  // zero means that the specified pref didn't exist
  if (type == Ci.nsIPrefBranch.PREF_INVALID) {
    return opt_default;
  }

  if (type == Ci.nsIPrefBranch.PREF_STRING && !this.noUnicode_) {
    return this.getUnicodePref(key, opt_default);
  }

  var meth = G_Preferences.getterMap_[type];

  if (!meth) {
    throw new Error("Pref datatype {" + type + "} not supported.");
  }

  // If a pref has been cleared, it will have a valid type but won't
  // be gettable, so this will throw.
  try {
    return this.prefs_[meth](key);
  } catch(e) {
    return opt_default;
  }
}

/**
 * Set a unicode string (nothing special in JS, but char prefs don't like
 * unicode).
 * @param key String name of preference to set
 * @param value String indicating value to set
 */
G_Preferences.prototype.setUnicodePref = function(key, value) {
  G_Assert(this, typeof(key) == "string", "key isn't a string");
  G_Assert(this, key.length > 0, "key is the empty string");
  G_Assert(this, typeof(value) == "string", "value isn't a string");

  // Convert JS string to nsISupportsString
  var s = Cc["@mozilla.org/supports-string;1"]
          .createInstance(Ci.nsISupportsString);
  s.data = value;

  return this.prefs_.setComplexValue(key, Ci.nsISupportsString, s);
}

/**
 * Get a unicode string (nothing special in JS, but char prefs don't like
 * unicode).
 * @param key String name of preference to get
 * @param opt_default String default value if pref doesn't exist
 */
G_Preferences.prototype.getUnicodePref = function(key, opt_default) {
  G_Assert(this, typeof(key) == "string", "key isn't a string");
  G_Assert(this, key.length > 0, "key is the empty string");

  try {
    return this.prefs_.getComplexValue(key, Ci.nsISupportsString).data;
  } catch (e) {
    return opt_default;
  }
}

/**
 * Set a boolean preference
 *
 * @param which Name of preference to set
 * @param value Boolean indicating value to set
 *
 * @deprecated  Just use setPref.
 */
G_Preferences.prototype.setBoolPref = function(which, value) {
  return this.setPref(which, value);
}

/**
 * Get a boolean preference. WILL THROW IF PREFERENCE DOES NOT EXIST.
 * If you don't want this behavior, use getBoolPrefOrDefault.
 *
 * @param which Name of preference to get.
 *
 * @deprecated  Just use getPref.
 */
G_Preferences.prototype.getBoolPref = function(which) {
  return this.prefs_.getBoolPref(which);
}

/**
 * Get a boolean preference or return some default value if it doesn't
 * exist. Note that the default doesn't have to be bool -- it could be
 * anything (e.g., you could pass in null and check if the return
 * value is === null to determine if the pref doesn't exist).
 *
 * @param which Name of preference to get.
 * @param def Value to return if the preference doesn't exist
 * @returns Boolean value of the pref if it exists, else def
 *
 * @deprecated  Just use getPref.
 */
G_Preferences.prototype.getBoolPrefOrDefault = function(which, def) {
  return this.getPref(which, def);
}

/**
 * Get a boolean preference if it exists. If it doesn't, set its value
 * to a default and return the default. Note that the default will be
 * coherced to a bool if it is set, but not in the return value.
 *
 * @param which Name of preference to get.
 * @param def Value to set and return if the preference doesn't exist
 * @returns Boolean value of the pref if it exists, else def
 *
 * @deprecated  Just use getPref.
 */
G_Preferences.prototype.getBoolPrefOrDefaultAndSet = function(which, def) {
  try {
    return this.prefs_.getBoolPref(which);
  } catch(e) {
    this.prefs_.setBoolPref(which, !!def);  // The !! forces boolean conversion
    return def;
  }
}

/**
 * Delete a preference. 
 *
 * @param which Name of preference to obliterate
 */
G_Preferences.prototype.clearPref = function(which) {
  try {
    // This throws if the pref doesn't exist, which is fine because a 
    // non-existent pref is cleared
    this.prefs_.clearUserPref(which);
  } catch(e) {}
}

/**
 * Add an observer for a given pref.
 *
 * @param which String containing the pref to listen to
 * @param callback Function to be called when the pref changes. This
 *                 function will receive a single argument, a string 
 *                 holding the preference name that changed
 */
G_Preferences.prototype.addObserver = function(which, callback) {
  var observer = new G_PreferenceObserver(callback);
  // Need to store the observer we create so we can eventually unregister it
  if (!this.observers_[which])
    this.observers_[which] = new G_ObjectSafeMap();
  this.observers_[which].insert(callback, observer);
  this.prefs_.addObserver(which, observer, false /* strong reference */);
}

/**
 * Remove an observer for a given pref.
 *
 * @param which String containing the pref to stop listening to
 * @param callback Function to remove as an observer
 */
G_Preferences.prototype.removeObserver = function(which, callback) {
  var observer = this.observers_[which].find(callback);
  G_Assert(this, !!observer, "Tried to unregister a nonexistant observer"); 
  this.prefs_.removeObserver(which, observer);
  this.observers_[which].erase(callback);
}

/**
 * Removes all observers for any pref
 */
G_Preferences.prototype.removeAllObservers = function() {
  for (var which in this.observers_) {
    var observersMap = this.observers_[which];
    var observers = observersMap.getAllValues();
    for (var i = 0; i < observers.length; i++) {
      var observer = observers[i];
      this.prefs_.removeObserver(which, observer);
    }
  }
  this.observers_ = {};
};

/**
 * Get an array of the names of children prefs from a given start point.
 */
G_Preferences.prototype.getChildNames = function(opt_startingPoint) {
  if (!opt_startingPoint) {
    opt_startingPoint = "";
  }
  
  return this.prefs_.getChildList(opt_startingPoint,
                                  {} /* count, not used */);
}

/**
 * Force writing of the prefs.js file in the users profile.
 */
G_Preferences.savePrefFile = function() {
  var prefService = Cc["@mozilla.org/preferences;1"]
                    .getService(Ci.nsIPrefService);
  try {
    prefService.savePrefFile(null);
  } catch (e) {
    G_Debug(this, 'Error saving pref file:' + e);
  }
}


/**
 * Helper class that knows how to observe preference changes and
 * invoke a callback when they do
 *
 * @constructor
 * @param callback Function to call when the preference changes
 */
function G_PreferenceObserver(callback) {
  this.debugZone = "prefobserver";
  this.callback_ = callback;
}

/**
 * Invoked by the pref system when a preference changes. Passes the
 * message along to the callback.
 *
 * @param subject The nsIPrefBranch that changed
 * @param topic String "nsPref:changed" (aka 
 *              NS_PREFBRANCH_PREFCHANGE_OBSERVER_ID -- but where does it
 *              live???)
 * @param data Name of the pref that changed
 */
G_PreferenceObserver.prototype.observe = function(subject, topic, data) {
  G_Debug(this, "Observed pref change: " + data);
  this.callback_(data);
}

/**
 * XPCOM cruft
 *
 * @param iid Interface id of the interface the caller wants
 */
G_PreferenceObserver.prototype.QueryInterface = function(iid) {
  var Ci = Ci;
  if (iid.equals(Ci.nsISupports) || 
      iid.equals(Ci.nsIObserver) ||
      iid.equals(Ci.nsISupportsWeakReference))
    return this;
  throw Components.results.NS_ERROR_NO_INTERFACE;
}


// UNITTESTS

function TEST_G_Preferences() {
  if (G_GDEBUG) {
    var z = "preferences UNITTEST";
    G_debugService.enableZone(z);
    G_Debug(z, "Starting");

    var p = new G_Preferences();
    
    var testPref = "google-amulet-preferences-unittest";
    var noSuchPref = "google-amulet-preferences-unittest-aypabtu";
    
    // Used to test observing
    var observeCount = 0;
    function observe(prefChanged) {
      G_Assert(z, prefChanged == testPref, "observer broken");
      observeCount++;
    };

    // Test setting, getting, and observing
    p.addObserver(testPref, observe);
    p.setBoolPref(testPref, true);
    G_Assert(z, p.getBoolPref(testPref), "get or set broken");
    G_Assert(z, observeCount == 1, "observer adding not working");

    p.removeObserver(testPref, observe);

    p.setBoolPref(testPref, false);
    G_Assert(z, observeCount == 1, "observer removal not working");
    G_Assert(z, !p.getBoolPref(testPref), "get broken");
    try {
      p.getBoolPref(noSuchPref);
      G_Assert(z, false, "getting non-existent pref didn't throw");
    } catch (e) {
    }
    
    // Try the default varieties
    G_Assert(z, 
             p.getBoolPrefOrDefault(noSuchPref, true), "default borken (t)");
    G_Assert(z, !p.getBoolPrefOrDefault(noSuchPref, false), "default borken");
    
    // And the default-and-set variety
    G_Assert(z, p.getBoolPrefOrDefaultAndSet(noSuchPref, true), 
             "default and set broken (didnt default");
    G_Assert(z, 
             p.getBoolPref(noSuchPref), "default and set broken (didnt set)");
    
    // Test unicode methods.
    var charPref = "google-preferences-char-unittest";
    var unicode = "\u6240\u6709\u4e2d\u6587\u7f51\u9875";
    p.setPref(charPref, unicode);
    G_Assert(z, p.getPref(charPref) == unicode, "unicode mismatch");
    p.clearPref(charPref);

    // Remember to clean up the prefs we've set, and test removing prefs 
    // while we're at it
    p.clearPref(noSuchPref);
    G_Assert(z, !p.getBoolPrefOrDefault(noSuchPref, false), "clear broken");
    
    p.clearPref(testPref);
    
    // Test old style char prefs
    var p = new G_Preferences(null, false, true);
    var testString = "test string";
    p.setPref(charPref, testString);
    G_Assert(z, p.getPref(charPref) == testString, "old char pref broken");

    // High ascii characters should be written/read properly
    testString = "\xf0\xe5";
    p.setPref(charPref, testString);
    G_Assert(z, p.getPref(charPref) == testString, "old char pref broken");

    // Example of incompatible unicode change
    G_Assert(z, p.getUnicodePref(charPref) != testString, "unicode fixed?");
    // Example of compatible calls
    testString = "test string";
    p.setPref(charPref, testString);
    G_Assert(z, p.getUnicodePref(charPref) == testString, "ascii broken");

    p.clearPref(testPref);
    
    G_Debug(z, "PASSED");
  }
}
