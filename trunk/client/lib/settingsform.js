// Copyright 2005 and onwards, Google

/**
 * CLB_SettingsForm
 * UI controller for settings.xul
 */
function CLB_SettingsForm(win) {
  bindMethods(this);
  
  this.win_ = win;
  this.doc_ = this.win_.document;
  this.dialog_ = this.doc_.documentElement;

  this.componentSelector_ = new CLB_ComponentSelector(
      this.doc_.getElementById("clb-component-selector"));
     
  this.promptSvc_ = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                    .getService(Ci.nsIPromptService);

  this.okButton_ = this.dialog_.getButton("accept");
  this.resyncButton_ = this.doc_.getElementById("clb-resync-button");
  this.tokenField_ = this.doc_.getElementById("clb-restart-text");
  this.showButton_ = this.doc_.getElementById("clb-show-button");
  this.usernameField_ = this.doc_.getElementById("clb-username");
  this.changeLoginButton_ = this.doc_.getElementById("clb-change-login");
  
  this.userDesc_ = this.doc_.getElementById("clb-user-desc");
  this.nouserDesc_ = this.doc_.getElementById("clb-nouser-desc");
  
  this.settingsDisabledDesc_ = 
    this.doc_.getElementById("clb-settings-disabled");
  
  this.syncedComponents_ = [];
  this.encryptedComponents_ = [];
  this.enabledComponents_ = [];
  this.disabledComponents_ = [];
  this.clearedComponents_ = [];
  this.progressDlg_ = null;
  this.progressLbl_ = null;
  
  this.win_.addEventListener("load", this.handleLoad, false);
  this.win_.addEventListener("unload", this.handleUnload, false);
}

CLB_SettingsForm.LAST_UPDATES = -1;
CLB_SettingsForm.SETTINGS = 0;
CLB_SettingsForm.IMPORT = 1;
CLB_SettingsForm.RESYNC = 2;

// Unused GISyncObserver interface members
CLB_SettingsForm.prototype.syncStart =
CLB_SettingsForm.prototype.updateStart =
CLB_SettingsForm.prototype.updateProgress = function() {
}

/**
 * Called when the dialog is shown. Setup the initial state of the controls.
 */
CLB_SettingsForm.prototype.handleLoad = function() {
  this.componentSelector_.load();
  
  var token = CLB_app.getToken();
 
  if (!token) {
    token = "";
  }
  
  this.tokenField_.setAttribute("value", token);

  var username = CLB_app.getUsername();
  
  if (!username) {
    this.userDesc_.setAttribute("hidden", "true");
    this.nouserDesc_.setAttribute("hidden", "false");
  } else {
    this.usernameField_.textContent = username;
  }

  this.dialog_.setAttribute("width", CLB_BrowserOverlay.SETTINGS_DIALOG_WIDTH);
  this.win_.sizeToContent();
}

/**
 *
 */
CLB_SettingsForm.prototype.handleUnload = function() {
  try {
    CLB_syncMan.removeObserver(this);
  } catch(e) {
    // We want syncman to throw, as that means the observer has
    // already been removed.
    G_Debug(this, "removeObserver was not required.");
    return;
  }
  
  G_Debug(this, "WARNING: SyncManager observer still existed");
  return;
}

CLB_SettingsForm.prototype.handleShowButtonClicked = function(event) {
  if (this.tokenField_.hasAttribute("type")) {
    this.tokenField_.removeAttribute("type");
    this.showButton_.label = "Hide";
  } else {
    this.tokenField_.setAttribute("type", "password");
    this.showButton_.label = "Show";
  }
}

CLB_SettingsForm.prototype.handleAccountSettingsClicked = function(event) {
  this.win_.opener.open("https://www.google.com/accounts/ManageAccount?service=browserstate&hl=en");
}

/**
 * Called when the user presses the 'resync' button. 
 */
CLB_SettingsForm.prototype.handleResyncClicked = function(e) {
  CLB_app.setWorkQueueCPU(true /* is foreground sync */);
  this.win_.openDialog("chrome://browserstate/content/resyncer.xul",
                       "clb-resyncer",
                       "dialog,modal,centerscreen,chrome",
                       this.startResync,
                       this.cancelResync);
}

CLB_SettingsForm.prototype.startResync = function(child) {
  this.stage_ = CLB_SettingsForm.RESYNC;

  this.initProgressWin_(child);

  CLB_syncMan.addObserver(this);
  CLB_syncMan.startSync(true /* skip settings */);
}

CLB_SettingsForm.prototype.cancelResync = function() {
  G_Debug(this, "Aborting downloader");
  CLB_syncMan.cancelSync();
}

/**
 * Called when the user presses the 'change login' button. Pop up the signup
 * screen again.
 */
CLB_SettingsForm.prototype.handleChangeLoginClicked = function(e) {
  if (this.promptSvc_.confirm(null,
                              "Warning",
                              "This will close your open windows and "
                              + "start the Google Browser Sync signup "
                              + "process. Your local settings will not be "
                              + "lost. OK to proceed?")) {
    CLB_app.deleteUserSettings();
    
    this.win_.setTimeout(CLB_app.logOff.bind(CLB_app), 5);
  }
}

/**
 * Called when the user pressed the OK button. If there are any changes, commit
 * them and resynchronize.
 */
CLB_SettingsForm.prototype.handleOKButtonClicked = function() {
  G_Debug(this, "Changing settings...");
  
  var oldSyncedComponents = CLB_app.getListPref("syncedComponents"); 
  var oldEncryptedComponents = CLB_app.getListPref("encryptedComponents");

  var choice = this.componentSelector_.getChoices();
  
  this.syncedComponents_ = choice.syncedComponents;
  this.encryptedComponents_ = choice.encryptedComponents;
 
  // Detect changes and start/stop any affected components
  var syncedChanges = G_SetXOR(this.syncedComponents_, oldSyncedComponents);
  
  // Stuff that was in this.syn.. but not in oldSyn..
  // We use this to start components later
  this.enabledComponents_ = syncedChanges.left;
  
  // Stuff that was in oldSync.. but not in this.syn..
  // We use this to stop components later
  this.disabledComponents_ = syncedChanges.right;

  var encryptionChanges = G_SetXOR(this.encryptedComponents_, 
                                    oldEncryptedComponents); 
  this.encryptionChanges_ = encryptionChanges.xor;
  
  this.clearedComponents_ = G_SetMerge(this.disabledComponents_, 
                                        this.encryptionChanges_);

  G_Debug(this, "Synced Components: %s".subs(this.syncedComponents_.join("|")));
  G_Debug(this, "Encrypted Components: %s".subs(this.encryptedComponents_.join("|")));
  G_Debug(this, "Enabled Components: %s".subs(this.enabledComponents_.join("|")));
  G_Debug(this, "Disabled Components: %s".subs(this.disabledComponents_.join("|")));
  G_Debug(this, "Encryption Changes: %s".subs(this.encryptionChanges_.join("|")));
  
  // If a component is added, do a reimport on all clients.
  // If a component is deleted, change the setting on the 
  // server, do nothing further (the other clients still need to be brought up to
  // date with changes they hadn't seen yet when the setting was changed).
  if (syncedChanges.xor.length || encryptionChanges.xor.length) {
    G_DebugL(this, "Opening Dialog");
    CLB_app.setWorkQueueCPU(true /* is foreground sync */);
    this.win_.openDialog("chrome://browserstate/content/resyncer.xul",
                         "clb-resyncer",
                         "dialog,modal,centerscreen,chrome",
                         this.sendLastUpdates,
                         this.cancelSettingsChange);
    return false;
  } else {
    this.win_.setTimeout("window.close()", 5);
  }
}

CLB_SettingsForm.prototype.sendLastUpdates = function(child) {
  G_Debug(this, "Sending last updates.");

  this.initProgressWin_(child);

  // If we're in the middle of a send, we cancel and resend it with whatever is
  // pending.
  if (CLB_syncMan.checkSending()) {
    CLB_syncMan.cancelUpdate();
  }

  CLB_syncMan.addObserver(this);

  // If we have anything to send, do so.
  if (CLB_syncMan.checkPending()) {
    this.stage_ = CLB_SettingsForm.LAST_UPDATE;
    CLB_syncMan.sendPending();
    return;
  }

  G_Debug(this, "No pending updates to send. Changing settings.");
  this.startSettingsChange();
}

CLB_SettingsForm.prototype.updateFailure = function(code, status, message) {
  this.syncFailure(code, status, message);
}

CLB_SettingsForm.prototype.updateComplete = function() {
  this.startSettingsChange();
}

CLB_SettingsForm.prototype.startSettingsChange = function() {
  G_Debug(this, "Changing settings...");
  this.stage_ = CLB_SettingsForm.SETTINGS;

  CLB_syncMan.changeSettings(this.syncedComponents_,
                             this.encryptedComponents_,
                             this.clearedComponents_,
                             this.enabledComponents_,
                             this.settingsChangeSuccess,
                             this.syncFailure);
}

CLB_SettingsForm.prototype.cancelSettingsChange = function() {
  if (this.stage_ == CLB_SettingsForm.LAST_UPDATE) {
    G_Debug(this, "Cancelling last update");
    CLB_syncMan.cancelUpdate();
  }
  
  if (this.stage_ == CLB_SettingsForm.SETTINGS) {
    G_Debug(this, "Canceling settings change");
    CLB_syncMan.cancelChangeSettings();
  }

  if (this.stage_ == CLB_SettingsForm.IMPORT) {
    G_Debug(this, "Canceling downloader");
    CLB_syncMan.cancelSync();
  }
}

CLB_SettingsForm.prototype.settingsChangeSuccess = function() {
  G_Debug(this, "Settings Change Complete");
  
  this.stage_ = CLB_SettingsForm.IMPORT; 
  CLB_syncMan.startSync();
}

/**
 * Called from CLB_syncMan when the sync progresses
 *
 * @param {Number} percent completed
 * @param {String} status text
 */
CLB_SettingsForm.prototype.syncProgress = function(state) {
  this.progressLbl_.value = state;
}

/**
 * Called from CLB_syncMan when the sync fails
 *
 * @param {String} Error Code
 * @param {String} Status Text
 * @param {String} Error Details
 */
CLB_SettingsForm.prototype.syncFailure = function(code, status, message) {
  G_DebugL(this, "Sync Failure - " + [code, status, message]);
  CLB_syncMan.removeObserver(this);
  
  if (!this.progressDlg_.closed) {
    // Allow openDialog to finish.
    this.progressDlg_.setTimeout("window.close()",10);
  }

  if (this.stage_ == CLB_SettingsForm.SETTINGS ||
      this.stage_ == CLB_SettingsForm.LAST_UPDATE ||
      this.stage_ == CLB_SettingsForm.IMPORT) {
    this.win_.alert("Settings change did not complete, "
                  + "please try again later.");
  } else if (this.stage_ == CLB_SettingsForm.RESYNC) {
    this.win_.alert("Resync of data did not complete, "
                  + "please try again later.");
  }
}

/**
 * Called from CLB_syncMan when the sync completes successfully. Will close 
 * the progress dialog (if used).
 */
CLB_SettingsForm.prototype.syncComplete = function() {
  // Manual resync, or post-settings-change import
  G_DebugL(this, "Sync Finished");
  CLB_syncMan.removeObserver(this);
    
  if (!this.progressDlg_.closed) {
    // Allow openDialog to finish.
    this.progressDlg_.setTimeout("window.close()",10);
  }
    
  if (this.stage_ == CLB_SettingsForm.IMPORT) {
    // If a post-settings-change import, then close the settings
    // window
    this.win_.setTimeout("window.close()",50);
    return;
  }

  // Manual resync completed
  this.componentSelector_.load();
}

CLB_SettingsForm.prototype.initProgressWin_ = function(win) {
  this.progressDlg_ = win;
  this.progressLbl_ = win.document.getElementById("clb-status");
}

CLB_SettingsForm.prototype.debugZone = "CLB_SettingsForm";
G_debugService.loggifier.loggify(CLB_SettingsForm.prototype);
