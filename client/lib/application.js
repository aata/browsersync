// Copyright (C) 2005 and onwards Google, Inc.

/**
 * The main shell of clobber. Responsible for startup, shutdown, and various
 * bits of application state.
 */

function CLB_Application() {
  this.initialized_ = false;
  this.originalHandlers_ = [];
  this.isFirstRun = false;

  this.obsSvc_ = Cc["@mozilla.org/observer-service;1"]
                  .getService(Ci.nsIObserverService);

  this.catMan_ = Cc["@mozilla.org/categorymanager;1"]
                   .getService(Ci.nsICategoryManager);

  this.promptSvc_ = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                      .getService(Ci.nsIPromptService);

  this.extMan_ = Cc["@mozilla.org/extensions/manager;1"]
                   .getService(Ci.nsIExtensionManager);

  this.rdfSvc_ = Cc["@mozilla.org/rdf/rdf-service;1"]
                  .getService(Ci.nsIRDFService);

  this.startSeq_ = new CLB_StartupSequence();
  this.prefs = new G_Preferences("extensions.browserstate.", false, true);
  this.googPrefs = new G_Preferences("extensions.google.browserstate.", false,
                                     true);
  this.debugPrefs = new G_Preferences("google-debug-service.", false, true);
  
  this.browserPrefs = new G_Preferences("browser.", false, true);
                                
  this.bmSyncer = new CLB_BookmarkSyncer();
  CLB_syncMan.registerComponent(this.bmSyncer);

  this.tabSyncer = new CLB_TabSyncer();
  CLB_syncMan.registerComponent(this.tabSyncer);

  this.settingsSyncer = new CLB_SettingsSyncer();
  CLB_syncMan.registerComponent(this.settingsSyncer);

  this.passwordSyncer = new CLB_PasswordSyncer();
  CLB_syncMan.registerComponent(this.passwordSyncer);

  this.cookieSyncer = new CLB_CookieSyncer();
  CLB_syncMan.registerComponent(this.cookieSyncer);
  
  this.historySyncer = new CLB_HistorySyncer();
  CLB_syncMan.registerComponent(this.historySyncer);
  
  this.prefSvc_ = Cc["@mozilla.org/preferences-service;1"]
                    .getService(Ci.nsIPrefService);

  this.appInfo_ = Cc["@mozilla.org/xre/app-info;1"]
                  .getService(Ci.nsIXULAppInfo)
                  .QueryInterface(Ci.nsIXULRuntime);

  // Autoupdate-related
  this.updater_ = null;
  this.updateLoop_ = null;
  this.uninstalled_ = false;

  // Used by browseroverlay to show initial URL to help a user resolve their
  // problem in the case of some errors.
  this.errorURL = null;
  this.errorURLShown = false;
  
  this.reconnectTime_ = 0;
  this.uniqueCount_ = 0;

  this.base64r = new G_Base64();

  // Because of a very strange bug in FF that makes only one of our pref
  // observers get called sometimes, I just keep a list of them here and proxy
  // the notification through a single observer.
  this.statusObservers_ = [];

  // Used by updater and browseroverlay to figure out whether to show the
  // restoreUI when auto-reconnecting.
  this.lastKickTime = null;
}

CLB_Application.STATUS_ONLINE = 0;
CLB_Application.STATUS_OFFLINE = 1;
CLB_Application.STATUS_KICKED = 2;
CLB_Application.STATUS_UPDATE_ERROR = 3;
CLB_Application.STATUS_NEEDS_CAPTCHA = 4;
CLB_Application.STATUS_PING_REDIRECT = 5;
CLB_Application.STATUS_BACKED_OFF = 6;
CLB_Application.STATUS_FORCED_UPDATE_DOWNLOADING = 7;
CLB_Application.STATUS_FORCED_UPDATE = 8;
CLB_Application.STATUS_LASTSYNC_TOO_OLD = 9;

CLB_Application.PROGRESS_UNOFFLINING = "Processing offline changes...";
CLB_Application.PROGRESS_GATHERING = "Gathering local changes...";
CLB_Application.PROGRESS_INDEXING = "Preparing conflict resolution rules...";
CLB_Application.PROGRESS_DOWNLOADING = "Downloading server changes...";
CLB_Application.PROGRESS_PARSING = "Processing server changes...";
CLB_Application.PROGRESS_RESOLVING = "Applying conflict resolution rules...";
CLB_Application.PROGRESS_PREPARING = "Preparing server update...";
CLB_Application.PROGRESS_UPDATING = "Updating server...";
CLB_Application.PROGRESS_APPLYING = "Updating browser...";

CLB_Application.MESSAGE_WORKING_OFFLINE = 
  "Google Browser Sync will not run while you are working offline.";
  
// Used by CLB_app.backOffMessage
CLB_Application.MESSAGE_BACKED_OFF = 
  "The Google Browser Sync server has requested that you stay offline "
  + "for %s because \"%s\"";

CLB_Application.HTTP_STATUS_FORBIDDEN = 403;
CLB_Application.HTTP_STATUS_UNAVAILABLE = 503;

CLB_Application.ERROR_LASTSYNC_TOO_OLD = 
  "Timestamp of last sync too old. Perform full resync.";

CLB_Application.ERROR_INVALID_PIN = "Invalid token.";
CLB_Application.MESSAGE_INVALID_PIN = 
  "Your PIN was incorrect.";

CLB_Application.ERROR_SINGLE_UPLOAD_LIMIT = 
  "Update exceeds single upload limit.";
CLB_Application.MESSAGE_SINGLE_UPLOAD_LIMIT = 
  "You have tried to upload too much stuff, you need to disable "
  + "some components.";

CLB_Application.ERROR_DAILY_UPLOAD_LIMIT = 
  "Daily upload quota exceeded.";
CLB_Application.MESSAGE_DAILY_UPLOAD_LIMIT = 
  "You've uploaded too much stuff today.";
  
CLB_Application.ERROR_PIN_LIMIT =
  "Too many invalid PINs provided."
CLB_Application.MESSAGE_PIN_LIMIT =
  "PIN authentication has failed too many times."
  
CLB_Application.ERROR_SERVER_UNAVAILABLE = 
  "Server unavailable.";
CLB_Application.MESSAGE_SERVER_UNAVAILABLE =
  "The Google Browser Sync server was unavailable."

CLB_Application.ERROR_CLIENT_TOO_OLD =
  "The version of Google Browser Sync you are running is too old.  "
  + "Please upgrade to the newest version at "
  + "http://tools.google.com/firefox/browsersync.";
  
CLB_Application.CIPHER_DISCARD_BYTES = 1536;
CLB_Application.MAX_LOG_AGE = 48 * 3600000; // 48 hours
CLB_Application.LOG_ROTATE_INTERVAL = 24 * 3600000; // 24 hours
CLB_Application.UPDATE_CYCLE = 24 * 3600000; // 24 hours
CLB_Application.RECONNECT_MAX_TIME = 600000; // 10 minutes

CLB_Application.CONFLICTING_EXTENSIONS = [
  "{909409b9-2e3b-4682-a5d1-71ca80a76456}" /* SessionSaver */
];

CLB_Application.prototype.debugZone = "CLB_Application";

CLB_Application.prototype.isKickError = function(code, status, message) {
  if (code == CLB_Application.HTTP_STATUS_FORBIDDEN &&
      message == "Invalid mid.") {
    return true;
  } else {
    return false;
  }
}

CLB_Application.prototype.handleClientTooOldError =
function(code, status, message) {
  if (code != CLB_Application.HTTP_STATUS_FORBIDDEN ||
      message != CLB_Application.ERROR_CLIENT_TOO_OLD) {
    return false /* not a client too old error */;
  }

  this.setStatus(CLB_Application.STATUS_FORCED_UPDATE_DOWNLOADING);

  this.updater_ = new G_ExtensionUpdater("browserstate@google.com");
  this.updater_.OnSuccess = this.handleForcedUpdateSuccess_.bind(this);
  this.updater_.OnFail = this.handleForcedUpdateFailure_.bind(this);
  this.updater_.Update();

  return true /* handled */;
}

CLB_Application.prototype.handleLastSyncTooOldError =
function(code, status, message) {
  if (code != CLB_Application.HTTP_STATUS_FORBIDDEN ||
      message != CLB_Application.ERROR_LASTSYNC_TOO_OLD) {
    return false /* not a client too old error */;
  }

  // Browseroverlay will hear the status change and present the
  // user with a 'resync' bubble.
  this.setStatus(CLB_Application.STATUS_LASTSYNC_TOO_OLD);

  return true /* handled */;
}

CLB_Application.prototype.handleServerError =
function(code, status, opt_message) {
  G_DebugL(this, 
           "Server Error: code: %s, status: %s, message: %s"
           .subs(code, opt_message));
  
  if (!opt_message) {
    opt_message = "";
  }

  // In case the message is extremely long. Thinking here of 404 errors, but
  // there could also be other ones like proxy errors, etc.
  opt_message = opt_message.substring(0, 100);

  // Default reason in case we don't find a more specific one below
  var reason = "An unexpected error has occured. Please try again later.\n"
               + "%s: %s\n%s".subs(code, status, opt_message);


  // Try to come up with a more specific error message
  var message = opt_message.split("\n");
  
  if (code == CLB_Application.HTTP_STATUS_FORBIDDEN) {
    switch (message[0]) {
      case CLB_Application.ERROR_SINGLE_UPLOAD_LIMIT:
        reason = CLB_Application.MESSAGE_SINGLE_UPLOAD_LIMIT;
        break;
      case CLB_Application.ERROR_DAILY_UPLOAD_LIMIT:
        reason = CLB_Application.MESSAGE_DAILY_UPLOAD_LIMIT;
        break;
      case CLB_Application.ERROR_PIN_LIMIT:
        reason = CLB_Application.MESSAGE_PIN_LIMIT;
        break;
      case CLB_Application.ERROR_INVALID_PIN:
        reason = CLB_Application.MESSAGE_INVALID_PIN;
        break;
    }
  } else if (code == CLB_Application.HTTP_STATUS_UNAVAILABLE) {
    switch (message[0])  {
      case CLB_Application.ERROR_SERVER_UNAVAILABLE:
        reason = CLB_Application.MESSAGE_SERVER_UNAVAILABLE;
        break;
    }
  } else if (code == CLB_Updater.ERROR_UPLOAD_TOO_LARGE) {
    reason = "Upload too large. Try disabling some components.";
  } else if (code == CLB_RequestFactory.ERR_COULD_NOT_CONTACT_SERVER) {
    reason = "Network connection error. Please check your network settings"
             + " and try again.";
  }

  // TODO: We should make this specific to a certain code.
  // Detect and handle backoff
  if (message.length > 1 && message[1].indexOf("BACKOFF=") == 0) {
    var seconds = parseInt(message[1].split("=")[1]);
    CLB_app.backOff(seconds * 1000 /* milliseconds */, reason);
    
    reason += " Please try again in %s."
              .subs(this.timeDifference(seconds / 3600));
  }

  return reason;
}

CLB_Application.prototype.isGAIATimeoutError =
function(code, status, message) {
  if (code == CLB_Application.HTTP_STATUS_FORBIDDEN &&
      message == "Invalid SID cookie." ||
      message == "Need to refresh SID cookie.") {
    return true;
  } else {
    return false;
  }
}

CLB_Application.prototype.isInvalidKeyError = function(code, status, message) {
  if (code == CLB_Application.HTTP_STATUS_FORBIDDEN &&
      message == "Invalid key.") {
    return true;
  } else {
    return false;
  }
}

CLB_Application.prototype.isInvalidUserError = function(code, status, message) {
  if (code == CLB_Application.HTTP_STATUS_FORBIDDEN &&
      message == "Account does not exist for this user.") {
    return true;
  } else {
    return false;
  }
}

// TODO: All these get/setFoo functions are left over from when these values
// needed to be stored in files because they were outside of a profile. Now they
// can go into prefs and we can replace all these with calls to CLB_app.prefs
// directly. This comment doesn't apply to get/setToken, OR ELSE.

CLB_Application.prototype.getMID = function() {
  return this.prefs.getPref("MID");
}

CLB_Application.prototype.setMID = function(val) {
  this.maybeSetPref_("MID", val);
}

CLB_Application.prototype.getSID = function() {
  return this.prefs.getPref("SID");
}

CLB_Application.prototype.setSID = function(val) {
  this.maybeSetPref_("SID", val);
}

CLB_Application.prototype.getUsername = function() {
  return this.prefs.getPref("username");
}

CLB_Application.prototype.setUsername = function(val) {
  this.maybeSetPref_("username", val);
}

CLB_Application.prototype.getKeyBytes = function() {
  return this.base64r.decodeString(this.getKey());
}

CLB_Application.prototype.getKey = function() {
  return this.prefs.getPref("key");
}

CLB_Application.prototype.setKey = function(val) {
  this.maybeSetPref_("key", val);
}

CLB_Application.prototype.getEncryptedKey = function() {
  return this.prefs.getPref("encryptedKey");
}

CLB_Application.prototype.setEncryptedKey = function(val) {
  this.maybeSetPref_("encryptedKey", val);
}

CLB_Application.prototype.getToken = function() { 
  var blindToken = CLB_app.prefs.getPref("blindToken");
  var token = CLB_app.prefs.getPref("token");
  
  if (!blindToken && token) {
    // User is using an old-style, unobfuscated token, delete it 
    // and add the new, fancy blindToken
    this.setToken(token);
    this.maybeSetPref_("token", "");
    return this.getToken();
  } else {
    var encoder = new G_Base64();
    return encoder.stringifyArray(encoder.decodeString(blindToken));
  }
}

CLB_Application.prototype.setToken = function(str) {
  var encoder = new G_Base64();

  this.maybeSetPref_("blindToken", 
                     encoder.encodeByteArray(encoder.arrayifyString(str)));
}

CLB_Application.prototype.getCrypter2 = function() {
  if (!this.crypter2_) {
    this.crypter2_ = new CLB_Crypter2(this.getKeyBytes());
  }

  return this.crypter2_;
}

CLB_Application.prototype.getHMacer = function() {
  if (!this.hmacer_) {
    var hasher = new G_CryptoHasher();
    hasher.init(G_CryptoHasher.algorithms.SHA1);
    this.hmacer_ = new G_HMAC(new SHA1(), this.getKeyBytes());
  }

  return this.hmacer_;
}

CLB_Application.prototype.savePrefs = function() {
  this.prefSvc_.savePrefFile(null /* default prefs file */);
}

/**
 * Returns true if the application is correctly setup. That is, if all the state
 * which gets saved by welcomeform exists.
 */
CLB_Application.prototype.setupIsComplete = function() {
  return Boolean(this.getSID() && this.getKey() && this.getMID() &&
                 this.getToken());
}

CLB_Application.prototype.isBackedOff = function() {
  return (this.getStatus() == CLB_Application.STATUS_BACKED_OFF ||
          new Date().valueOf() < this.prefs.getPref("backoff", 0));
}

CLB_Application.prototype.timeDifference = function(hours) {
  var difference = "";
  
  if (hours > 168) {
    // This shouldn't happen - if it does, we can assume that the user has
    // probably been messing with their system clock. So let's keep the user
    // offline and set the backoff time to a week from now.
    this.backOff(168 * 3600 * 1000);
    difference = "a week (sorry!)";
  } else if (hours > 36) {
    difference = "about %s days".subs(Math.ceil(hours / 24));
  } else if (hours > 20) {
    difference = "about a day";
  } else if (hours > 2) {
    difference = "about %s hours".subs(Math.ceil(hours));
  } else if (hours > 0.75) {
    difference = "an hour or so";
  } else if (hours > 0) {
    difference = "about %s more minutes".subs(Math.ceil(hours * 60));
  } else {
    // Should only happen if the backoff time expires between failing
    // due to backoff, and displaying the backoff message, so let's 
    // just fail nicely
    difference = "in a moment"; 
  }
  
  return difference;
}

/**
 * Returns a friendly "backoff" message with some very approximate times
 */
CLB_Application.prototype.backOffMessage = function() {
  var remainingStr = "";
  var hours = (this.prefs.getPref("backoff", 0) - new Date().valueOf())
              / 3600000; // hours (3600 seconds * 1000 milliseconds)
  var reason = this.prefs.getPref("backoffReason", "No Reason Given");
  
  return CLB_Application.MESSAGE_BACKED_OFF
           .subs(this.timeDifference(hours), reason);
}

CLB_Application.prototype.canReconnect = function() {
  if (this.isBackedOff()) {
    return false;
  } else {
    return (new Date() < this.reconnectTime_);
  }
}

/**
 * Server has told us not to send it anything for period 'time'. So we
 * tell ourselves not to send anything during the next 'time' period, 
 * and then begin reconnecting.
 *
 * @see #canReconnect
 * @param {Number} Time in milliseconds
 */
CLB_Application.prototype.backOff = function(time, reason) {
  // TODO: We should be aware of backoff time corruption -
  // if the user has a clock far forward in the future, then sets
  // it back, they may be unable to reconnect for yonks.
  var backoffTime = (new Date()).valueOf() + time;
  
  this.prefs.setPref("backoff", String(backoffTime)); // integer can't hold a 
                                                      // number this large
  this.prefs.setPref("backoffReason", String(reason));
                                                      
  this.reconnectTime_ = backoffTime + CLB_Application.RECONNECT_MAX_TIME;

  CLB_app.setStatus(CLB_Application.STATUS_BACKED_OFF);
}

/**
 * Returns true if we are in a state where we should attempt to 
 * send things to the server. If we detect that we've been in
 * a 'STATUS_UNKNOWN_ERROR' state for too long, we also set the
 * user to offline.
 */
CLB_Application.prototype.canSend = function() {
  var status = this.getStatus();
  
  if (!isDef(status)) {
    return true;
  } else if (status == CLB_Application.STATUS_ONLINE) {
    return true;
  } else if (status == CLB_Application.STATUS_UPDATE_ERROR) {
    if (this.canReconnect()) {
      return true;
    } else {
      return false;
    }
  }
  
  return false;
}

CLB_Application.prototype.setStatus = function(statusCode) {
  // If we've gone into a 'STATUS_UPDATE_ERROR', set reconnectTime_ so
  // we known when to stop retrying.
  if (statusCode == CLB_Application.STATUS_UPDATE_ERROR &&
      this.getStatus() != CLB_Application.STATUS_UPDATE_ERROR) {
    G_Debug(this, "Setting reconnect time");
    this.reconnectTime_ = (new Date()).valueOf() 
                          + CLB_Application.RECONNECT_MAX_TIME;
  }

  this.prefs.setPref("status", statusCode);
}

CLB_Application.prototype.getStatus = function() {
  return this.prefs.getPref("status");
}

CLB_Application.prototype.getVersion = function() {
  if (!this.version_) {
    var item = this.extMan_.getItemForID("browserstate@google.com");
    this.version_ = item.version;
  }

  return this.version_;
}

CLB_Application.prototype.isLinux = function() {
  return this.appInfo_.OS == "Linux";
}

CLB_Application.prototype.isMac = function() {
  return this.isMac_;
}

CLB_Application.prototype.handleStatusChange_ = function() {
  for (var i = 0, obs; obs = this.statusObservers_[i]; i++) {
    obs();
  }
}

CLB_Application.prototype.addStatusObserver = function(observer) {
  G_Debug(this, "Adding status observer...");
  
  if (this.statusObservers_.indexOf(observer) > -1) {
    G_DebugL(this, "Status observer already exists! Skipping...");
    return;
  }

  this.statusObservers_.push(observer);
  G_Debug(this, "Done.");
}

CLB_Application.prototype.removeStatusObserver = function(observer) {
  G_Debug(this, "Removing status observer...");
  var idx = this.statusObservers_.indexOf(observer);

  if (idx == -1) {
    G_DebugL(this, "Could not find observer! Skipping.");
    return;
  }

  this.statusObservers_.splice(idx, 1);
  G_Debug(this, "Done.");
}

CLB_Application.prototype.setListPref = function(prefName, list) {
  var escaped = new Array(list.length);

  for (var i = 0; i < list.length; i++) {
    escaped[i] = escape(list[i]);
    G_Debug(this, "Adding '%s'".subs(escaped[i]));
  }

  this.prefs.setPref(prefName, escaped.join(","));
}

/**
 * Deletes the user's stored preferences.
 */
CLB_Application.prototype.deleteUserSettings = function() {
  this.prefs.clearPref("SID");
  this.prefs.clearPref("MID");
  this.prefs.clearPref("key");
  this.prefs.clearPref("encryptedKey");
  this.prefs.clearPref("token");
  this.prefs.clearPref("blindToken");
  this.prefs.clearPref("username");
  this.prefs.clearPref("lastUpdate");
  this.prefs.clearPref("lastSync");
  this.prefs.clearPref("encryptedComponents");
  this.prefs.clearPref("syncedComponents");
  this.prefs.clearPref("hasOfflineData");
  this.prefs.clearPref("reimport");
  this.prefs.clearPref("status");
  this.prefs.clearPref("showWelcome");
  this.prefs.clearPref("reimportPasswords");
  
  var reimportPrefNames =
    this.prefs.getChildNames(CLB_SyncManager.REIMPORT_PREF_PREFIX);

  for (var i = 0, name; name = reimportPrefNames[i]; i++) {
    this.prefs.clearPref(name);
  }
}

/**
 * Autoupdates
 */
CLB_Application.prototype.autoupdate = function() {
  var p = new G_Preferences(null, false, true);
  if (!p.getPref("extensions.google.browserstate.autoupdate", false)) {
    G_DebugL(this, "Browser not set to autoupdate, skipping.");
    return;
  }
  
  this.updater_ = new G_ExtensionUpdater("browserstate@google.com"); 
  this.updater_.Update();

  // Start a periodic update cycle  
  if (!this.updateLoop_) {
    this.updateLoop_ = new G_Alarm(this.autoupdate.bind(this), 
                                   CLB_Application.UPDATE_CYCLE, 
                                   true /* repeat */);
  }
}

/**
 * Called when an autoupdate is complete. Tell the user such.
 */
CLB_Application.prototype.handleForcedUpdateSuccess_ = function() {
  this.setStatus(CLB_Application.STATUS_FORCED_UPDATE);
}

/**
 * Called when an autoupdate fails.
 */
CLB_Application.prototype.handleForcedUpdateFailure_ = function(opt_message) {
  this.setStatus(CLB_Application.STATUS_OFFLINE);

  var message = opt_message || "Unknown error";

  Cc["@mozilla.org/embedcomp/prompt-service;1"]
    .getService(Ci.nsIPromptService)
    .alert(null /* no parent window */,
           "Google Browser Sync",
           "Error while updating: %s".subs(message));
}

/**
 * We use two settings for workqueue cpu -- one for foreground syncs when there
 * is a modal dialog, and one for background syncs when there is no dialog. For
 * background syncs, we want to use much less CPU so that the browser is still
 * visible. This makes the sync take longer, but that's OK since we typically do
 * background syncs when there is less to do :-)
 */
CLB_Application.prototype.setWorkQueueCPU = function(isForegroundSync) {
  if (isForegroundSync) {
    G_WorkQueue.defaultPauseTime = 0;
  } else {
    G_WorkQueue.defaultPauseTime = 100;
  }
}

CLB_Application.prototype.getListPref = function(prefName) {
  var list = this.prefs.getPref(prefName, "");

  if (list == "") {
    list = [];
  } else {
    list = list.split(",");

    for (var i = 0; i < list.length; i++) {
      list[i] = unescape(list[i]);
    }
  }

  return list;
}

CLB_Application.prototype.maybeSetPref_ = function(name, val) {
  if (val) {
    this.prefs.setPref(name, val);
  } else {
    this.prefs.clearPref(name);
  }
}

/**
 * Set the pref if it isn't already set
 */
CLB_Application.prototype.defaultDebugPref_ = function(name, val) {
  if (!isDef(this.debugPrefs.getPref(name))) {
    this.debugPrefs.setPref(name, val);
  }
}

/**
 * Set the pref based on whether or not we are in debug mode
 */
CLB_Application.prototype.setDebugPref_ = function(prefs, name,
                                                   debVal, releaseVal) {
  if (typeof prefs.getPref(name) == "undefined") {
    if (CLB_DEBUG) {
      prefs.setPref(name, debVal);
    } else {
      prefs.setPref(name, releaseVal);
    }
  }
}

/**
 * Implements nsICommandLineHandler.handle(). We register the Clobber client as
 * a command-line handler with a high priority (see bootstrap.js) so that it
 * executes before other command-line handlers like the browser content handler.
 *
 * This gives us an opportunity to show the login dialog. Once login is
 * complete, or once the user dismisses it, we let startup proceed as normal.
 *
 * Tried lots of different ways to accomplish this, and this is the least worst
 * I could find. The requirements it needs to address:
 *
 * - Once login happens, open the browser the same exact way it would have if
 *   Clobber was not installed. This includes opening URLs specified on the
 *   command-line and home page preferences, etc. Simple approaches such as
 *   cancelling the initial window don't address this.
 *
 * - Don't cause command line handlers to execute more than once. Most of them
 *   probably are not written to expect such a thing.
 *
 * - Intercept all the different ways of starting the browser.
 */
CLB_Application.prototype.handle = function(cmdLine) {
  if (this.initialized_) {
    return;
  }

  this.initialized_ = true;
  this.cmdLine_ = cmdLine;

  // EVIL! Unregister all the command-line handlers :-) Since we remove them
  // non-permanently, we do no real damage. And this is far easier than trying
  // to intercept every possible handler which could be registered. It also
  // has the advantage of preserving any expectations handlers had about being
  // called only once.

  // TODO: Hurry up and implement non-modal login so that this madness can
  // go away. Also, keep looking for better alternatives.
  if (!this.setupIsComplete()) {
    var handlersEnum = this.catMan_.enumerateCategory("command-line-handler");

    // save a list of all the current handlers so we can add them back later
    while (handlersEnum.hasMoreElements()) {
      var entry = handlersEnum.getNext()
                              .QueryInterface(Ci.nsISupportsCString).data;

      var value = this.catMan_.getCategoryEntry("command-line-handler", entry);

      this.originalHandlers_.push({ entry : entry,
                                    value : value });
    }

    // now delete them all
    this.catMan_.deleteCategory("command-line-handler");
  }

  this.start();
}

// nsIObserver
CLB_Application.prototype.observe = function(subject, topic, data) {
  if (topic == "quit-application") {
    this.handleApplicationQuit();
  } else if (topic == "em-action-requested" && data == "item-uninstalled") {
    var updateItem = subject.QueryInterface(Ci.nsISupports)
                            .QueryInterface(Ci.nsIUpdateItem);
    
    if (updateItem.id == "browserstate@google.com") {
      G_DebugL(this, "Google Browser Sync is being uninstalled.");
      this.uninstalled_ = true;
    }
  } else {
    throw new Error("Caught unexpected topic {" + topic + "}.");
  }
}

/**
 * Initialize all the core settings of the Clobber client and then kick off
 * CLB_StartupSequence.
 */
CLB_Application.prototype.start = function() {
  this.initializeLog();

  // Arrange for to rotate this log later on.
  new G_Alarm(this.rotateLogs.bind(this),
              this.prefs.getPref("log-rotate-interval",
                                 CLB_Application.LOG_ROTATE_INTERVAL),
              true /* repeat */);

  this.setDebugPref_(this.googPrefs, "autoupdate", false, true);
  this.setDebugPref_(this.debugPrefs, "alsologtoshell", true, false);
  this.setDebugPref_(this.prefs, "log-xml", true, false);

  // We don't even want this preference to show up in release builds. No reason
  // to tempt people :)
  if (CLB_DEBUG && !isDef(this.prefs.getPref("show-debug-menu"))) {
    this.prefs.setPref("show-debug-menu", true);
  }

  CLB_app.prefs.clearPref("status");
  
  this.maybeRunUnitTests();
  this.prefs.addObserver("status", this.handleStatusChange_.bind(this));

  this.isMac_ = Cc["@mozilla.org/appshell/appShellService;1"]
                .getService(Ci.nsIAppShellService)
                .hiddenDOMWindow
                .navigator.platform.substring(0, 3).toLowerCase() == "mac";

  if (this.setupIsComplete()) {
    this.handleStartupSequenceSuccess();
  } else {
    this.isFirstRun = true;
    this.startSeq_.start(this.handleStartupSequenceSuccess.bind(this),
                         this.handleStartupSequenceFailure.bind(this));
  }
}

/**
 * Callback for a successful login/startup dialog procession
 */
CLB_Application.prototype.handleStartupSequenceSuccess = function() {
  this.setStatus(CLB_Application.STATUS_ONLINE);

  CLB_syncMan.start();

  if (this.isFirstRun) {
    this.startBrowser();
  }

  this.obsSvc_.addObserver(this, "quit-application", false);
  this.obsSvc_.addObserver(this, "em-action-requested", false);
}

/**
 * Callback for an unsuccessful startup sequence
 */
CLB_Application.prototype.handleStartupSequenceFailure = function() {
  G_Debug(this, "Unsuccessful start sequence... not starting syncmanager");

  if (!isDef(this.getStatus())) {
    this.setStatus(CLB_Application.STATUS_OFFLINE);
  }

  // If an SID is present it means this profile is setup, it's just not
  // connected to the server at the moment. We still need to record changes. If
  // there is no SID, we've not been setup yet, so we shouldn't do anything.
  if (this.getSID()) {
    CLB_syncMan.start();
  }
  
  this.startBrowser();

  this.obsSvc_.addObserver(this, "quit-application", false);
  this.obsSvc_.addObserver(this, "em-action-requested", false);
}

/**
 * Callback for application quit. We use this time to do a last final update
 * of any changed state.
 */
CLB_Application.prototype.handleApplicationQuit = function() {
  // only try to update if we're logged in
  if (CLB_app.getSID()) {
    // Don't try to do this again after this
    this.obsSvc_.removeObserver(this, "quit-application");

    // If we don't have any pending changes, don't show the updating window, OR
    // If we are currently sending an update, open the updating window (which
    // may send nothing, but its observers should listen for the completion of
    // the current update.
    if (CLB_syncMan.checkPending() || 
        CLB_syncMan.checkSending()) {
      // launch the final updating window
      Cc["@mozilla.org/embedcomp/window-watcher;1"]
        .getService(Ci.nsIWindowWatcher)
        .openWindow(null /* no parent */,
                    "chrome://browserstate/content/updating.xul",
                    "browserstate-updating",
                    "modal,centerscreen,chrome",
                    null /* no arguments */);
    } else {
      G_Debug(this, "Skipping final update because there is nothing pending.");
    }
  }

  if (!this.uninstalled_) {
    this.cleanUpLogs();
  } else {
    // If we're set to be uninstalled, wipe the preferences.
    CLB_syncMan.stopSyncedComponents();
    
    var prefsToDelete = this.prefs.getChildNames();

    for (var i = 0, name; name = prefsToDelete[i]; i++) {
      this.prefs.clearPref(name);
    }

    this.googPrefs.clearPref("autoupdate");

    this.obsSvc_.removeObserver(this, "em-action-requested");
    
    G_debugService.disableLogFile();

    try {
      CLB_Updater.getOfflineFile().remove(false /* don't recurse */);
    } catch (e) {
      G_DebugL(this, "ERROR deleting offline file: %s".subs(e.toString()));
    }
    
    try {
      this.logFolder_.remove(true /* recurse */);
    } catch (e) {
      G_DebugL(this, "ERROR deleting log folder: %s".subs(e.toString()));
    }
    
    this.logFolder_ = null;
  }
}

/**
 * Detects conflicting extensions and disables them, then restarts the browser.
 * true is returned if we will be restarting, false otherwise.
 */
CLB_Application.prototype.detectConflicts = function() {
  G_Debug(this, "Looking for conflicting extensions...");

  var itemDisabled = false;

  for (var i in CLB_Application.CONFLICTING_EXTENSIONS) {
    var extID = CLB_Application.CONFLICTING_EXTENSIONS[i];
    var extItem = this.extMan_.getItemForID(extID);

    if (extItem && extItem.name) {
      G_Debug(this, "{%s} conflicts. Checking whether disabled."
                    .subs(extID));

      if (!this.extensionIsDisabled(extID)) {
        G_Debug(this, "Asking user...");

        var msg = ("You have '%s' installed - it may conflict with Google "
                   + "Browser Sync. Disable it?")
                  .subs(extItem.name);

        var res = this.promptSvc_.confirm(this.win, "Conflicting Extension",
                                          msg);

        if (res) {
          G_Debug(this, "User has cancelled install because of conflicting " +
                        "extension.");
          this.extMan_.disableItem(extID);
          this.logOff();
          return true;
        } else {
          G_Debug(this, "User is going for it. Booya.");
        }
      }
    }
  }

  return false;
}

/**
 * Somehow manages to determine if an extension is diabled.
 */
CLB_Application.prototype.extensionIsDisabled = function(id) {
  var ns = "http://www.mozilla.org/2004/em-rdf#";

  var thisApi = this.rdfSvc_.GetResource("urn:mozilla:item:" + id);
  var is = this.rdfSvc_.GetResource(ns + "userDisabled");
  var so = this.rdfSvc_.GetResource(ns + "appDisabled");
  var stupid = this.rdfSvc_.GetLiteral("true");
  var truthVal = true; // look for the positive assertion, not the negative

  return (this.extMan_.datasource.HasAssertion(thisApi, is, so, truthVal) ||
          this.extMan_.datasource.HasAssertion(thisApi, is, stupid, truthVal));
}

/**
 * Starts the browser by executing the same command-line handlers that would
 * have gotten executed had we not stepped in first and removed them.
 *
 * This code simulates nsCommandLine.Run (http://lxr.mozilla.org/mozilla1.8/
 * source/toolkit/components/commandlines/src/nsCommandLine.cpp#588). That
 * interface is non-scriptable, so we have to duplicate what it does. Luckily,
 * it's trivial.
 *
 * Also, we re-register the original command-line handlers back the way they
 * were before our handle() method so that they receive future command-line
 * events properly, like when the OS calls firefox for a clicked link. See
 * bug 148732.
 */
CLB_Application.prototype.startBrowser = function() {
  G_Debug(this, "Calling original handlers...");

  // re-register the handlers
  this.originalHandlers_.forEach(function(entryData) {
    this.catMan_.addCategoryEntry("command-line-handler",
                                  entryData.entry,
                                  entryData.value,
                                  false /* should already be persisted */,
                                  false /* shouldn't be anything to replace */);
  }, this);

  this.originalHandlers_.forEach(function(entryData) {
    G_Debug(this, "  %s: %s".subs(entryData.entry, entryData.value));
    var handler = Cc[entryData.value].getService(Ci.nsICommandLineHandler);

    try {
      G_Debug(this, "telling " + handler + " to handle");
      handler.handle(this.cmdLine_);
    } catch (e) {
      // silently swallow errors other than NS_ERROR_ABORT; this is what
      // nsICommandLineRunner.run() specifies.
      if (e == Components.results.NS_ERROR_ABORT) {
        throw e;
      } else {
        G_Debug(this, "Swallowing error {%s}".subs(e));
      }
    }
  }, this);
  
  G_Debug(this, "Done.");
}

/**
 * Logs the current Clobber user off and brings back the login dialog.
 */
CLB_Application.prototype.logOff = function() {
  // Right now, this just restarts (which brings up the login screen again). 
  // In the future, it would be better if we could bring the login screen up 
  // on top of existing windows, but need merging support for that.
  Cc["@mozilla.org/toolkit/app-startup;1"]
    .getService(Ci.nsIAppStartup)
    .quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eForceQuit);
}

/**
 * Delete old log files, as defined by a preference. 
 */
CLB_Application.prototype.cleanUpLogs = function() {
  G_Debug(this, "Clearing old log files...");

  var files = this.logFolder_.directoryEntries;
  var startTime = new Date().getTime();
  
  var maxLogAge = this.prefs.getPref("max-log-age",
                                     CLB_Application.MAX_LOG_AGE);

  var clearDate = new Date().getTime() - maxLogAge;
  var file;
 
  while (files.hasMoreElements()) {
    file = files.getNext().QueryInterface(Ci.nsILocalFile);

    var filename = "";
    
    try {
      filename = file.leafName;
      
      if (file.lastModifiedTime <= clearDate) {
        G_Debug(this, "Removing old log file: {%s}".subs(filename));
        
        file.remove(false);
      }
    } catch (e) {
      G_DebugL(this,
               "ERROR: Could not delete or access log file"
               + "{%s},\nMessage: %s".subs(filename, e.toString()));
    }
  }

  G_Debug(this, "Success.");
}

/**
 * Called periodically. Clean up old log files and initialize a new one.
 */
CLB_Application.prototype.rotateLogs = function() {
  G_Debug(this, "Rotating log files...");
  this.cleanUpLogs();
  this.initializeLog();
}

/**
 * Initializes base logging settings for the Clobber client. The can all be
 * overriden per-FFprofile using prefs.js.
 */
CLB_Application.prototype.initializeLog = function() {
  var now = new Date();

  function pad(number, digits) {
    var ret = number.toString();
    var diff = digits - ret.length;

    for (var i = 0; i < diff; i++) {
      ret = "0" + ret;
    }

    return ret;
  }

  var logFileName = "log-%s%s%s-%s%s%s-%s.txt"
                    .subs(now.getFullYear(),
                          pad(now.getMonth() + 1, 2),
                          pad(now.getDate(), 2),
                          pad(now.getHours(), 2),
                          pad(now.getMinutes(), 2),
                          pad(now.getSeconds(), 2),
                          pad(now.getMilliseconds(), 3));

  try {
    this.logFolder_ = G_File.getProfileFile("browserstate-logs");

    if (!this.logFolder_.exists()) {
      this.logFolder_.create(Ci.nsIFile.DIRECTORY_TYPE,
                             this.logFolder_.parent.permissions);
    }

    var logFile = this.logFolder_.clone();
    logFile.append(logFileName);

    G_debugService.autoLoggify = false;
    G_debugService.setLogFile(logFile);
    G_debugService.enableLogFile();
    G_debugService.setLogFileErrorLevel(G_DebugService.ERROR_LEVEL_INFO);

    this.defaultDebugPref_("enableallzones", true);
    this.defaultDebugPref_("trace-function-calls", false);
    this.defaultDebugPref_("zone.tabbedbrowserwatcher", false);
    this.defaultDebugPref_("zone.browserwatcher", false);

    this.logHeader();
  } catch (e) {
    G_DebugL(this, "ERROR: Error initializing log: " + e);
  }
}

/**
 * Creates the startup header for the log
 */
CLB_Application.prototype.logHeader = function() {
  G_debugService.dump(
    G_File.LINE_END_CHAR +
    "==========================================================" +
    G_File.LINE_END_CHAR);

  G_debugService.dump(
    "Google Browser Sync starting up..." + G_File.LINE_END_CHAR +
    "Version: " + this.getVersion() + G_File.LINE_END_CHAR +
    "Date: " + new Date().toLocaleString() +
    G_File.LINE_END_CHAR);

  G_debugService.dump(
    "==========================================================" +
    G_File.LINE_END_CHAR +
    G_File.LINE_END_CHAR);
}

/**
 * Creates a temporary file with the specified base name in our temp directory.
 */
CLB_Application.prototype.getUniqueTempFile = function(baseName, extension) {
  var file = this.logFolder_.clone();

  file.append("%s-%s-%s.%s".subs(baseName, new Date().getTime(), 
                                 this.uniqueCount_++, extension));
  
  return file;
}

/**
 * Runs unit tests if we are in debug mode.
 */
CLB_Application.prototype.maybeRunUnitTests = function() {
  if (CLB_DEBUG) {
    if (this.prefs.getPref("skipTests", false)) {
      G_Debug(this, "Skipping unit tests...");
      return;
    }
      
    G_Debug(this, "Starting unit tests...");

    try {
      TEST_G_CryptoHasher();
      TEST_G_DoubleDictionary();
      //TEST_CLB_BookmarkEnumerator();
      TEST_CLB_BookmarkResolver();
      TEST_CLB_BookmarkSyncer();
      TEST_CLB_Conflict();
      TEST_CLB_ConflictResolver();
      TEST_CLB_CookieSyncer();
      TEST_CLB_Crypter();
      TEST_CLB_Crypter2();
      //TEST_CLB_RestoreTabsUI();
      TEST_CLB_SyncItem();
      TEST_CLB_SyncManager();
      //TEST_CLB_TabSyncer();
      TEST_CLB_UpdateQueue();
      TEST_CLB_XMLUtils();
    } catch (e) {
      G_DebugL(this,
               "Error during unit tests.\n" +
               "%s\n%s:%s".subs(e.message, e.fileName, e.lineNumber));
      throw e;
    }

    G_Debug(this, "All unit tests completed successfully.");
  }
}

G_debugService.loggifier.loggify(CLB_Application.prototype,
                                 "getToken", "setToken",
                                 "getEncryptedKey", "setEncryptedKey",
                                 "getKey", "setKey",
                                 "getSID", "setSID",
                                 "maybeSetPref_");
