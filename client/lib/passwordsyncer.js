// Copyright 2006 and onwards, Google Inc.

/**
 * Password Syncer
 */
function CLB_PasswordSyncer() {
  this.passMan_ = null;
  this.lastSyncedState_ = {};
  this.lastModified_ = null;
  this.signonsFile_ = null;
  this.enabled_ = null;
  
  this.knownMasterPassword_ = "";  
  this.promptSvc_ = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                      .getService(Ci.nsIPromptService);
}

CLB_PasswordSyncer.prototype.priority = 1;
CLB_PasswordSyncer.CONTRACT_ID = 
  "@google.com/browserstate/password-syncer;1";

CLB_PasswordSyncer.prototype.encryptionRequired = true;
CLB_PasswordSyncer.prototype.syncOfflineChanges = true;
CLB_PasswordSyncer.prototype.componentName = "Saved Passwords";

CLB_PasswordSyncer.TYPE_PASSWORD = "password";
CLB_PasswordSyncer.TYPE_REJECT = "reject";

CLB_PasswordSyncer.global_ = this;

CLB_PasswordSyncer.prototype.componentID = 
  "@google.com/browserstate/password-syncer;1";
  
CLB_PasswordSyncer.prototype.syncBehavior = 
  Ci.GISyncComponent.SYNC_SINCE_LAST_UPDATE;

/**
 * We don't put this in the constructor because getting the 
 * service too early crashes Firefox.
 *
 * Maybe we should change application.js so that components
 * are inited later to prevent the crashtaculons.
 */
CLB_PasswordSyncer.prototype.initPassMan_ = function() {
  if(!this.passMan_) {
    this.passMan_ = Cc["@mozilla.org/passwordmanager;1"].getService();
    this.passMan_.QueryInterface(Ci.nsIPasswordManager);
    this.passMan_.QueryInterface(Ci.nsIPasswordManagerInternal);
  }

  this.unlockPasswordStore();

  G_Debug(this, "Password Syncer is %s"
                .subs(this.enabled_ ? "enabled" : "disabled"));
  
  if (!this.signonsFile_) {
    // Note that even if the file doesn't exist, it won't chuck an error
    // here, so be sure to check for it whenever you use signonsFile_ (which
    // will also help detect if the file is deleted between now and then).
    this.signonsFile_ = G_File.getProfileFile("signons.txt");
    
    if (this.signonsFile_.exists()) {
      this.lastModified_ = this.signonsFile_.lastModifiedTime;
      this.lastSyncedState_ = this.getCurrentItems_();
    } else {
      G_Debug(this, "Passwords file did not exist");
    }
  }
}

/**
 * Verifies that our master password is valid, and if not, prompts the user
 * to enter one. Note that a successful checkPassword() will unlock the
 * passwords database for the rest of the session.
 */
CLB_PasswordSyncer.prototype.checkMasterPassword_ = function() {
  var token = Cc["@mozilla.org/security/pk11tokendb;1"]
              .createInstance(Ci.nsIPK11TokenDB)
              .getInternalKeyToken();

  var valid = false;
  
  try {
    // Try to validate a null password.
    valid = token.checkPassword("");

    if (!valid && this.knownMasterPassword_) {
      valid = token.checkPassword(this.knownMasterPassword_);
    }
  } catch (e) {
    // nsiPK11TokenDB threw an error because no
    // password existed.
    valid = true;
  }

  while (!valid) {
    var password = {value: ""};

    if (this.promptSvc_.promptPassword(null /* no parent window */,
              "Google Browser Sync needs your Master Password",
              "Google Browser Sync needs your Firefox Master Password in order"
              + " to sync your passwords, please enter it below.",
              password,
              null /* no checkbox */,
              {} /* no checkbox state */)) {
      valid = token.checkPassword(password.value);

      if (valid) {
        G_Debug(this, "User's password was valid.");
        this.knownMasterPassword_ = password.value;
      } else {
        G_Debug(this, "User's password was not valid.");
      }
    } else {
      // User pressed cancel, and is giving up.
      G_Debug(this, "User pressed cancel, giving up.");
      return false;
    }
  }
  
  return valid;
}

/**
 * Once a user's master password is verified and the session has been 
 * created, we don't need to check again - if a user changes their 
 * master password, the act of changing it validates their session 
 * again. We also don't want to prompt the user every time if they
 * choose to not enter their master password at startup. (no changing
 * minds for them!).
 */
CLB_PasswordSyncer.prototype.unlockPasswordStore = function() {
  if (isNull(this.enabled_)) {
    this.enabled_ = this.checkMasterPassword_(); 
  }
  
  return this.enabled_;
}

/**
 * Starts Password Syncer.
 */
CLB_PasswordSyncer.prototype.start = function() {
  G_Debug(this, "Password Syncer Start");
  
  this.initPassMan_();

  // If password syncing is enabled, we won't need to reimport the passwords
  // next time. Otherwise we will need to tell ourselves that passwords were
  // locally disabled
  CLB_app.prefs.setPref("reimportPasswords", !this.enabled_);
}

/**
 * Stops Password Syncer.
 */
CLB_PasswordSyncer.prototype.stop = function() {
  G_Debug(this, "Password Syncer Stop");
}

/**
 * Stub. Don't think we need to do anything fun here
 */
CLB_PasswordSyncer.prototype.onFirstSync = function() {
  // nop
}

/*
 * Notification of a change that has been downloaded from the server, before
 * conflict resolution begins
 */
CLB_PasswordSyncer.prototype.onBeforeResolveConflict = function(item) {
  // nop
}

/**
 * Called by syncman when an update smooshes a remove. We never use partial
 * updates so we just return null to tell syncman to use the update.
 */
CLB_PasswordSyncer.prototype.getItemByID = function(id, typeID) {
  return null;
}

/*
 * Indicates that there has been a conflict between two items
 */
CLB_PasswordSyncer.prototype.onItemConflict = function(name, oldItem,
                                                       newItem) {
  // nop - no conflicts for passwords
  return new CLB_ArrayEnumerator([]);
}

/**
 * Called when Clobber receives data from the server saying
 * ho there, I have items for you, here they are, one by one
 */
CLB_PasswordSyncer.prototype.onItemAvailable = function(item) {
  this.initPassMan_();
  
  if (!this.enabled_) {
    return;
  }
  
  G_Debug(this, "Item %s available".subs(item));

  if (item.isRemove) {
    if (!isDef(item.itemID)) {
      G_DebugL(this, "ERROR: received item does not have an itemID.");
      return;
    }

    if (!this.lastSyncedState_[item.itemID]) {
      G_DebugL(this,
               "ERROR: Could not find entry in lastSyncedState_ " +
               "corresponding to itemID {%s}".subs(item.itemID));
      return;
    }

    // We pass the item from lastSyncedState because removeFromPassMan needs
    // the item details like host and use, and the remove items don't have that.
    this.removeFromPassMan_(this.lastSyncedState_[item.itemID]);

    delete this.lastSyncedState_[item.itemID];
  } else {
    if (item.typeID == CLB_PasswordSyncer.TYPE_REJECT) {
      if (!item.hasProperty("host")) {
        G_DebugL(this, "ERROR: Received reject does not has a host property");
        return;
      }
      
      this.passMan_.addReject(item.getProperty("host"));
    } else {
      if (!item.hasProperty("host") || !item.hasProperty("user") ||
          !item.hasProperty("password")) {
        G_DebugL(this,
                 "ERROR: Received password does not have required properties.");
        return;
      }
      
      this.passMan_.addUserFull(item.getProperty("host"),
                                item.getProperty("user"),
                                item.getProperty("password"),
                                item.getProperty("userFieldName"),
                                item.getProperty("passFieldName"));
    }

    this.lastSyncedState_[item.itemID] = item.clone();
  }
}

/**
 * Implements GISyncComponent.getCurrentItems. We don't implement a real
 * enumerator because doing so meant we had to lazily hash the itemIDs and doing
 * that made things really icky.
 */
CLB_PasswordSyncer.prototype.getCurrentItems = function() {
  this.initPassMan_();

  if (!this.enabled_) {
    return new CLB_ArrayEnumerator([]);
  }
  
  var arr = [];
  var currentItems = this.getCurrentItems_();

  for (var itemID in currentItems) {
    arr.push(currentItems[itemID]);
  }

  return new CLB_ArrayEnumerator(arr);
}
 
/**
 * GISyncComponent method
 */
CLB_PasswordSyncer.prototype.beforeUpdate = function() {
  G_Debug(this, "Password Syncer beforeUpdate");

  // Store whether the signons file existed, so that later we can
  // determine whether it had recently been created.
  var signonsFileExisted = Boolean(this.signonsFile_);

  this.initPassMan_();
  
  if (!this.enabled_) {
    return;
  }
  
  // Check lastModifiedDate of signons.txt - if it's the same as 
  // last time, nothing has changed, so we don't need to go any
  // further.
  
  // Refresh signonsFile (so we get a new lastModifiedTime)
  this.signonsFile_ = G_File.getProfileFile("signons.txt");
  
  if (this.signonsFile_.exists()) {
    if (signonsFileExisted &&
        this.lastModified_ == this.signonsFile_.lastModifiedTime) {
      G_Debug(this, "Passwords have NOT been modified");
      return;
    }
  } else {
    G_Debug(this, "Password file did not exist");

    // Either it's a new profile, or the user deleted signons.txt,
    // in either case, password manager should have nothing we want.
    return; 
  }
  
  G_Debug(this, "Passwords have been modified");
  
  // If the file didn't exist, initPassMan will have populated lastSyncedState
  // with the current state, so we won't detect any changes.
  if (!signonsFileExisted) {
    this.lastSyncedState_ = {};
  }

  var currentItems = this.getCurrentItems_();
  var updates = [];
  
  // Detect additions
  for(var itemID in currentItems) {
    var item = currentItems[itemID];
    
    if(isDef(item.itemID) && !isDef(this.lastSyncedState_[item.itemID])) {
      G_Debug(this, "Sending addition {%s} to syncman".subs(item));
      CLB_syncMan.update(item.clone());
    }
  }

  // Detect deletes
  for(var itemID in this.lastSyncedState_) {
    var item = this.lastSyncedState_[itemID];
    
    if(isDef(item.itemID) && !isDef(currentItems[item.itemID])) {
      item = item.clone();
      item.clearProperties();
      item.isRemove = true;
      G_Debug(this, "Sending deletion {%s} to syncman".subs(item));
      CLB_syncMan.update(item);
    }
  }

  this.lastModified_ = this.signonsFile_.lastModifiedTime;
  this.lastSyncedState_ = currentItems;
}

/**
 * Gets all current passwords and rejections. This just uses
 * CLB_PasswordEnumerator but doesn't bother hashing the ID
 * we could probably make this faster by not using syncItems 
 * either (but that would mean some doubling up of code).
 */
CLB_PasswordSyncer.prototype.getCurrentItems_ = function() {
  this.initPassMan_();
  
  if (!this.enabled_) {
    return {};
  }

  var passEnumerator = this.passMan_.enumerator;
  var rejectEnumerator = this.passMan_.rejectEnumerator;
  var result = {};
  var passObj;
  
  while (passEnumerator.hasMoreElements()) {
    passObj = passEnumerator.getNext()
                            .QueryInterface(Ci.nsIPasswordInternal);
    var syncItem = null;
    
    try {
      syncItem = this.createSyncItem_(passObj, false /* not reject */);
    } catch (e) {
      if (e.message == "PASSWORD INACCESSIBLE") {
        G_Debug(this,
                "Skipping inaccessible password for host {%s}"
                .subs(passObj.host));
      } else {
        throw e;
      }
    }
    
    if (syncItem) {
      result[syncItem.itemID] = syncItem;
    }
  }

  while (rejectEnumerator.hasMoreElements()) {
    passObj = rejectEnumerator.getNext()
                              .QueryInterface(Ci.nsIPasswordInternal);

    var syncItem = null;
    
    try {
      syncItem = this.createSyncItem_(passObj, true /* is reject */);
    } catch (e) {
      if (e.message == "PASSWORD INACCESSIBLE") {
        G_Debug(this,
                "WARNING: Skipping inaccessible reject for host {%s}"
                .subs(passObj.host));
      } else {
        throw e;
      }
    }
    
    if (syncItem) {
      result[syncItem.itemID] = syncItem;
    }
  }
  
  return result;
}

/**
 * Helper to try and remove a syncitem from the password manager and handle
 * errors.
 */
CLB_PasswordSyncer.prototype.removeFromPassMan_ = function(item) {
  var host = item.getProperty("host");
  var user = item.getProperty("user");
  
  // removeUser and removeReject throw if user doesn't exist
  if (item.typeID == CLB_PasswordSyncer.TYPE_REJECT) {
    try {
      this.passMan_.removeReject(host);
    } catch(e) {
      G_DebugL(this, "ERROR: Failed to remove reject '%s' with error '%s'"
                     .subs(host, e));
    }
  } else {
    try {
      this.passMan_.removeUser(host, user);
    } catch(e) {
      G_DebugL(this, "Failed to remove user from host '%s' with error '%s'"
                     .subs(host, e));
    }
  }
}

/**
 * Creates a sync item for the given nsIPassword object
 */
CLB_PasswordSyncer.prototype.createSyncItem_ = function(passObject, isReject) {
  var syncItem = new CLB_SyncItem();
  syncItem.componentID = this.componentID;

  try {
    var test = passObject.user + passObject.password;
    // We need to do something with this variable, otherwise JSCompiler
    // optimizes it away.
    CLB_PasswordSyncer.global_.foo_ = test;
  } catch (e) {
    G_Debug(this, "Password was not accessible, perhaps due to master "
                + "password blocking. Error: %s".subs(e));
    throw new Error("PASSWORD INACCESSIBLE");
  }

  if (isReject) {
    syncItem.typeID = CLB_PasswordSyncer.TYPE_REJECT;
    syncItem.setProperty("host", passObject.host);
  } else {
    syncItem.typeID = CLB_PasswordSyncer.TYPE_PASSWORD;
    syncItem.setProperty("host", passObject.host);
    syncItem.setProperty("user", passObject.user);
    syncItem.setProperty("password", passObject.password);
    syncItem.setProperty("userFieldName", passObject.userFieldName);
    syncItem.setProperty("passFieldName", passObject.passwordFieldName);
  }

  this.updateItemID(syncItem);
  return syncItem;
}

/**
 * Sets the itemID for the specified item by hashing all the properties which
 * make it unique together.
 */
CLB_PasswordSyncer.prototype.updateItemID = function(item) {
  var hasher = new G_CryptoHasher();
  hasher.init(G_CryptoHasher.algorithms.SHA1);

  hasher.updateFromString(CLB_app.getKey());
  hasher.updateFromString(item.getProperty("host"));
  
  if(item.typeID == CLB_PasswordSyncer.TYPE_REJECT) {
    hasher.updateFromString("false");
  } else {
    hasher.updateFromString("true");
    hasher.updateFromString(item.getProperty("user"));
    hasher.updateFromString(item.getProperty("password"));
    hasher.updateFromString(item.getProperty("userFieldName"));
    hasher.updateFromString(item.getProperty("passFieldName"));
  }

  item.itemID = hasher.digestBase64();
}

CLB_PasswordSyncer.prototype.debugZone = "CLB_PasswordSyncer";
G_debugService.loggifier.loggify(CLB_PasswordSyncer.prototype);

