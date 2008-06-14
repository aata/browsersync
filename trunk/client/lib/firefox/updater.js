// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Generic class to auto-update extensions.
 *
 * This will run in the background silently, if an update is installed,
 * users will see the standard '[extensionname] has been updated,
 * restart to ...' in the extension manager.
 *
 * G_ExtensionUpdater will look for the em:updateURL of the selected
 * extension in the extension manager RDF, if found it will compare
 * the version number of the installed extension against the version
 * number listed in the RDF at the linked updateURL. If the local
 * version is older, G_ExtensionUpdater will download and install the
 * update. This process is entirely silent, and the only way a user
 * can tell that their extension has been updated would be to look for
 * '[extensionname] will be upgraded when firefox is restarted' in
 * their extension manager. (On that note, no matter where in the
 * startup sequence you call this object, Firefox will still require
 * a restart after the extension is updated).
 *
 * If the extension was installed using the Windows Registry method
 * introduced in Firefox 1.5 and described at
 * http://developer.mozilla.org/en/docs/
 * Adding_Extensions_using_the_Windows_Registry, it's nonobvious which
 * update method your extension should use -- either the built-in Firefox
 * method (triggered by this script), or management by an external process
 * similar to whatever process wrote the registry value to begin with. The
 * default is built-in. To change this behavior (thus disabling built-in
 * updates if the registry value exists), call
 * RecognizeInstallationsByWindowsRegistry().
 *
 * ---IMPORTANT---
 * The updater is turned off by default.
 * It's dangerous in development - if you are using a redirect
 * file in your extensions directory (e.g browserstate@google.com) that
 * points to your source tree, and the auto-update finds and installs a
 * new XPI, it will delete the referenced source tree. To turn on the updater
 * for a production release, you will have to activate it manually.
 * To do this, create a browser preference named
 * 'extensions.google.[extensionname].autoupdate' and set it to true.
 * (Or you can just edit this code to change the default value.)
 *
 * Usage:
 *
 * this.updater = new G_ExtensionUpdater('browserstate@google.com');
 * this.updater.RecognizeInstallationsByWindowsRegistry();
 * this.updater.OnUpdateAvailable = this.SomeFunction.bind(this);
 * this.updater.OnSuccess = this.SomeOtherFunction.bind(this);
 * this.updater.OnFail = this.AnotherFunction.bind(this);
 * this.updater.Update();
 *
 * Or if you don't care so much:
 *
 * var d = new G_ExtensionUpdater('browserstate');
 * d.Update();
 *
 */

/**
 * @define {boolean} Whether or not to auto-update automatically. Turned off
 *     by default, so that developers don't hose themselves when running the
 *     extension out of their perforce client.
 */
var AUTOUPDATE_DEFAULT_VALUE = false;

/**
 * @param {String} id ID of extension (as used in install.rdf)
 * @param {Object} opt_requestOptions Options to send to the requester object.
 *                  format:
 *                  {
 *                    postData : "text to post",
 *                    username : "httpbasicauthusername",
 *                    password : "httpbasicauthpassword",
 *                    headers  : {
 *                      cookie : "name=value,name2=value2"
 *                      user-agent : "cheeselogs"
 *                    }
 *                  }
 * @constructor
 */
function G_ExtensionUpdater(id, opt_requestOptions) {
  if (!id) {
    G_Debug(this, "You need to specify an extension id");
  } else {
    this.RDFSvc_  = Cc["@mozilla.org/rdf/rdf-service;1"]
        .getService(Ci.nsIRDFService);

    if(opt_requestOptions) {
      this.requestOptions_ = opt_requestOptions;
    } else {
      this.requestOptions_ = {};
    }
    this.id = id;
    this.skipUpdating_ = false;
    this.updating = false;
    this.preferences = new G_Preferences("extensions.google.updater.");
  }
}

// Returns true if this extension is listed in the given Windows Registry
// hive.
G_ExtensionUpdater.prototype.CheckRegistryHive_ = function(key, hive,
                                                           extensionId) {
  try {
    key.open(hive, "SOFTWARE\\Mozilla\\Firefox\\Extensions",
             Ci.nsIWindowsRegKey.ACCESS_READ |
             Ci.nsIWindowsRegKey.ACCESS_WRITE);
  } catch (e) {
    // The key doesn't exist. Nothing to do.
    return false;
  }

  return key.hasValue(extensionId);
}

// Returns true if this extension was installed using the Windows Registry
// method.  For non-Windows platforms (actually, for platforms that haven't
// implemented an interface to the Windows Registry), always returns false.
G_ExtensionUpdater.prototype.IsInstalledByWindowsRegistry_ = function(
    extensionId) {
  var cc = Cc["@mozilla.org/windows-registry-key;1"];
  if (!cc) {
    return false;
  }

  var key = cc.createInstance(Ci.nsIWindowsRegKey);
  if (!key) {
    return false;
  }

  try {
    if (this.CheckRegistryHive_(key,
                                Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
                                extensionId)) {
      return true;
    } else {
      if (this.CheckRegistryHive_(key,
                                  Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                                  extensionId)) {
        return true;
      }
    }
  } finally {

    key.close();
  }

  return false;
}

/**
 * Sets the updater to skip updating if the extension was installed using the
 * Windows Registry method introduced in Firefox 1.5 and described at
 * http://developer.mozilla.org/en/docs/
 * Adding_Extensions_using_the_Windows_Registry. This is not default behavior,
 * though it probably should be, but we didn't want to change behavior for
 * existing extensions.
 */
G_ExtensionUpdater.prototype.RecognizeInstallationsByWindowsRegistry =
function() {
  this.skipUpdating_ = this.IsInstalledByWindowsRegistry_(this.id);
}

/**
 * Begins the update process.
 *
 * Designed so that Update can be called multiple times (e.g at set
 * intervals). Also silently returns if an update is in progress.
 */
G_ExtensionUpdater.prototype.Update = function() {
  if (this.updating || this.skipUpdating_) {
    return false;
  }

  this.updating = true;

  this.appVersion = "";
  this.appID = "";

  this.currentVersion = "";
  this.updateURL = "";

  this.updateLink = "";
  this.updateVersion = "";

  if (!this.GetCurrent()) {
    this.Failure("'%s' not found in extension manager.".subs(this.name));
    return false;
  }

  this.AttemptUpdate();
}

/**
 * For now, just update every 24 hours. We check a preference to see
 * when we last updated, and then hook a timer to update 24 hours from now.
 * Note that it is still possible, if unlikely, to have concurrent update
 * requests unless the updater is created in a global context.
 *
 * @param {boolean} opt_makeTimer if false, do not create the timer
 */
G_ExtensionUpdater.prototype.UpdatePeriodically = function(opt_makeTimer) {
  if (this.skipUpdating_) {
    return;
  }

  var lastUpdate = this.preferences.getPref(this.id, 0);
  var timeBetweenUpdates = 24 * 60 * 60 * 1000;
  // Hopefully people don't screw with the value
  var nextUpdate = Number(lastUpdate) + timeBetweenUpdates;
  var now = new Date().getTime();
  G_Debug(this, "Last update: " + lastUpdate + ", next: " + nextUpdate + "\n");
  if (now > nextUpdate) {
    this.preferences.setPref(this.id, String(now)); // int precision too low!
    this.Update();
    nextUpdate = now + timeBetweenUpdates;
  }
  if (opt_makeTimer) {
    G_Debug(this,
            "Setting timer for update in " + (nextUpdate - now) + "ms\n");
    this.loop_ = new G_Alarm(this.UpdatePeriodically.bind(this, true),
                             nextUpdate - now,
                             false);
  }
}

/**
 * Compares two version numbers
 *
 * @param {String} aV1 Version of first item in 1.2.3.4..9. format
 * @param {String} aV2 Version of second item in 1.2.3.4..9. format
 *
 * @return {number}  1 if first argument is higher
 *                   0 if arguments are equal
 *                  -1 if second argument is higher
 */
G_ExtensionUpdater.prototype.CompareVersions = function(aV1, aV2) {
  var v1 = aV1.split(".");
  var v2 = aV2.split(".");
  var numSubversions = (v1.length > v2.length) ? v1.length : v2.length;

  for (var i = 0; i < numSubversions; i++) {
    if (typeof v2[i] == 'undefined') {
      return 1;
    }

    if (typeof v1[i] == 'undefined') {
      return -1;
    }

    if (parseInt(v2[i], 10) > parseInt(v1[i], 10)) {
      return -1;
    } else if (parseInt(v2[i], 10) < parseInt(v1[i], 10)) {
      return 1;
    }
  }

  // v2 was never higher or lower than v1
  return 0;
}

/**
 * Goes through local extension manager RDF and finds the relevant details
 * for the selected extension.
 */
G_ExtensionUpdater.prototype.GetCurrent = function() {
  var updItem = Cc["@mozilla.org/extensions/manager;1"]
                .getService(Ci.nsIExtensionManager)
                .getItemForID(this.id);

  if(updItem) {
    var appInfo = Cc["@mozilla.org/xre/app-info;1"]
                  .getService(Ci.nsIXULAppInfo);

    this.name = updItem.name;
    this.currentVersion = updItem.version;
    G_Debug(this, updItem.name);
    G_Debug(this, updItem.version);
    G_Debug(this, updItem.updateRDF);

    this.updateURL = updItem.updateRDF;
    this.updateURL = this.updateURL.replace(/%ITEM_VERSION%/gi,
                                            this.currentVersion)
                                   .replace(/%ITEM_ID%/gi, this.id)
                                   .replace(/%APP_VERSION%/gi, appInfo.version)
                                   .replace(/%APP_ID%/gi, appInfo.ID);
    G_Debug(this, this.updateURL);
    return true;
  }

  return false;
}

/**
 * Connects to updateURL, retrieves and parses RDF, compares versions
 * and calls InstallUpdate if required.
 */
G_ExtensionUpdater.prototype.AttemptUpdate = function() {
  G_Debug(this, "AttemptUpdate");
  if (!this.updateURL) {
    return false;
  }

  this.req_ = new G_Requester();
  this.req_.OnSuccess = this.OnReqSuccess.bind(this);
  this.req_.OnFailure = this.OnReqFailure.bind(this);
  this.req_.Open(this.updateURL,
                 this.requestOptions_);
}

G_ExtensionUpdater.prototype.OnReqFailure = function() {
  this.Failure("OnReqFailure");
}

G_ExtensionUpdater.prototype.OnReqSuccess = function() {
  G_Debug(this, "OnReqSuccess");

  // parseString (below) doesn't throw errors - rather they come from
  // the RDF file itself, so we can't try/catch for invalid XML.
  if (this.req_.status != 200
      || !this.req_.responseText.match(/<rdf/gi)) {
    this.Failure("Error: Invalid Update RDF contents. HTTP Status '%s'"
                 .subs(this.req_.status));
    return false;
  }

  var uri = Cc["@mozilla.org/network/io-service;1"]
            .getService(Ci.nsIIOService)
            .newURI(this.updateURL, null, null);

  var parser = Cc["@mozilla.org/rdf/xml-parser;1"]
               .createInstance(Ci.nsIRDFXMLParser);

  var memoryDS = Cc["@mozilla.org/rdf/datasource;1?name=in-memory-datasource"]
                 .createInstance(Ci.nsIRDFDataSource);

  parser.parseString(memoryDS, uri, this.req_.responseText);

  G_Debug(this, "RDF loaded");

  var moz = "http://www.mozilla.org/2004/em-rdf#";

  var versionArc = this.RDFSvc_.GetResource(moz + "version");
  var updateLinkArc = this.RDFSvc_.GetResource(moz + "updateLink");

  var thisResource = null;
  var dsResources = memoryDS.GetAllResources();

  // Cycle through RDF looking for what we want what we want
  G_Debug(this, "Cycling through RDF");
  // TODO: Make sure this matches the correct GUID for Firefox
  //   also, check that update.rdf can't have some other funky format
  while (dsResources.hasMoreElements()) {
    thisResource = dsResources.getNext().QueryInterface(Ci.nsIRDFResource);

    var versionRes = memoryDS.GetTarget(thisResource, versionArc, true);

    if (versionRes) {
      this.updateVersion = versionRes.QueryInterface(Ci.nsIRDFLiteral).Value;
    }

    var updateLinkRes = memoryDS.GetTarget(thisResource, updateLinkArc, true);

    if (updateLinkRes) {
      this.updateLink = updateLinkRes.QueryInterface(Ci.nsIRDFLiteral).Value;
    }
  }

  if (this.updateVersion && this.updateLink) {
    G_Debug(this, "currentVersion:%s\nupdateVersion: %s\nupdateLink: %s"
                  .subs(this.currentVersion,
                        this.updateVersion,
                        this.updateLink));

    if (this.CompareVersions(this.updateVersion, this.currentVersion) == 1) {
      G_Debug(this, "Local version is old, now installing update...");
      this.InstallUpdate();
    } else {
      this.Failure("No need to update");
    }
  } else {
    this.Failure("No update info in rdf");
  }
}

/**
 * Starts XPI retrieval and installation.
 */
G_ExtensionUpdater.prototype.InstallUpdate = function() {
  if (!this.updateLink) {
    this.Failure("Failure");
    return false;
  }

  var manager = Cc["@mozilla.org/xpinstall/install-manager;1"]
                 .createInstance(Ci.nsIXPInstallManager);

  if (manager != null) {
    G_Debug(this, "UpdateLink: %s".subs(this.updateLink));

    this.OnUpdateAvailable();

    var items = [this.updateLink];

    // Figure out if extension should be updated (default to 'no')
    var p = new G_Preferences();
    var autoupdate = p.getPref("extensions.google.%s.autoupdate"
                               .subs(this.id.split("@")[0]),
                               AUTOUPDATE_DEFAULT_VALUE);

    if (autoupdate == false) {
      G_DebugL(this, "Extension '%s' would've been updated".subs(this.name));
      this.Success();
    } else {
      G_DebugL(this, "Extension '%s' updating...".subs(this.name));
      manager.initManagerFromChrome(items, items.length, this);
    }
  } else {
    this.Failure("Error creating manager");
  }
}

/**
 * Part of observer for initManagerFromChrome
 */
G_ExtensionUpdater.prototype.onStateChange = function(index, state, value) {
  if(state == Ci.nsIXPIProgressDialog.INSTALL_DONE) {
    G_DebugL(this, "Value: " + value);
    if(value != 0) {
      this.Failure("Download Error");
    } else {
      G_Debug(this, "Success!");
      this.Success();
    }
  }
}

/**
 * Part of observer for initManagerFromChrome
 */
G_ExtensionUpdater.prototype.onProgress = function(index, value, maxValue) {}

/**
 * Failure function
 *
 * @param {string} aMessage Error message
 */
G_ExtensionUpdater.prototype.Failure = function(aMessage) {
  G_Debug(this, "Failure: %s".subs(aMessage));

  this.updating = false;
  this.OnFail(aMessage);
}

/**
 * Success function
 */
G_ExtensionUpdater.prototype.Success = function() {
  this.updating = false;
  this.OnSuccess();
}

/**
 * Stub for callback
 *
 * @param {string} aMessage Error message
 */
G_ExtensionUpdater.prototype.OnFail = function(aMessage) {}

/**
 * Stub for callback
 */
G_ExtensionUpdater.prototype.OnSuccess = function() {}

/**
 * Stub for callback
 */
G_ExtensionUpdater.prototype.OnUpdateAvailable = function() {}

G_ExtensionUpdater.prototype.debugZone = "G_ExtensionUpdater";

/**
 * Unit tests
 */

function TEST_G_ExtensionUpdater() {
  if (G_GDEBUG) {
    var z = "G_ExtensionUpdater UNITTEST";

    G_debugService.enableZone(z);

    G_Debug(z, "Starting");

    var name = "111. This name shouldn't exist";
    var upd = new G_ExtensionUpdater(name);
    G_Assert(z, name == upd.name, "Name not inserted correctly.");
    G_Assert(z, !upd.GetCurrent(),
             "Extension found when shouldn't have.");

    function testCompare(a, b, expected) {

    }
    var a, b;

    a = "1.222.00";
    b = "1.222.01";
    G_Assert(z, upd.CompareVersions(a, b) == -1,
             "CompareVersions says %s is not higher than %s".subs(b, a));

    a = "1.22.00";
    b = "1.222.01";
    G_Assert(z, upd.CompareVersions(a, b) == -1,
             "CompareVersions says %s is not higher than %s".subs(b, a));

    a = "1.9";
    b = "1.1.1101";
    G_Assert(z, upd.CompareVersions(a, b) == 1,
             "CompareVersions says %s is not higher than %s".subs(a, b));
    G_Assert(z, upd.CompareVersions(b, a) == -1,
             "CompareVersions says %s is not higher than %s".subs(b, a));

    a = "1.1.1101";
    G_Assert(z, upd.CompareVersions(a, a) == 0,
             "CompareVersions says %s is not equal to %s".subs(a, a));

    a = "4.121";
    G_Assert(z, upd.CompareVersions(a, a) == 0,
             "CompareVersions says %s is not equal to %s".subs(a, a));


    a = "1.0000.001.121";
    b = "1.000.01.121";
    G_Assert(z, upd.CompareVersions(a, b) == 0,
             "CompareVersions says %s is not equal to %s".subs(a, b));

    G_Debug(z, "PASSED");
  }
}
