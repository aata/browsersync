// Copyright 2005 and onwards, Google


/**
 * UI controller logic for main browser window.
 */
function CLB_BrowserOverlay(win) {
  this.win_ = win;
  this.doc_ = this.win_.document;
  this.isFirstWin_ = true;

  this.statusObserver_ =
    this.handleStatusChange_.bind(this, false /* not page load */);

  this.win_.addEventListener("load", this.handleLoad_.bind(this), false);
  this.win_.addEventListener("unload", this.handleUnload_.bind(this), false);

  CLB_syncMan.addObserver(this);
}

CLB_BrowserOverlay.firstSyncStarted_ = false;

/**
 * Constants used for URL of status image.
 */
CLB_BrowserOverlay.IMAGE_ONLINE =
  "chrome://browserstate/content/icon-small.png";
CLB_BrowserOverlay.IMAGE_OFFLINE =
  "chrome://browserstate/content/icon-small-disabled.png";
CLB_BrowserOverlay.IMAGE_ANIM =
  "chrome://browserstate/content/icon-small-anim.gif";

/**
 * Constants used for status messages.
 */
CLB_BrowserOverlay.MESSAGE_LOCAL_CHANGES =
  "Your changes will be sent to the server the next time you connect. ";

CLB_BrowserOverlay.MESSAGE_KICKED =
  "Google Browser Sync is disconnected because you logged in on a different " +
  "machine. " + CLB_BrowserOverlay.MESSAGE_LOCAL_CHANGES;

CLB_BrowserOverlay.MESSAGE_OFFLINE =
  "Google Browser Sync is offline. " +
  CLB_BrowserOverlay.MESSAGE_LOCAL_CHANGES;

CLB_BrowserOverlay.MESSAGE_CAPTCHA_REQUIRED =
  "Google Browser Sync is disconnected because your account is temporarily " +
  "locked. Please verify your account and then reconnect.";

CLB_BrowserOverlay.MESSAGE_PING_REDIRECT = 
  "Google Browser Sync could not contact the server. Please verify your " +
  "network settings and then reconnect.";

CLB_BrowserOverlay.MESSAGE_SETUP =
  "Your changes are not being saved because Google Browser Sync " + 
  "has not been set up.";
  
CLB_BrowserOverlay.MESSAGE_WELCOME =
  "You've successfully installed Google Browser Sync.  Google Browser " +
  "Sync will continuously synchronize the browser settings you selected. " +
  "Click on this icon to update your settings and account info.";
  
CLB_BrowserOverlay.MESSAGE_FORCED_UPDATE =
  "Google Browser Sync needs to update itself. This may take a few minutes " +
  "and requires you to restart Firefox, but future updates will be rare. " +
  "Browser Sync will be offline until you upgrade.";

CLB_BrowserOverlay.MESSAGE_LASTSYNC_TOO_OLD = 
  "It has been too long since this client last synced, you must perform a "
  + "full sync to continue.";

CLB_BrowserOverlay.WELCOME_URL =
  "http://google.com/";

CLB_BrowserOverlay.SETTINGS_DIALOG_WIDTH = 450;

// This is just an estimate used to center the window. The real height is
// determined by the browser's sizeToContent() function in
// settingsform.handleLoad.
CLB_BrowserOverlay.SETTINGS_DIALOG_HEIGHT = 420;

CLB_BrowserOverlay.INFO_BUBBLE_WIDTH = 200;

// GISyncObserver
// Warning: these notifications may be missing during the first sync, since
// the syncMan observer is only registered after the window opens.
CLB_BrowserOverlay.prototype.syncFailure =
CLB_BrowserOverlay.prototype.updateProgress =
CLB_BrowserOverlay.prototype.updateStart = 
CLB_BrowserOverlay.prototype.updateComplete = 
CLB_BrowserOverlay.prototype.syncProgress = function() {
  // NOP
}

CLB_BrowserOverlay.prototype.syncStart = function() {
  this.setToolbarButtonImage_(CLB_BrowserOverlay.IMAGE_ANIM);
  this.cancelSyncItem_.hidden = false;
  this.cloneMenu_();
}

CLB_BrowserOverlay.prototype.syncFailure =
CLB_BrowserOverlay.prototype.syncComplete = function() {
  this.setToolbarButtonImage_(
      CLB_app.getStatus() == CLB_Application.STATUS_ONLINE ?
      CLB_BrowserOverlay.IMAGE_ONLINE :
      CLB_BrowserOverlay.IMAGE_OFFLINE);
  this.cancelSyncItem_.hidden = true;
  this.cloneMenu_();
}

/**
 * Called when browser window finishes loading. Locate DOM elements we will be
 * using.
 */
CLB_BrowserOverlay.prototype.handleLoad_ = function() {
  // Start the autoupdate loop.
  // At first, we had this in CLB_Application before the browser window
  // opened, but we were getting wierd issues where the extension would never
  // get updated successfully. It would just stay in the EM with status
  // "... will be updated when Firefox is restarted", no matter how many times
  // FF was restarted.
  if (this.isFirstWin_) {
    this.isFirstWin_ = false;
    CLB_app.autoupdate();
  }
  
  this.initializeToolbars_();

  this.tabBrowser_ = this.doc_.getElementById("content");
  this.toolbarButton_ = this.doc_.getElementById("clb-toolbarbutton");
  this.toolsMenu_ = this.doc_.getElementById("clb-toolsmenu");
  this.menu_ = this.doc_.getElementById("clb-menu");
  
  this.settingsDlg_ = null;
  this.reconnectItem_ = this.doc_.getElementById("clb-status-reconnect");
  this.settingsItem_ = this.doc_.getElementById("clb-status-settings");
  this.setupItem_ = this.doc_.getElementById("clb-status-setup");
  this.cancelSyncItem_ = this.doc_.getElementById("clb-cancel-sync");
  
  if (CLB_app.prefs.getPref("show-debug-menu", false)) {
    this.doc_.getElementById("clb-debug-menu").hidden = false;
    this.doc_.getElementById("clb-debug-separator").hidden = false;
  }

  // Use mousedown, etc over to control when we go into sleep mode.
  var handleMovement = this.handleMovement_.bind(this);
  this.win_.addEventListener("mousedown", handleMovement, false);
  this.win_.addEventListener("keypress", handleMovement, false);
  this.win_.addEventListener("focus", handleMovement, false);
  
  var nsResolver = function(prefix) {
    return G_FirefoxXMLUtils.XUL_NAMESPACE;
  }
  
  var bubbleRoot = G_FirefoxXMLUtils.selectSingleNode(
      this.doc_, "//xul:vbox[@class='clb-infobubble'][1]", nsResolver);
  var restoreBubbleRoot = G_FirefoxXMLUtils.selectSingleNode(
      this.doc_, "//xul:vbox[@class='clb-infobubble'][2]", nsResolver);

  this.tabWatcher_ = new G_TabbedBrowserWatcher(this.tabBrowser_, 
                                                "browserstate", 
                                                true /* filter about:blank */);

  this.infoBubble_ = new CLB_InfoBubble(bubbleRoot, 
                                        this.tabWatcher_, 
                                        CLB_BrowserOverlay.INFO_BUBBLE_WIDTH);

  this.tabWatcher_.registerListener(
    "tabload", partial(CLB_app.tabSyncer.onTabLoad, this.win_));
  this.tabWatcher_.registerListener(
    "tabunload", partial(CLB_app.tabSyncer.onTabUnload, this.win_));
  this.tabWatcher_.registerListener(
    "pageshow", partial(CLB_app.tabSyncer.onPageShow, this.win_));
  this.tabWatcher_.registerListener(
    "tabswitch", partial(CLB_app.tabSyncer.onTabSwitch, this.win_));
  this.tabWatcher_.registerListener(
    "tabmove", partial(CLB_app.tabSyncer.onTabMove, this.win_));

  // setup tab syncer for this window
  CLB_app.tabSyncer.onLoad(this.win_);

  // Set the username on the Clobber dropdown
  if (CLB_app.getUsername() && this.toolbarButton_) {
    this.toolbarButton_.label = CLB_app.getUsername();
  }
  
  // Show the error url in a new tab if necessary
  if (CLB_app.errorURL && !CLB_app.errorURLShown) {
    this.showURL_(CLB_app.errorURL);
    CLB_app.errorURLShown = true;
  }

  // Make sure we start up with the right status UI.
  this.handleStatusChange_(true /* isPageLoad */);

  // Initialize the restore UI
  this.restoreUI_ = new CLB_RestoreTabsUI(this.win_, 
                                          this.tabBrowser_, 
                                          restoreBubbleRoot, 
                                          this.tabWatcher_);

  this.chord_ = new CLB_Chord(this.win_, "clb");
  this.chord_.onComplete = this.handleChord_.bind(this);
  this.chord_.start();
  
  // Important: this needs to be here, as opposed to in the constructor because
  // of: https://bugzilla.mozilla.org/show_bug.cgi?id=334894
  CLB_app.addStatusObserver(this.statusObserver_);

  this.win_.setTimeout(this.delayedInit.bind(this), 1);
}

/**
 * Required because otherwise navigator-toolbox + methods won't exist
 * yet.
 */
CLB_BrowserOverlay.prototype.delayedInit = function() {
  // Watch for closing of toolbox so we can refresh ourselves.
  this.navToolbox_ = this.doc_.getElementById("navigator-toolbox");
  this.oldToolboxCustomizeDone = this.navToolbox_.customizeDone;
  this.navToolbox_.customizeDone = this.onToolboxCustomizeDone_.bind(this);

  if (!CLB_app.isFirstRun && !CLB_BrowserOverlay.firstSyncStarted_) {
    CLB_BrowserOverlay.firstSyncStarted_ = true;
    CLB_app.setWorkQueueCPU(false /* not foreground */);
    new CLB_SyncingForm(this.win_, false /* no syncing dialog */);
  }
}

/**
 * Called on mousedown, keypress, etc. We use this to reconnect and wakeup after
 * periods of inactivity.
 */
CLB_BrowserOverlay.prototype.handleMovement_ = function(e) {
  if (CLB_app.getStatus() == CLB_Application.STATUS_KICKED) {
    var oneHour = 1000 * 60 * 60;
    var restoreBubbleTimeout = CLB_app.prefs.getPref("restoreBubbleTimeout",
                                                     oneHour);

    if ((new Date().getTime() - CLB_app.lastKickTime) > restoreBubbleTimeout) {
      CLB_RestoreTabsUI.enabled = true;
    }

    this.startReconnect_();
  } else {
    CLB_syncMan.updateSleepyState();
  }
}

/**
 * Called when the toolbar customizer dialog is finished.
 */
CLB_BrowserOverlay.prototype.onToolboxCustomizeDone_ 
  = function(aToolboxChanged) {

  this.toolbarButton_ = this.doc_.getElementById("clb-toolbarbutton");
  
  // Set the username on the Clobber dropdown
  if (CLB_app.getUsername() && this.toolbarButton_) {
    this.toolbarButton_.label = CLB_app.getUsername();
  }
  
  if (!CLB_InfoBubble.allHidden) {
    CLB_InfoBubble.repositionAll(this.toolbarButton_);
  }  
  
  this.cloneMenu_();
  
  // Call parent customizeDone function
  this.oldToolboxCustomizeDone(aToolboxChanged);
}

/**
 * Clones the tools > Google Browser Sync menu into the toolbarbutton menu
 * to avoid having to replicate the menupopup. Should be called whenever
 * menu items change state.
 */
CLB_BrowserOverlay.prototype.cloneMenu_ = function() {
  if (this.toolbarButton_) {
    while (this.toolbarButton_.childNodes.length) {
      this.toolbarButton_.removeChild(this.toolbarButton_.childNodes[0]);
    }

    this.toolbarButton_.appendChild(this.menu_.cloneNode(true));
  }
}

/**
 * Called when browser window is unloading. Unhook status observer to avoid
 * leaking memory for this window.
 */
CLB_BrowserOverlay.prototype.handleUnload_ = function() {
  CLB_app.removeStatusObserver(this.statusObserver_);
  CLB_syncMan.removeObserver(this);
  CLB_app.tabSyncer.onUnload(this.win_);
}

/**
 * Sets the toolbar button image if the toolbar is visible.
 */
CLB_BrowserOverlay.prototype.setToolbarButtonImage_ = function(img) {
  if (this.toolbarButton_) {
    this.toolbarButton_.image = img;
  }
}

/**
 * Called whenever the status of Clobber changes. We pop up various infobubble
 * messages in response.
 *
 * @param {Boolean} opt_isPageLoad  Set to true when this is being called as a
 *                                  result of the first page load. We don't
 *                                  always pop up the info bubble in such cases.
 */
CLB_BrowserOverlay.prototype.handleStatusChange_ = function(opt_isPageLoad) {
  var newStatus = CLB_app.getStatus();

  G_Debug(this, "Updating status to {%s}. isPageLoad: {%s}"
                .subs(newStatus, opt_isPageLoad));
                
  if (!CLB_app.setupIsComplete()) {
    this.setToolbarButtonImage_(CLB_BrowserOverlay.IMAGE_OFFLINE);
    this.setupItem_.hidden = false;
    this.settingsItem_.setAttribute("disabled", true);
    this.reconnectItem_.setAttribute("disabled", true);
  } else if (CLB_Application.STATUS_ONLINE == newStatus ||
             CLB_Application.STATUS_KICKED == newStatus) {
    this.setToolbarButtonImage_(CLB_BrowserOverlay.IMAGE_ONLINE);
    this.reconnectItem_.setAttribute("disabled", true);
  } else {
    this.setToolbarButtonImage_(CLB_BrowserOverlay.IMAGE_OFFLINE);
    this.reconnectItem_.setAttribute("disabled", false);
    
    if (this.settingsDlg_ && this.settingsDlg_.CLB_form) {
      this.settingsDlg_.CLB_form.setOffline();
    }
  }

  this.cloneMenu_();

  if (!opt_isPageLoad) {
    this.updateBubble_(newStatus, false);
  } else {
    // need to pause a moment so that measurements work
    this.win_.setTimeout(this.updateBubble_.bind(this, newStatus, true), 0);
  }
}


CLB_BrowserOverlay.prototype.updateBubble_ = function(newStatus, isPageLoad) {
  G_Debug(this, "Updating bubble to status: {%s}".subs(newStatus));

  if (CLB_Application.STATUS_ONLINE == newStatus) {
    if (CLB_app.prefs.getPref("showWelcome", false)) {
      this.showWelcomeMessage();
      this.infoBubble_.show(this.toolbarButton_);
    } else {
      this.infoBubble_.hide();
    }
    
    CLB_app.prefs.setPref("showWelcome", false);
    
    return;
  }

  // Make sure to hide the restore UI if it is showing.
  this.restoreUI_.hide();
  
  this.infoBubble_.clear();

  if (CLB_Application.STATUS_UPDATE_ERROR == newStatus ||
      CLB_Application.STATUS_KICKED == newStatus) {
    G_Debug(this, "Not showing bubble for update error or kick status.");
    this.infoBubble_.hide();
    return;
  }

  if (CLB_Application.STATUS_NEEDS_CAPTCHA == newStatus) {
    this.showCaptchaMessage();
  } else if (CLB_Application.STATUS_BACKED_OFF == newStatus) {
    this.infoBubble_.setMessage(CLB_app.backOffMessage());
  } else if (!CLB_app.setupIsComplete()) {
    this.showSetupMessage();
  } else if (CLB_Application.STATUS_PING_REDIRECT == newStatus) {
    this.showReconnectMessage(CLB_BrowserOverlay.MESSAGE_PING_REDIRECT);
  } else if (CLB_Application.STATUS_FORCED_UPDATE_DOWNLOADING == newStatus) {
    this.infoBubble_.hide();
    return;
  } else if (CLB_Application.STATUS_LASTSYNC_TOO_OLD == newStatus) {
    this.showResyncMessage(CLB_BrowserOverlay.MESSAGE_LASTSYNC_TOO_OLD);
  } else if (CLB_Application.STATUS_FORCED_UPDATE == newStatus) {
    this.showForcedUpdateMessage();
  } else if (CLB_Application.STATUS_OFFLINE == newStatus) {
    this.showReconnectMessage(CLB_BrowserOverlay.MESSAGE_OFFLINE);
  } else {
    G_DebugL(this,
             "Unexpected status {%s}. Hiding InfoBubble.".subs(newStatus));
    this.infoBubble_.hide();
    return;
  }

  if (!CLB_InfoBubble.allHidden || !isPageLoad) {
    this.infoBubble_.show(this.toolbarButton_ /* might be null */);
  }
}


CLB_BrowserOverlay.prototype.handleStatusImageClick = function(event) {
  // button is false for left-click
  if (!event.button) {
    this.handleStatusChange_();
  }
}

CLB_BrowserOverlay.prototype.showWelcomeLink_ = function() {
  this.showURL_(CLB_BrowserOverlay.WELCOME_URL);
  CLB_InfoBubble.hideAll();
}

CLB_BrowserOverlay.prototype.showWelcomeMessage = function() {
  this.infoBubble_.setMessage(CLB_BrowserOverlay.MESSAGE_WELCOME);
}

CLB_BrowserOverlay.prototype.showSetupMessage = function() {
  this.infoBubble_.setMessage(CLB_BrowserOverlay.MESSAGE_SETUP);
  this.infoBubble_.addButton("Setup Now...", 
                             this.startSetup_.bind(this));
}

CLB_BrowserOverlay.prototype.showForcedUpdateMessage = function() {
  this.infoBubble_.setMessage(CLB_BrowserOverlay.MESSAGE_FORCED_UPDATE);
  this.infoBubble_.addButton("Upgrade now", this.maybeRestart.bind(this));
  this.infoBubble_.addButton("Upgrade later",
                             CLB_InfoBubble.hideAll.bind(CLB_InfoBubble));
}

CLB_BrowserOverlay.prototype.maybeRestart = function() {
  var promptSvc = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                  .getService(Ci.nsIPromptService);

  if (promptSvc.confirm(null,
                        "Google Browser Sync",
                        "OK to restart now?")) {
    CLB_app.logOff();
  }
}

CLB_BrowserOverlay.prototype.showCaptchaMessage = function() {
  this.infoBubble_.setMessage(CLB_BrowserOverlay.MESSAGE_CAPTCHA_REQUIRED);
}


/**
 * Show an info bubble message informing the user they have been kicked and
 * giving them an opportunity to log back in.
 */
CLB_BrowserOverlay.prototype.showReconnectMessage = function(message) {
  this.infoBubble_.setMessage(message);

  this.infoBubble_.addButton("Reconnect",
                             this.startReconnect_.bind(this));
}


/**
 * Show an infobubble message informing the user that their last sync
 * was too long ago, and that they need to resync.
 */
CLB_BrowserOverlay.prototype.showResyncMessage = function(message) {
  this.infoBubble_.setMessage(message);

  this.infoBubble_.addButton("Start Full Sync",
                             this.startFullSync_.bind(this));
}


CLB_BrowserOverlay.prototype.showURL_ = function(url) {
  this.tabBrowser_.selectedTab = this.tabBrowser_.addTab(url);
}


/**
 * Handler for pressing "Setup Clobber" in the info bubble, which shows up if the
 * user somehow gets the browser started without setting up Clobber the first
 * time.
 *
 * This confirms with the user that it's OK to restart, then does so. That will
 * result in the setup screen coming up again if either SID, key, MID, or token
 * are missing.
 *
 * This is pretty ugly. It'd be better if we could show the setup screen on top
 * of currently open windows for a couple reasons:
 *
 * - It would make the initial setup better/less scary.
 *
 * - In order to implement it we'd have to make syncing on top of open windows
 *   work, which would also be good for normal browser startup when Clobber is
 *   installed.
 */
CLB_BrowserOverlay.prototype.startSetup_ = function() {
  var promptSvc = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                  .getService(Ci.nsIPromptService);

  if (promptSvc.confirm(null,
                        "Warning",
                        "Setting up Google Browser Sync requires closing " +
                        "all open browser windows. OK to proceed?")) {
    CLB_app.logOff();
  }
}

/**
 * Show the syncing... dialog which will reconnect and resynchronize the client.
 */
CLB_BrowserOverlay.prototype.startReconnect_ = function() {
  CLB_app.setWorkQueueCPU(false /* not foreground */);
  new CLB_SyncingForm(this.win_, false /* no syncing dialog */);

  CLB_InfoBubble.hideAll();
}

/**
 * Show the syncing... dialog which will reconnect and resynchronize the client.
 */
CLB_BrowserOverlay.prototype.startFullSync_ = function() {
  CLB_app.prefs.setPref("lastUpdate", "0");
  CLB_app.prefs.setPref("lastSync", "0");
  CLB_app.prefs.setPref("reimport", true);
  CLB_app.setWorkQueueCPU(true /* foreground */);
  new CLB_SyncingForm(this.win_, true /* modal syncing dialog */);
  
  CLB_InfoBubble.hideAll();
}

CLB_BrowserOverlay.prototype.handleSettingsClicked = function() {
  var left = (this.win_.outerWidth - CLB_BrowserOverlay.SETTINGS_DIALOG_WIDTH)
             / 2 + this.win_.screenX;
  var top = (this.win_.outerHeight - CLB_BrowserOverlay.SETTINGS_DIALOG_HEIGHT)
            / 2 + this.win_.screenY;

  this.settingsDlg_ =
    this.win_.openDialog("chrome://browserstate/content/settings.xul",
                         "clb-settings",
                         "dialog,modal,left=%s,top=%s"
                         .subs(left, top));
}

CLB_BrowserOverlay.prototype.handleShowLogClicked = function(e) {
  this.launchFile_(G_debugService.getLogFile());
}


CLB_BrowserOverlay.prototype.handleDumpBookmarksClicked = function(e) {
  var ds = Cc["@mozilla.org/rdf/datasource;1?name=bookmarks"]
           .getService(Ci.nsIRDFDataSource);

  var file = CLB_rdf.writeRdfToFile(ds, 
                                    0, // no maximum size
                                    "bookmarks-dump.txt");

  this.launchFile_(file);
}

/**
 * When Clobber is installed into a profile, we need to add it to the current
 * set of buttons for one of the toolbars.
 */
CLB_BrowserOverlay.prototype.initializeToolbars_ = function() {
  // Figure out which bar to modify. We prefer the menubar, but can't use it on 
  // mac.
  var toolbar;
  
  if (CLB_app.isMac()) {
    toolbar = this.doc_.getElementById("PersonalToolbar");
  } else {
    toolbar = this.doc_.getElementById("toolbar-menubar");
  }

  // Skip out early if we've already done this work.
  if (toolbar.hasAttribute("clb-initialized2")) {
    G_Debug(this, "clb-intialized already set. skipping init.");
    return;
  }

  var defaultSet = this.insertToolbarItem_(toolbar.getAttribute("defaultset"),
                                           CLB_app.isMac());
  var currentSet;

  if (toolbar.hasAttribute("currentset")) {
    currentSet = this.insertToolbarItem_(toolbar.getAttribute("currentset"),
                                         CLB_app.isMac());
  } else {
    currentSet = defaultSet;
  }

  // TODO(aa): make sure this persists!
  toolbar.collapsed = false;

  // save the new layout
  toolbar.currentSet = currentSet;
  toolbar.setAttribute("currentset", currentSet);
  toolbar.setAttribute("defaultset", defaultSet);
  this.doc_.persist(toolbar.id, "defaultset");
  this.doc_.persist(toolbar.id, "currentset");

  // remember that we've done this before.
  toolbar.setAttribute("clb-initialized2", "1");
  this.doc_.persist(toolbar.id, "clb-initialized2");
}

CLB_BrowserOverlay.prototype.insertToolbarItem_ = function(prevVals, isMac) {
  var prevVals = prevVals.split(",");
  var insertPos;

  // For OS besides Mac, the menubar is part of the window chrome. We put
  // our toolbar item there, right before the throbber. But the throbber is
  // movable, so if it isn't there, we just add ourselves to the end.
  if (!isMac && (prevVals[prevVals.length - 1] == "throbber-box")) {
    insertPos = prevVals.length - 1;
  } else {
    insertPos = prevVals.length;
  }

  // Add our item at the right place.
  prevVals.splice(insertPos, 0, "clb-toolbarbutton");
  return prevVals.join(",");
}

CLB_BrowserOverlay.prototype.launchFile_ = function(file) {
  this.showURL_(file.path);
}

CLB_BrowserOverlay.prototype.handleChord_ = function() {
  this.setToolbarButtonImage_("chrome://browserstate/content/icon.gif");
}

function CLB_Chord(win, word) {
  bindMethods(this);
  
  this.win_ = win;
  this.members_ = [];
  this.currentKey_ = 0;
  this.resetAlarm_ = null;

  for (var i = 0; i < word.length; i++) {
    this.members_.push(word.charCodeAt(i));
  }
}

CLB_Chord.MAX_DELAY = 500; // milliseconds between members

CLB_Chord.prototype.onComplete = function(){};

CLB_Chord.prototype.start = function() {
  this.win_.addEventListener("keypress", this.handleKeyPress_, true);
}

CLB_Chord.prototype.stop = function() {
  this.win_.removeEventListener("keypress", this.handleKeyPress_, true);
}

CLB_Chord.prototype.handleKeyPress_ = function(e) {
  // altKey does not work on mac, so we use ctrlKey instead.
  if (!(CLB_app.isMac() && e.ctrlKey || e.altKey)) {
    return;
  }

  if (this.currentKey_ > 0) {
    this.resetAlarm_.cancel();
  }

  if (this.members_[this.currentKey_] != e.which) {
    this.reset_();
    return;
  }

  this.currentKey_++;

  if (this.currentKey_ < this.members_.length) {
    this.resetAlarm_ = new G_Alarm(this.reset_, CLB_Chord.MAX_DELAY);
    return;
  }

  e.preventDefault();
  this.onComplete();
}

CLB_Chord.prototype.reset_ = function() {
  this.currentKey_ = 0;
}

CLB_Chord.prototype.debugZone = "CLB_Chord";

CLB_BrowserOverlay.prototype.debugZone = "CLB_BrowserOverlay";
G_debugService.loggifier.loggify(CLB_BrowserOverlay.prototype);
