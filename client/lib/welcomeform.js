// Copyright 2006 and onwards, Google

function CLB_WelcomeForm(win) {
  bindMethods(this);

  this.loaded = false;
  this.win = win;
  this.promptSvc = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                   .getService(Ci.nsIPromptService);

  this.result = this.win.arguments[0].QueryInterface(
    Components.interfaces.nsIWritablePropertyBag);

  this.result.setProperty("success", false);
  
  this.creatingAccount = false;
}

CLB_WelcomeForm.NO_USER_ERROR = 403;
CLB_WelcomeForm.REFRESH_SID_REQUIRED = 403;

CLB_WelcomeForm.MIN_TOKEN_LENGTH = 4;
CLB_WelcomeForm.REFRESH_SID_REQUIRED_MSG = "Need to refresh SID cookie.";
CLB_WelcomeForm.NO_ACCOUNT_MSG = "Account does not exist for this user.";

CLB_WelcomeForm.prototype.handleLoad = function() {
  this.doc = this.win.document;
  this.wizard = this.doc.documentElement;
  this.welcomePage = this.doc.getElementById("clb-welcome");
  this.progressPage = this.doc.getElementById("clb-progress");

  this.usernameField = this.doc.getElementById("clb-username");
  this.passwordField = this.doc.getElementById("clb-password");
  this.progressTitleField = this.doc.getElementById("clb-progress-title");
  this.progressBlurbField = this.doc.getElementById("clb-progress-blurb");
  this.progressMeter = this.doc.getElementById("clb-progress-meter");
  this.progressDetailsField = this.doc.getElementById("clb-progress-details");
  this.createTokenTextElm = this.doc.getElementById("clb-create-token");
  this.confirmTokenTextElm = this.doc.getElementById("clb-confirm-token");
  this.verifyTokenTextElm = this.doc.getElementById("clb-verify-token");
  this.installTypeDefaultRadio = 
    this.doc.getElementById("clb-installtype-default");

  this.usingAdvancedSettings = false;
  this.refreshingSID = false;
  
  this.loginUtil = new CLB_LoginUtil();
  
  this.componentSelector = new CLB_ComponentSelector(
    this.doc.getElementById("clb-component-selector"));

  this.componentSelector.settingsChanged =
    this.handleSettingsSelected.bind(this);
    
  this.wizard.getButton("cancel")
    .addEventListener("click", this.handleCancel.bind(this), false);

  if (CLB_app.browserPrefs.getPref("offline")) {
    // Give the browser time to finish drawing the window, so
    // it can determine screen dimensions and then center the
    // resulting alert.
    this.win.setTimeout(this.handleWorkingOffline.bind(this), 10);
  } else if (CLB_app.isBackedOff()) {
    this.win.setTimeout(this.handleBackedOff.bind(this), 10);
  }
}

CLB_WelcomeForm.prototype.handleWorkingOffline = function() {
  this.promptSvc.alert(this.win,
                       "You Are Working Offline",
                       CLB_Application.MESSAGE_WORKING_OFFLINE);

  CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);

  this.win.setTimeout("window.close()", 0);
}

CLB_WelcomeForm.prototype.handleBackedOff = function() {
  this.promptSvc.alert(this.win,
                       "You Are Offline",
                       CLB_app.backOffMessage());

  CLB_app.setStatus(CLB_Application.STATUS_BACKED_OFF);

  this.win.setTimeout("window.close()", 0);
}

CLB_WelcomeForm.prototype.handleForgotPassword = function() {
  if (!this.win.confirm("This will close the setup wizard and take you to " +
                        "a webpage to have your password sent to you. When " +
                        "you're ready, choose 'Setup Google Browser Sync' " +
                        "from the Google Browser Sync toolbar button to " +
                        "restart this wizard.")) {
    return;
  }
  
  CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
  CLB_app.errorURL = "https://www.google.com/accounts/ForgotPasswd?" +
                     "service=browserstate";

  this.win.setTimeout("window.close()", 0);
}

CLB_WelcomeForm.prototype.handleCreateGAIAAcct = function() {
  if (!this.win.confirm("This will close the setup wizard and take you to " +
                        "a webpage to create a Google account. When " +
                        "you're ready, choose 'Setup Google Browser Sync' " +
                        "from the Google Browser Sync toolbar button to " +
                        "restart this wizard.")) {
    return;
  }
  
  CLB_app.setStatus(CLB_Application.STATUS_OFFLINE);
  CLB_app.errorURL = "https://www.google.com/accounts/NewAccount";

  this.win.setTimeout("window.close()", 0);
}

CLB_WelcomeForm.prototype.showLearnMore = function() {
  var width = 300;
  var height = 300;
  var left = this.win.screenX + (this.win.outerWidth - width) / 2;
  var top = this.win.screenY + (this.win.outerHeight - height) / 2;

  this.win.open("chrome://browserstate/content/learnmore1.html",
                "learnmore",
                "width=%s,height=%s,left=%s,top=%s,scrollbars=yes,chrome,dialog"
                .subs(width, height, left, top));
}

/**
 * If user has pressed cancel, abort any outstanding requests.
 */
CLB_WelcomeForm.prototype.handleCancel = function() {
  if (isDef(this.req) && this.req) {
    this.req.abort();
    this.req = null;
  }

  if (this.syncing) {
    CLB_syncMan.cancelSync();
  }

  if (this.observingSyncMan) {
    CLB_syncMan.removeObserver(this);
    this.observingSyncMan = false;
  }
}

CLB_WelcomeForm.prototype.handleWizardFinish = function() {
  this.result.setProperty("success", true);
}

CLB_WelcomeForm.prototype.handleWarningPageShow = function() {
  // window.load event gets fired after pageshow for the first wizard page, so
  // that means things that it relies on won't be available yet. so we call it
  // manually instead.
  if (!this.loaded) {
    this.handleLoad();
  }

  this.wizard.canAdvance = true;
}

CLB_WelcomeForm.prototype.handleWarningPageAdvanced = function() {
  if (CLB_app.detectConflicts()) {
    return false;
  }

  return true;
}

CLB_WelcomeForm.prototype.handleWelcomePageShow = function() {
  this.usernameField.focus();
  this.handleWelcomePageInput();
}

CLB_WelcomeForm.prototype.handleWelcomePageInput = function() {
  this.username = this.usernameField.value.trim().replace(/@gmail\.com$/i, "");
  this.password = this.passwordField.value.trim();
  
  this.wizard.canAdvance = this.username != "" && this.password != "";
}

CLB_WelcomeForm.prototype.handleWelcomePageAdvanced = function() {
  this.setStatusTitle("Logging in");
  this.setStatusBlurb("Please wait while we log you into "
                    + "Google Browser Sync.");
  this.wizard.canAdvance = false;
  this.startPing();
}

/**
 * When behind a router such as at a hotel or MV wifi, all requests get 
 * redirected to an HTTP authentication page. The problem with this is that our
 * first request is an HTTPs request for the GAIA login. Unfortunately, 
 * Firefox then receives an HTTP/HTML response for an HTTPS request from the
 * wrong host and takes a very long time (~30 seconds) to give up an give us
 * an error.
 *
 * Since this is a common problem, we special case it and test ahead of time
 * by requesting a known URL which does not redirect and testing to see whether
 * it did or didn't. If it didn't, then everything is OK and we proceed. If it
 * it does redirect, then we inform the user of the problem.
 */
CLB_WelcomeForm.prototype.startPing = function() {
  this.setStatusDetails("Checking network configuration...");

  this.req = CLB_RequestFactory.getRequest(
    CLB_RequestFactory.PING,
    { cachebuster: new Date().getTime() },
    this.handlePingSuccess,
    this.handleLoginPhaseError.bind(null, "Error checking connection settings"),
    null /* no progress handler */,
    true /* use GET */);

  this.req.send(null);
}

CLB_WelcomeForm.prototype.handlePingSuccess = function(req) {
  this.req = null;

  if (req.channel.URI.spec.replace(/\?.+$/, "") ==
      CLB_RequestFactory.getURL(CLB_RequestFactory.PING)) {
    // We didn't get redirected. horray! carry on with authentication and log
    // the user into GAIA.
    this.setStatusDetails("Authenticating user...");
    this.req = this.loginUtil.startRequest(this.username, 
                                           this.password, 
                                           this.handleLoginSuccess,
                                           this.handleLoginFailure);
  } else {
    this.promptSvc.alert(this.win, 
                         "Network requires login",
                         "It looks like you are accessing the internet " + 
                         "through a connection which requires a web login. " + 
                         "This can happen when you connect through a public " + 
                         "network like at a hotel or an airport.\n\n" +
                         "Please setup your internet connection, then " +
                         "reconnect to Google Browser Sync.");

    CLB_app.setStatus(CLB_Application.STATUS_PING_REDIRECT);
    this.win.setTimeout("window.close()", 0);
  }
}

CLB_WelcomeForm.prototype.handleLoginFailure = function(code, status, message) {
  if (code == 403) {
    this.loginUtil.showErrorMessage(this.win, this.req.responseText);
    this.wizard.canAdvance = true;
    this.hideProgressMeter();
    this.wizard.goTo("clb-welcome");
  } else {
    this.handleLoginPhaseError("Error authenticating user", 
                               code, 
                               status, 
                               message);
  }

  this.req = null;
}

CLB_WelcomeForm.prototype.handleLoginSuccess = function(req) {
  this.req = null;

  // Reset from if the user previously failed login and loginutil set this.
  CLB_app.errorURL = null;

  this.sid = this.loginUtil.parseResponse(req.responseText)["SID"];

  var doc = CLB_XMLUtils.getDoc("VerifyUserExistsRequest",
                                {uid: this.sid});
                               
  this.setStatusDetails("Checking user status...");
 
  // We authenticated successfully. Now, check whether this GAIA user is a 
  // clobber user.
  this.req = CLB_RequestFactory.getRequest(CLB_RequestFactory.USER_EXISTS, 
                                           null,
                                           this.handleCheckUserSuccess,
                                           this.handleCheckUserFailure);

  this.req.send(doc);
}

CLB_WelcomeForm.prototype.handleCheckUserFailure = 
function(code, status, message) {
  this.req = null;

  if (code == CLB_WelcomeForm.REFRESH_SID_REQUIRED &&
      message == CLB_WelcomeForm.REFRESH_SID_REQUIRED_MSG &&
      !this.refreshingSID) {
    // The SID is out of date, we need to go get a new one from GAIA.
    // Set a flag so we only try this once.
    this.refreshingSID = true;
    this.setStatusDetails("Refreshing authorization...");
    this.req = this.loginUtil.startRequest(this.username, 
                                           this.password, 
                                           this.handleLoginSuccess,
                                           this.handleLoginFailure);
    
  } else if (code == CLB_WelcomeForm.NO_USER_ERROR &&
             message == CLB_WelcomeForm.NO_ACCOUNT_MSG) {
    // This GAIA user is not a clobber user. Go to the signup screen.
    CLB_app.prefs.setPref("showWelcome", true);
    this.wizard.canAdvance = true;
    this.hideProgressMeter();
    this.wizard.goTo("clb-installtype");

  } else {
    this.handleLoginPhaseError("Error checking user status",
                               code,
                               status,
                               message);
  }
}

CLB_WelcomeForm.prototype.handleCheckUserSuccess = function(req) {
  this.req = null;

  // This GAIA user is already a clobber user. Show the unlock screen.
  CLB_app.prefs.setPref("showWelcome", false);
  this.wizard.canAdvance = true;
  this.hideProgressMeter();
  this.wizard.advance("clb-token");
}

/**
 * Sets up the install type page (canAdvance setting is most
 * required if the user is coming from a 'back' button press
 * on a page that had 'next' disabled).
 */
CLB_WelcomeForm.prototype.showInstallTypePage = function() {
  this.wizard.canAdvance = true;
}

/**
 * Decides whether to use the default settings or show the advanced ones.
 */
CLB_WelcomeForm.prototype.handleInstallTypePageAdvanced = function() {
  // default syncedComponents and encryptedComponents preferences.
  var registeredComponents = CLB_syncMan.getComponents();
  var syncedComponents = [];
  var encryptedComponents = [];
  var component;
  
  while (component = registeredComponents.getNext()) {
    if (component.QueryInterface) {
      component.QueryInterface(Ci.GISyncComponent);
    }
  
    // We do not allow users to change whether to sync clobber's internal 
    // settings, since that would break clobber.
    if (component.componentID == CLB_SettingsSyncer.CONTRACT_ID) {
      continue;
    }
  
    syncedComponents.push(component.componentID);
  
    if (component.encryptionRequired) {
      encryptedComponents.push(component.componentID);
    }
  }

  CLB_app.setListPref("syncedComponents", syncedComponents);
  CLB_app.setListPref("encryptedComponents", encryptedComponents);
    
  if (this.installTypeDefaultRadio.selected) {
    // Save default values and proceed to the 'upload settings' page.
    this.usingAdvancedSettings = false;
    this.wizard.currentPage.next = "clb-createpin";
    return true;
  } else {
    this.usingAdvancedSettings = true;
    this.wizard.currentPage.next = "clb-settings";
    return true;
  }
}

CLB_WelcomeForm.prototype.showSettingsPage = function() {
  this.wizard.canAdvance = true;

  if (this.settingsPageInitialized) {
    return;
  }
  
  this.componentSelector.load();

  this.settingsPageInitialized = true;
}

CLB_WelcomeForm.prototype.handleSettingsSelected = function(isValid) {
  this.wizard.canAdvance = isValid;
}

CLB_WelcomeForm.prototype.handleSettingPageAdvanced = function() {
  this.componentSelector.save();
}

CLB_WelcomeForm.prototype.showCreatePinPage = function() {
  this.createTokenTextElm.focus();
  this.handleCreatePinPageInput();
}

CLB_WelcomeForm.prototype.handleCreatePinPageInput = function() {
  this.token = this.createTokenTextElm.value.trim();
  this.wizard.canAdvance =
    (this.confirmTokenTextElm.value.trim() != "" && this.token != "");
}

CLB_WelcomeForm.prototype.handleCreatePinPageAdvanced = function() {
  if (this.token.length < CLB_WelcomeForm.MIN_TOKEN_LENGTH) {
    this.promptSvc.alert(this.win,
                         "Invalid PIN",
                         "Your PIN must be at least four characters long.");
    return false;
  }

  if (this.token != this.confirmTokenTextElm.value.trim()) {
    this.promptSvc.alert(this.win,
                         "PINs do not match",
                         "Please enter the same PIN in both fields.");
    return false;
  }

  this.setStatusTitle("Creating account");
  this.setStatusBlurb("Please wait while we create your Google Browser "
                    + "Sync account.");
  this.setStatusDetails("Generating security key...");

  this.win.setTimeout(this.startGenerateKey, 10);
}

CLB_WelcomeForm.prototype.startGenerateKey = function() {
  // We create the master key by hashing together a lot of entropy from the
  // local machine.
  var hasher = new G_CryptoHasher();
  hasher.init(G_CryptoHasher.algorithms.SHA256);

  // The actual token typed by the user
  hasher.updateFromString(this.token);

  // Profile last mod dates
  var addDir = function(dir) {
    var children = dir.directoryEntries;
    var file;

    while (children.hasMoreElements()) {
      file = children.getNext().QueryInterface(Ci.nsILocalFile);

      // Files such as "lock" throw an error when accessed. We detect this by
      // checking the exists() method.
      if (!file.exists()) {
        continue;
      }

      hasher.updateFromString(String(file.lastModifiedTime));

      if (file.isDirectory()) {
        addDir(file);
      }
    }
  };

  addDir(G_File.getProfileFile());

  // Cookie names, hosts, paths, and values
  var cookies = Cc["@mozilla.org/cookiemanager;1"]
                .getService(Ci.nsICookieManager)
                .enumerator;

  for (var c; cookies.hasMoreElements() && (c = cookies.getNext()); ) {
    c.QueryInterface(Ci.nsICookie);
    hasher.updateFromString(c.host);
    hasher.updateFromString(c.path);
    hasher.updateFromString(c.name);
    hasher.updateFromString(c.value);
  }

  this.key = hasher.digestBase64();
  G_Debug(this, "Hashing complete, key generated. Encrypting key.");

  // Encrypt the key with the token
  this.encryptedKey =
    new CLB_Crypter2(this.getTokenBytes()).encryptString(this.key, "");


  // send createacct message
  this.setStatusDetails("Initializing account...");
                                                   
  var doc = CLB_XMLUtils.getDoc("CreateUserRequest", {uid: this.sid,
                                                      key: this.encryptedKey,
                                                      token: this.getTokenHash() });

  this.req = CLB_RequestFactory.getRequest(
    CLB_RequestFactory.CREATE_USER,
    null,
    this.handleCreateAccountSuccess,
    this.handleCreatePhaseError.bind(null, "Error initializing account"));

  this.req.send(doc);
}

CLB_WelcomeForm.prototype.getTokenHashOld = function() {
  var tokenHasher = new G_CryptoHasher();
  tokenHasher.init(G_CryptoHasher.algorithms.SHA1);
  tokenHasher.updateFromString(this.token);
  return tokenHasher.digestBase64();
}

CLB_WelcomeForm.prototype.getTokenHash = function() {
  var tokenHasher = new G_CryptoHasher();
  tokenHasher.init(G_CryptoHasher.algorithms.SHA1);
  tokenHasher.updateFromArray(this.getTokenBytes());
  return tokenHasher.digestBase64().substring(0, 6);
}

CLB_WelcomeForm.prototype.getTokenBytes = function() {
  var tokenHasher = new G_CryptoHasher();
  tokenHasher.init(G_CryptoHasher.algorithms.SHA256);
  tokenHasher.updateFromString(this.token);
  var base64 = tokenHasher.digestBase64();
  return CLB_app.base64r.decodeString(base64);
}

CLB_WelcomeForm.prototype.handleCreateAccountSuccess = function(req) {
  // save encryption key and token to disk (horray!)
  CLB_app.prefs.setPref("SID", this.sid);
  CLB_app.prefs.setPref("username", this.username);
  CLB_app.prefs.setPref("key", this.key);
  CLB_app.prefs.setPref("encryptedKey", this.encryptedKey);
  CLB_app.setToken(this.token);

  var mid = req.responseXML.getElementsByTagName("mid")[0];
  CLB_app.prefs.setPref("MID", mid.textContent);
  CLB_app.savePrefs();

  this.setStatusDetails("Importing initial state...");

  // start import.
  CLB_syncMan.addObserver(this);
  this.observingSyncMan = true;

  // this.creatingAccount = true will skip settings sync and force a reimport.
  this.wizard.canRewind = false;

  this.creatingAccount = true;  // Needed for syncMan observer calls
  this.syncing = true;  // Needed for cancel call

  CLB_syncMan.startSync(this.creatingAccount);
}

CLB_WelcomeForm.prototype.showRestartPage = function() {
  this.wizard.canRewind = false;
  this.wizard.getButton("cancel").disabled = true;
}

CLB_WelcomeForm.prototype.handleTokenPageShow = function() {
  this.verifyTokenTextElm.focus();
  this.handleTokenPageInput();
}

CLB_WelcomeForm.prototype.handleTokenPageInput = function() {
  this.token = this.verifyTokenTextElm.value.trim();
  this.wizard.canAdvance = this.token != "";
}

CLB_WelcomeForm.prototype.handleTokenPageAdvanced = function() {
  // canRewind = false won't work here (as the page advances
  // straight away, resetting it in the process), so we need 
  // to put it in the next page.
  this.tokenPageAdvanced = true;
  return true;
}

/**
 * Having the progress meter visible causes the UI for all elements
 * in the widget to update at the same rate the progress meter 
 * updates, making text cursors invisible.
 */
CLB_WelcomeForm.prototype.hideProgressMeter = function() {
  this.progressMeter.setAttribute("collapsed", true);
}

CLB_WelcomeForm.prototype.handleSyncingPageShow = function() {
  this.progressMeter.setAttribute("collapsed", false);
  this.wizard.canAdvance = false;
  this.wizard.canRewind = false;

  if(this.tokenPageAdvanced) {   
    this.setStatusTitle("Synchronizing browser");
    this.setStatusBlurb("");
    this.progressBlurbField.appendChild(
      this.doc.createTextNode("Please wait while we synchronize this browser "
                             + "with the server. This can take several "
                             + "minutes, but ")
    );
    
    var bolded = this.doc.createElementNS("http://www.w3.org/1999/xhtml", 
                                          "html:b");
    bolded.textContent = "you only need to do it once.";
    this.progressBlurbField.appendChild(bolded);

    this.setStatusDetails("Authenticating token...");


    // First try to get the key using the new method...
    var hashedToken = this.getTokenHash();

    var doc = CLB_XMLUtils.getDoc("AddClientRequest", {uid: this.sid,
                                                       token: hashedToken});

    this.usesNewKeyEncryption = true;

    this.req = CLB_RequestFactory.getRequest(
      CLB_RequestFactory.ADD_CLIENT,
      null,
      this.handleAddClientSuccess,
      this.handleAddClientFailure);

    this.req.send(doc);
    this.tokenPageAdvanced = false;
  }
}

CLB_WelcomeForm.prototype.handleAddClientFailure =
function(code, status, message) {
  if (code != CLB_Application.HTTP_STATUS_FORBIDDEN ||
      message != CLB_Application.ERROR_INVALID_PIN) {
    this.handleAddClientPhaseError(
        "Error authenticating token", code, status, message);
    return;
  }

  // the token didn't work, but it could be because it was hashed using the old method. Try that.
  var hashedToken = this.getTokenHashOld();

  var doc = CLB_XMLUtils.getDoc("AddClientRequest", {uid: this.sid,
                                                     token: hashedToken});

  this.usesNewKeyEncryption = false;
  this.req = CLB_RequestFactory.getRequest(
    CLB_RequestFactory.ADD_CLIENT,
    null,
    this.handleAddClientSuccess,
    this.handleAddClientPhaseError.bind(null, "Error authenticating token"));

  this.req.send(doc);
}

CLB_WelcomeForm.prototype.handleAddClientSuccess = function(req, blah) {
  this.req = null;

  // persist token to disk
  CLB_app.setToken(this.token);

  // save the returned key
  var mid = req.responseXML.getElementsByTagName("mid")[0];
  var key = req.responseXML.getElementsByTagName("key")[0];

  // Store the encrypted key for later use in server requests
  CLB_app.prefs.setPref("encryptedKey", key.textContent);

  // Decrypt the key with the token
  if (this.usesNewKeyEncryption) {
    var key =
      new CLB_Crypter2(this.getTokenBytes())
      .decryptString(key.textContent, "");
  } else {
    var key = CLB_Crypter.decryptString(key.textContent, this.token);
  }

  CLB_app.prefs.setPref("MID", mid.textContent);
  CLB_app.prefs.setPref("key", key);
  
  CLB_app.prefs.setPref("SID", this.sid);
  CLB_app.prefs.setPref("username", this.username);
  
  // first, synchronize just clobber settings
  // clear any internal settings left over from a previous setup
  CLB_app.prefs.clearPref("reimport");
  CLB_app.prefs.clearPref("lastUpdate");
  CLB_app.prefs.clearPref("encryptedComponents");
  CLB_app.prefs.clearPref("syncedComponents");
  
  CLB_app.savePrefs();

  CLB_syncMan.addObserver(this);
  this.observingSyncMan = true;

  this.setStatusDetails("Getting synchronization settings...");

  this.creatingAccount = false;  // Needed for syncMan observer calls
  this.syncing = true;  // Needed for cancel call
  CLB_syncMan.startSync();
}

CLB_WelcomeForm.prototype.syncProgress = function(state, fraction) {
  this.setStatusDetails(state);
}

CLB_WelcomeForm.prototype.syncFailure = function(code, status, message) {
  this.syncing_ = null;
  CLB_syncMan.removeObserver(this);

  if (this.syncing) {
    this.handleUpdatePhaseError("Error while sending update", 
                                code, status, message);
  } else if (this.creatingAccount) {
    this.handleCreatePhaseError("Error while creating client", 
                                code, status, message);
  } else {
    this.handleAddClientPhaseError("Error while adding client", 
                                   code, status, message);
  }
}

CLB_WelcomeForm.prototype.syncComplete = function() {
  this.syncing = null;
  
  // we're done!
  CLB_syncMan.removeObserver(this);
  this.wizard.canAdvance = true;
  this.hideProgressMeter();
  
  if (this.creatingAccount) {
    this.wizard.advance("clb-restart");
  } else {
    this.wizard.advance("clb-success");
  }
}

CLB_WelcomeForm.prototype.showSuccessPage = function() {
  this.wizard.canRewind = false;
  this.wizard.getButton("cancel").disabled = true;
}

CLB_WelcomeForm.prototype.handleLoginPhaseError = 
function(prefix, code, status, opt_message) {
  this.showError(prefix, code, status, opt_message);
  this.wizard.canRewind = true;
  this.wizard.rewind();
  this.wizard.canAdvance = true;
}

CLB_WelcomeForm.prototype.handleUpdatePhaseError =
function(prefix, code, status, opt_message) {
  this.showError(prefix, code, status, opt_message);

  if (this.creatingAccount) {
    this.wizard.canRewind = true;
    this.wizard.rewind();
    this.wizard.canAdvance = true;
  } else {
    this.wizard.goTo("clb-token");
    this.wizard.canAdvance = true;
  }
}

CLB_WelcomeForm.prototype.handleCreatePhaseError =
function(prefix, code, status, opt_message) {
  this.showError(prefix, code, status, opt_message);
  this.wizard.canRewind = true;
  this.wizard.rewind();
  this.wizard.canAdvance = true;
}

CLB_WelcomeForm.prototype.handleAddClientPhaseError = 
function(prefix, code, status, opt_message) {
  this.showError(prefix, code, status, opt_message);

  // TODO: Check to see what happens to 'back' button in this case
  this.wizard.goTo("clb-token");
  this.wizard.canAdvance = true;
}

CLB_WelcomeForm.prototype.showError = 
function(prefix, opt_code, opt_status, opt_message) {
  var message;

  if (CLB_app.isKickError(opt_code, opt_status, opt_message)) {
    message = "Please do not use Google Browser Sync on other machines " +
              "while setup is in progress.";
  } else {
    message = CLB_app.handleServerError(opt_code, opt_status, opt_message);
  }

  this.promptSvc.alert(this.win, null, prefix + ": " + message);
}

CLB_WelcomeForm.prototype.setStatusTitle = function(title) {
  this.progressPage.setAttribute("description", title);
}

CLB_WelcomeForm.prototype.setStatusBlurb = function(blurb) {
  while(this.progressBlurbField.childNodes.length) {
    this.progressBlurbField.removeChild(this.progressBlurbField.childNodes[0]);
  }
  this.progressBlurbField.textContent = blurb;
}

CLB_WelcomeForm.prototype.setStatusDetails = function(detail) {
  this.progressDetailsField.textContent = detail;
}

CLB_WelcomeForm.prototype.debugZone = "CLB_WelcomeForm";
G_debugService.loggifier.loggify(CLB_WelcomeForm.prototype,
                                 "getTokenBytes",
                                 "getTokenHash",
                                 "getTokenHashOld");
