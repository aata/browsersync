// Copyright 2005 and onwards, Google


/**
 * An implementation of GISyncComponent for a specified subset of the
 * preferences tree. 
 *
 * This is a helper class intended to be used by another class which owns the
 * actual list of preferences to be synced. There will be at least two 
 * implementations: CLB_SettingsSyncer, which is responsible for synchronizing
 * the internal clobber preferences which the client depends upon, and 
 * CLB_PreferencesSyncer, which will synchronize general Firefox preferences.
 *
 * Usage:
 * 
 * var myPrefsSyncer = new CLB_PreferencesSyncer(
 *   "@my.com/my/prefs-syncer;1",
 *   "MyPrefsSyncer",
 *   "MY_PrefsSyncer",
 *   ["my.pref1", "my.pref2", etc...]);
 *
 * Cc["@google/browserstate/sync-man;1"]
 *   .getService(Ci.GISyncManager)
 *   .registerComponent(myPrefSyncer);
 *
 * @param componentID             A unique ID for this component.
 * @param componentName           A human-readable name for this component.
 * @param debugZone               The debugZone to name this component.
 * @param prefNames               An array of pref branches to watch.
 * @param opt_encryptionRequired  Optional. Whether the prefs should be 
 *                                encrypted before being sent to the server.
 */
function CLB_PreferencesSyncer(componentID, componentName, debugZone, prefNames,
                               opt_encryptionRequired) {
  bindMethods(this);
  
  // Required GISyncItem properties
  this.componentID = componentID;
  this.componentName = componentName;
  this.encryptionRequired = !!opt_encryptionRequired;
  this.syncBehavior = Ci.GISyncComponent.SYNC_SINCE_LAST_UPDATE;

  // required for G_DebugService support
  this.debugZone = debugZone;

  this.prefNames_ = {};
  this.prefs_ = new G_Preferences(null, false, true);
  this.started_ = false;
  this.syncedItems = [];

  for (var i = 0; i < prefNames.length; i++) {
    this.prefNames_[prefNames[i]] = 1;
  }

  CLB_syncMan.addObserver(this);
}

CLB_PreferencesSyncer.prototype.priority = 0;
CLB_PreferencesSyncer.prototype.syncOfflineChanges = true;

// Unused GISyncObserver interface members
CLB_PreferencesSyncer.prototype.syncProgress =
CLB_PreferencesSyncer.prototype.syncFailure =
CLB_PreferencesSyncer.prototype.syncComplete =
CLB_PreferencesSyncer.prototype.updateStart =
CLB_PreferencesSyncer.prototype.updateProgress =
CLB_PreferencesSyncer.prototype.updateFailure =
CLB_PreferencesSyncer.prototype.updateComplete = function() {}

/**
 * GISyncObserver.syncStart. Initialize the array of synced items.
 */
CLB_PreferencesSyncer.prototype.syncStart = function() {
  this.syncedItems = [];
}

/**
 * See GISyncItem.start
 */
CLB_PreferencesSyncer.prototype.start = function() {
  if (!this.started_) {
    this.prefs_.addObserver("", this.handlePrefChange_);
    this.started_ = true;
  }
}

/**
 * Stops the preferences syncer
 *
 * @see GISyncComponent#stop
 */
CLB_PreferencesSyncer.prototype.stop = function() {
  if (this.started_) {
    this.prefs_.removeObserver("", this.handlePrefChange_);
    this.started_ = false;
  }
}


/**
 * Gets called by preferences object when one of our prefs changes
 *
 * @param prefName  The preference which changed.
 */
CLB_PreferencesSyncer.prototype.handlePrefChange_ = function(prefName) {
  G_Debug(this, "Got change on pref {%s}".subs(prefName));
  
  var valid = false;
  for (var watchedPrefName in this.prefNames_) {
    if (prefName.indexOf(watchedPrefName) == 0) {
      valid = true;
      break;
    }
  }
  
  if (!valid) {
    G_Debug(this, "Skipping because we aren't watching this pref");
    return;
  }

  var syncItem = new CLB_SyncItem({ 
      componentID: this.componentID,
      itemID: prefName });

  var prefVal = this.prefs_.getPref(prefName);

  if (!isDef(prefVal)) {
    syncItem.isRemove = true;
  } else {
    syncItem.setProperty("value", prefVal);
  }

  CLB_syncMan.update(syncItem);
}

CLB_PreferencesSyncer.prototype.onBeforeResolveConflict = function(syncItem) {

}

CLB_PreferencesSyncer.prototype.onItemConflict = function(conflict, oldItem,
                                                          newItem) {
  return new CLB_ArrayEnumerator([]);
}

/**
 * See GISyncItem.onItemAvailable
 */
CLB_PreferencesSyncer.prototype.onItemAvailable = function(syncItem) {
  if (syncItem.isRemove) {
    this.prefs_.clearPref(syncItem.itemID);
  } else {
    this.prefs_.setPref(syncItem.itemID, syncItem.getProperty("value"));
  }

  this.syncedItems.push(syncItem);
}

CLB_PreferencesSyncer.prototype.getItemByID = function(id, typeid) {
  // No such thing as partial updates in prefsyncer, so we don't need
  // to worry about this
  return null;
}

/**
 * See GISyncItem.getCurrentItems
 */
CLB_PreferencesSyncer.prototype.getCurrentItems = function() {
  var result = [];
  var syncItem;

  getObjectProps(this.prefNames_).forEach(function(prefName) {
    var prefVal = this.prefs_.getPref(prefName);

    if (isDef(prefVal)) {
      var syncItem = new CLB_SyncItem({ 
        componentID: this.componentID,
        itemID: prefName });

      syncItem.setProperty("value", prefVal);
      result.push(syncItem);
    }
  }, this);

  return new CLB_ArrayEnumerator(result);
}


/**
 * See GISyncItem.beforeUpdate
 */
CLB_PreferencesSyncer.prototype.beforeUpdate = function() {
  // nop
}

CLB_PreferencesSyncer.prototype.debugZone = "CLB_PreferencesSyncer";
G_debugService.loggifier.loggify(CLB_PreferencesSyncer.prototype);

