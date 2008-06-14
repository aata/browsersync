// Copyright 2005 and onwards, Google

function CLB_SyncingForm(win, opt_modal) {
  this.win = win;
  this.syncing = false;
  this.loginUtil = new CLB_LoginUtil();

  this.promptSvc = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                     .getService(Ci.nsIPromptService);
                     
  this.dialog = null;
  this.dialogLbl = null;
  this.dialogTitle = null;
  this.modal = Boolean(opt_modal);
  
  this.start();
}

CLB_SyncingForm.running_ = false;
CLB_SyncingForm.ERROR_FORBIDDEN = 403;

CLB_SyncingForm.prototype.alert = function(message) {
  ((this.dialog) ? this.dialog : this.win).alert(message);
}

CLB_SyncingForm.prototype.start = function() {
  if (CLB_SyncingForm.running_) {
    return;
  }

  CLB_SyncingForm.running_ = true;
  
  // XXX HACK. Make sure that password syncer gets initialized early. Before
  // this was here, when clobber was offline, initPassMan_ would not get called
  // until start() which was after the syncing dialog closed. This caused some
  // kind of wierdness in Firefox, which prevented it from starting up. This can
  // be removed once we have background syncing in place since it is the syncing
  // dialog which causes this problem.
  //
  // Additionally, we should not call initPassMan_() if passwordsyncer is
  // disabled, since that will cause the master password dialog to be shown.
  if (CLB_app.getListPref("syncedComponents")
      .indexOf(CLB_PasswordSyncer.CONTRACT_ID) > -1) {
    CLB_app.passwordSyncer.initPassMan_();
  }
  
  if (CLB_app.browserPrefs.getPref("offline")) {
    // Give the browser time to finish drawing the window, so
    // it can determine screen dimensions and then center the
    // resulting alert.
    this.win.setTimeout(this.handleWorkingOffline.bind(this), 10);
  } else if (CLB_app.isBackedOff()) {
    this.win.setTimeout(this.handleBackedOff.bind(this), 10);
  } else {
    if (this.modal) {
      this.openDialog(this.startPing.bind(this));
    } else {
      this.startPing();
    }
  }
}

CLB_SyncingForm.prototype.openDialog = function(andThen, modal) {
  var features = "dialog,centerscreen,chrome";

  if (modal) {
    features += ",modal";
  }

  CLB_app.setWorkQueueCPU(true /* foreground */);
  
  this.win.openDialog("chrome://browserstate/content/resyncer.xul",
                      "clb-resyncer",
                      features,
                      this.handleDialogLoad.bind(this, andThen),
                      this.cancel.bind(this));
};

CLB_SyncingForm.prototype.handleDialogLoad = function(andThen, child) {
  this.dialog = child;
  this.dialogLbl = child.document.getElementById("clb-status");
  this.dialogTitle = child.document.getElementById("clb-title");
  andThen();
}

CLB_SyncingForm.prototype.startPing = function() {
  this.req = CLB_RequestFactory.getRequest(
      CLB_RequestFactory.PING,
      { cachebuster: new Date().getTime() },
      this.handlePingSuccess.bind(this),
      this.handleError.bind(this,
                            "Network connection error"),
      null /* no progress handler */,
      true /* use GET */);

  this.req.send(null);
}

CLB_SyncingForm.prototype.handlePingSuccess = function() {
  // Check for redirects caused by networks you need to login to.
  if (this.req.channel.URI.spec.replace(/\?.+$/, "") !=
      CLB_RequestFactory.getURL(CLB_RequestFactory.PING)) {
    CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
    this.cancel();
    this.alert("Network connection error. Please check your network " +
               "settings and try again.");
    return;
  }

  this.startStartSession();
}

CLB_SyncingForm.prototype.startStartSession = function() {
  // Send a message to the server to start this clobber session.  This locks
  // this machine in as the current client for a particular user.
  var doc = CLB_XMLUtils.getDoc("StartSessionRequest",
                                {uid: CLB_app.getSID(),
                                 mid: CLB_app.getMID(),
                                 key: CLB_app.getEncryptedKey()});

  this.req = CLB_RequestFactory.getRequest(
               CLB_RequestFactory.START_SESSION, 
               null,
               this.handleStartSessionSuccess.bind(this),
               this.handleError.bind(this,
                                     "Could not start session"));

  this.req.send(doc);
}

CLB_SyncingForm.prototype.handleWorkingOffline = function() {
  this.promptSvc.alert(this.win,
                       "You Are Working Offline",
                       CLB_Application.MESSAGE_WORKING_OFFLINE);

  CLB_syncMan.startSendingUpdates();
  CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
  CLB_SyncingForm.running_ = false;
}

CLB_SyncingForm.prototype.handleBackedOff = function() {
  this.promptSvc.alert(this.win,
                       "You Are Offline",
                       CLB_app.backOffMessage());

  CLB_syncMan.startSendingUpdates();
  CLB_app.setStatus(CLB_Application.STATUS_BACKED_OFF);
  CLB_SyncingForm.running_ = false;
}

CLB_SyncingForm.prototype.handleStartSessionSuccess = function(req) {
  this.req = null;

  if (!this.modal && this.dialog) {
    this.dialog.close();
  } else if (this.dialogTitle) {
    this.dialogTitle = this.dialogTitle._oldValue;
  }
  
  CLB_syncMan.addObserver(this);
  this.syncing = true;  // Needed for cancel call

  CLB_syncMan.startSync();
}

CLB_SyncingForm.prototype.syncProgress = function(state) {
  if (this.dialogLbl) {
    this.dialogLbl.value = state;
  }
}

CLB_SyncingForm.prototype.closeDialog = function() {
  if (this.modal && !this.dialog.closed) {
    // Allow openDialog to finish.
    new G_Alarm(bind(function() {
      this.dialog.close();
      this.dialog = null;
    }, this), 10);
  }
}

CLB_SyncingForm.prototype.syncComplete = function() {
  CLB_syncMan.removeObserver(this);
  CLB_app.setStatus(CLB_Application.STATUS_ONLINE);
  CLB_SyncingForm.running_ = false;
  this.closeDialog();
}

CLB_SyncingForm.prototype.syncFailure = function(code, status, message) {
  if (status == "restart") {
    G_Debug(this, "Ignoring syncFailure from restart");
    return;
  }
  
  this.handleError("Error synchronizing browser",
                   code, status, message);
                   
  this.closeDialog();
}

CLB_SyncingForm.prototype.handleError =
function(prefix, code, status, opt_message) {
  this.cancel();

  if (CLB_app.isGAIATimeoutError(code, status, opt_message)) {
    this.reauthenticate();
    return;
  }

  if (CLB_app.handleClientTooOldError(code, status, opt_message) ||
      CLB_app.handleLastSyncTooOldError(code, status, opt_message)) {
    return;
  }

  if (CLB_app.isKickError(code, status, opt_message)) {
    CLB_app.setStatus(CLB_Application.STATUS_KICKED);
    CLB_app.lastKickTime = new Date().getTime();
    return;
  }
  
  var message = CLB_app.handleServerError(code, status, opt_message);

  // If the key has somehow become invalid (perhaps the user deleted their
  // account) clear it. This will put Clobber into an 'unsetup state' the same
  // as if the user had pressed cancel at signup.
  if (CLB_app.isInvalidKeyError(code, status, opt_message) ||
      CLB_app.isInvalidUserError(code, status, opt_message)) {
    CLB_app.deleteUserSettings();
    CLB_app.savePrefs();
    return;
  }
  
  this.alert(message);
}

CLB_SyncingForm.prototype.reauthenticate = function() {
  var result = CLB_PasswordForm.show(this.win);

  if (!result.getProperty("success")) {
    CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
    this.cancel();
    return;
  }

  this.reauthReq = this.loginUtil.startRequest(
    CLB_app.prefs.getPref("username"),
    result.getProperty("password"),
    this.handleReauthSuccess.bind(this),
    this.handleReauthFailure.bind(this));
}

CLB_SyncingForm.prototype.handleReauthSuccess = function(req) {
  this.reauthReq = null;
  
  var resp = this.loginUtil.parseResponse(req.responseText);

  CLB_app.setSID(resp["SID"]);
  this.startStartSession();
}

CLB_SyncingForm.prototype.handleReauthFailure = 
function(code, status, message) {
  if (code == CLB_SyncingForm.ERROR_FORBIDDEN) {
    if (this.loginUtil.showErrorMessage(this.win, 
                                        this.reauthReq.responseText)) {
      this.reauthenticate();
    }
  } else {
    this.handleError("Error reauthenticating user",
                     code, status, message);
  }
}

CLB_SyncingForm.prototype.cancel = function() {
  if (this.req) {
    G_Debug(this, "Aborting request...");
    this.req.abort();
  }

  if (this.reauthReq) {
    G_Debug(this, "Aborting reauth request...");
    this.reauthReq.abort();
  }

  if (!this.syncing) {
    CLB_syncMan.startSendingUpdates();
  } else {
    G_Debug(this, "Removing syncman observer...");
    CLB_syncMan.removeObserver(this);

    G_Debug(this, "Aborting downloader...");
    CLB_syncMan.cancelSync();
  }
  
  CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
  CLB_SyncingForm.running_ = false;
  this.closeDialog();
}

CLB_SyncingForm.prototype.debugZone = "CLB_SyncingForm";
G_debugService.loggifier.loggify(CLB_SyncingForm.prototype);
