// Copyright 2005 and onwards, Google
//
// Clobber bootstrapper. All the files required by Clobber are loaded into this 
// service's JS context and run here. This gives us a nice, stable, and clean 
// area to play in which cannot be polluted by other extensions and which lasts 
// the entire lifetime of Firefox.
//
// The file also registers several XPCOM components: 
// * app-context: Used by clobber UI to get access to the code loaded here
// * application: Used to hook the app-startup category
// * sync-manager: The main external interface to Clobber from third-party code

// Firefox and clobber scripts assume that these two are defined
const Cc = Components.classes;
const Ci = Components.interfaces;

// Debug mode
var G_GDEBUG = true;

(function() {
  // The list of script files to load
  var libs = [
    // basics
    "lang.js",  // must come before all other libs
    "doubledictionary.js",
    "eventregistrar.js",
    "listdictionary.js",
    "set.js",
    "workqueue.js",

    // third-party
    "iso8601.js",

    // crypto
    "aes.js",
    "arc4.js",
    "cbc.js",
    "hmac.js",
    "sha1.js",

    // firefox utils
    "alarm.js",
    "cryptohasher.js",
    "preferences.js",  // must come before debug.js
    "debug.js",
    "filesystem.js",
    "jsmodule.js",
    "objectsafemap.js",
    "protocol4.js",
    "requester.js",
    "tabbedbrowserwatcher.js",
    "updater.js",
    "xmlutils.js"
    ];

  // Load js files
  CLB_dump("Initializing Google Browser Sync...");
  for (var i = 0, libPath; libPath = libs[i]; i++) {
    try {
      Cc["@mozilla.org/moz/jssubscript-loader;1"]
        .getService(Ci.mozIJSSubScriptLoader)
        .loadSubScript(getLibUrl(libPath));
    } catch (e) {
      CLB_dump("Error loading library {%s}: %s", libPath, e);
      throw e;
    }
  }
  CLB_dump("Done.");

  // Register some XPCOM components.
  CLB_dump("Instanciating core objects...");
  var CLB_module = new G_JSModule();

  CLB_dump("Registering with XPCOM...");
  // Allows our xul code to use the javascript loaded into this service
  CLB_module.registerObject("{3bb339f9-131b-465b-b52c-97ee10e61a05}",
                            "@google.com/browserstate/app-context;1", 
                            "CLB_AppContext",
                            {wrappedJSObject:this});

  global.NSGetModule = function() {
    return CLB_module;
  };

  CLB_dump("Google Browser Sync initialized successfully!");

  /**
   * Gets a nsIFile for the given physical path relative to the libs/ folder
   */
  function getLibFile(path) {
    var file = __LOCATION__.clone().parent.parent;
    var parts = path.split("/");

    file.append("lib");

    for (var i = 0, part; part = parts[i]; i++) {
      file.append(part);
    }

    return file;
  }

  /**
   * Gets a file:// URL for the given physical path relative to the libs/ 
   * folder. 
   */
  function getLibUrl(path) {
    var file = getLibFile(path);

    if (!file.exists()) {
      throw new Error("Specified library {" + file.path + "} does not exist");
    }

    return Cc["@mozilla.org/network/protocol;1?name=file"]
      .getService(Ci.nsIFileProtocolHandler)
      .getURLSpecFromFile(file);
  }
})();

/**
 * A utility to output to the console, even before G_Debug is loaded.
 */
function CLB_dump(msg) {
  for (var i = 1; i < arguments.length; i++) {
    msg = msg.replace(/\%s/, arguments[i]);
  }

  dump("*** CLB *** " + msg + "\n");
}
