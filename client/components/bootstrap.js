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
var CLB_DEBUG = true;

(function() {
  // The list of script files to load
  var libs = [
    // basics
    "base/lang.js",  // must come before all other libs
    "base/doubledictionary.js",
    "base/eventregistrar.js",
    "base/listdictionary.js",
    "base/set.js",
    "base/workqueue.js",

    // third-party
    "third_party/iso8601.js",

    // crypto
    "crypto/aes.js",
    "crypto/arc4.js",
    "crypto/cbc.js",
    "crypto/hmac.js",
    "crypto/sha1.js",

    // firefox utils
    "firefox/alarm.js",
    "firefox/base64.js",
    "firefox/cryptohasher.js",
    "firefox/preferences.js",  // must come before debug.js
    "firefox/debug.js",
    "firefox/filesystem.js",
    "firefox/jsmodule.js",
    "firefox/objectsafemap.js",
    "firefox/protocol4.js",
    "firefox/requester.js",
    "firefox/tabbedbrowserwatcher.js",
    "firefox/updater.js",
    "firefox/xmlutils.js",

    // clobber
    "application.js",
    "arrayenumerator.js",
    "badcertlistener.js",
    "bookmarkenumerator.js",
    "bookmarkresolver.js",
    "bookmarksyncer.js",
    "browseroverlay.js",
    "componentselector.js",
    "conflict.js",
    "conflictresolver.js",
    "cookieenumerator.js",
    "cookiesyncer.js",
    "crypter.js",
    "crypter2.js",
    "downloader.js",
    "historyenumerator.js",
    "historysyncer.js",
    "infobubble.js",
    "listdictionary.js",
    "loginutil.js",
    "passwordform.js",
    "passwordsyncer.js",
    "prefssyncer.js",
    "rdfutils.js",
    "requestfactory.js",
    "restoretabsui.js",
    "settingsform.js",
    "settingssyncer.js",
    "startup.js",
    "syncingform.js",
    "syncitem.js",
    "syncmanager.js",
    "tabsyncer.js",
    "updatequeue.js",
    "updater.js",
    "updatingform.js",
    "welcomeform.js",
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
  global.CLB_syncMan = new CLB_SyncManager();
  global.CLB_app = new CLB_Application();
  global.CLB_module = new G_JSModule();

  CLB_dump("Registering with XPCOM...");
  // Allows our xul code to use the javascript loaded into this service
  CLB_module.registerObject("{3bb339f9-131b-465b-b52c-97ee10e61a05}",
                            "@google.com/browserstate/app-context;1", 
                            "CLB_AppContext",
                            {wrappedJSObject:this});

  // The main shell for the clobber client
  CLB_module.registerObject("{1ec74bff-2c43-4a0a-904f-821b0f624970}",
                            "@google.com/browserstate/application;1", 
                            "CLB_Application",
                            CLB_app);

  // The official external interface to CLB_SyncManager for other extensions
  CLB_module.registerObject("{2fffb7ba-c818-465c-8250-84e9bc4f350b}",
                            "@google.com/browserstate/sync-manager;1", 
                            "CLB_SyncManager",
                            CLB_syncMan);

  CLB_dump("Adding categories...");
  // Register CLB_app to be a command line handler with a very high priority, so
  // that it can execute before other command line handlers.
  // The priority is the 'a' part of the second argument. See: 
  // http://lxr.mozilla.org/mozilla/source/toolkit/components/commandlines/
  // public/nsICommandLineHandler.idl
  var catMgr = Cc["@mozilla.org/categorymanager;1"]
                 .getService(Ci.nsICategoryManager);

  catMgr.addCategoryEntry("command-line-handler",
                          "a-browserstate",
                          "@google.com/browserstate/application;1",
                          true, true);

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
