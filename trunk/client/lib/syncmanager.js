// Copyright (C) 2005 and onwards Google, Inc.

/**
 * CLB_SyncManager - Central service in Clobber. Responsible for sync and update
 * communications with the server. GISyncComponent instances communicate with
 * this service to send updates to the server and receive sync information.
 */
function CLB_SyncManager() {
  this.started_ = false;
  this.sendUpdates_ = false;
  this.importExisting = false;
  this.registeredComponents_ = {};
  this.registeredConflicts_ = {};
  this.syncedComponents_ = {};
  this.encryptedComponents_ = {};
  this.observers_ = [];
  this.updateQueue_ = new CLB_UpdateQueue();
  this.updater_ = null;
  this.downloader_ = null;
  this.updateTimer_ = null;
  this.sendingUpdateQueue_ = null;
  this.v3migrated_ = null;

  this.periodicRate_ = null;
  this.immediateRate_ = null;

  // Related to sleep mode. lastActive tracks the last time something happened,
  // zzz is true when we are asleep.
  this.lastActive_ = new Date().getTime();
  this.zzz_ = false;

  this.updateSuccessHandler_ = this.handleUpdateSuccess.bind(this);
  this.updateFailureHandler_ = this.handleUpdateFailure.bind(this);

  this.notifyObserversProgress_ = 
    this.notifyObservers_.bind(this, "updateProgress");
}

/**
 * When components send us an update via the update() method, we wait this
 * amount of time to see if any more updates come, and then send it. This makes
 * it so that the server is usually very close to up to date with what's on the
 * client.
 */
CLB_SyncManager.DEFAULT_IMMEDIATE_RATE = 5; // 5 seconds

/**
 * We also periodically send updates to the server. These serve dual purposes.
 * First, the password syncer does not send updates as they occur, but waits for
 * the beforeUpdate to poll the passwords datastore to see if anything changed.
 * So if the user only had passwords enabled, then without this, we would never
 * send updates for passwords. Second, these periodic updates, which can even
 * contain no data if nothing has happed since the last update, serve as
 * "pings" that let the client know if it has been kicked.
 */
CLB_SyncManager.DEFAULT_PERIODIC_RATE = 60; // 1 minute

/**
 * If no update has been received within this amount of time, then we enter
 * sleep mode and send no more pings until maybeWakeUp is called.
 */
CLB_SyncManager.DEFAULT_NO_SLEEP_TILL = 60 * 10; // 10 minutes

CLB_SyncManager.REIMPORT_PREF_PREFIX =
  "extensions.browserstate.reimportComponent.";

CLB_SyncManager.prototype.debugZone = "CLB_SyncManager";

// nsISupports
CLB_SyncManager.prototype.QueryInterface = function(aIID) {
  if (!aIID.equals(Ci.nsISupports) &&
      !aIID.equals(Ci.GISyncManager))
    throw Components.results.NS_ERROR_NO_INTERFACE;

  return this;
}


// GISyncManager
/**
 * @see GISyncManager#start
 */
CLB_SyncManager.prototype.start = function() {
  this.refreshComponents();

  this.periodicRate_ = CLB_app.prefs.getPref(
      "periodicRate", CLB_SyncManager.DEFAULT_PERIODIC_RATE) * 1000;
  this.immediateRate_ = CLB_app.prefs.getPref(
      "immediateRate", CLB_SyncManager.DEFAULT_IMMEDIATE_RATE) * 1000;
  this.noSleepTill_ = CLB_app.prefs.getPref(
      "noSleepTill", CLB_SyncManager.DEFAULT_NO_SLEEP_TILL) * 1000;

  G_Debug(this, "Initialized periodic rate to: {%s}."
                .subs(this.periodicRate_));
  G_Debug(this, "Initialized immediate rate to: {%s}."
                .subs(this.immediateRate_));
  G_Debug(this, "Brooklyn is {%s} milliseconds away."
                .subs(this.noSleepTill_));

  this.started_ = true;
  this.startSyncedComponents_();
}

/**
 * @see GISyncComponent#stop
 */
CLB_SyncManager.prototype.stop = function() {
  this.cancelScheduledSend_();
  this.started_ = false;
  G_Debug(this, "sync manager stopped");
}


/**
 * Starts a selected component. This functionality is provided so 
 * that components can be started from the settings dialog prior
 * to the resync
 *
 * @see CLB_SettingsForm#handleOKButtonClicked
 */
CLB_SyncManager.prototype.startComponent = function(componentID) {
  if (!isDef(this.registeredComponents_[componentID])) {
    G_Debug(this, "ERROR: Cannot start component '%s'; "
                + "component does not exist".subs(componentID));
    return;
  }

  G_Debug(this, "Starting component %s".subs(componentID));
  this.registeredComponents_[componentID].start();
}

/**
 * Stops a selected component.
 *
 * @see #startComponent
 * @see CLB_SettingsForm#handleOKButtonClicked
 */
CLB_SyncManager.prototype.stopComponent = function(componentID) {
  if (!isDef(this.registeredComponents_[componentID])) {
    G_Debug(this, "ERROR: Cannot stop component '%s'; "
                + "component does not exist".subs(componentID));
    return;
  }
  
  G_Debug(this, "Stopping component '%s'".subs(componentID));
  this.registeredComponents_[componentID].stop();
}

/**
 * @see GISyncManager#registerComponent
 */
CLB_SyncManager.prototype.registerComponent = function(component) {
  this.registeredComponents_[component.componentID] = component;
}

/**
 * @see GISyncManager#unregisterComponent
 */
CLB_SyncManager.prototype.unregisterComponent = function(component) {
  delete this.registeredComponents_[component.componentID];
}

/**
 * @see GISyncManager#registerConflict
 */
CLB_SyncManager.prototype.registerConflict = function(component, typeID,
                                                      name, properties) {

  // TODO: should we have conflict types by componentID or componentID+typeID
  if (!isDef(this.registeredConflicts_[component.componentID])) {
    this.registeredConflicts_[component.componentID] = [];
  }

  var props = [];
  while (properties.hasMoreElements()) {
    props.push(properties.getNext());
  }

  this.registeredConflicts_[component.componentID].push(
      new CLB_Conflict(name, typeID, props));
}

/**
 * @see GISyncManager#getComponents
 * TODO(aa): make this return a regular array
 */
CLB_SyncManager.prototype.getComponents = function() {
  var retVal = [];

  for (var c in this.registeredComponents_) {
    retVal.push(this.registeredComponents_[c]);
  }

  return new CLB_ArrayEnumerator(retVal);
}

/**
 * Get a specific registered component by ID
 */
CLB_SyncManager.prototype.getComponent = function(id) {
  return this.registeredComponents_[id];
}

/**
 * @see GISyncManager#update
 */
CLB_SyncManager.prototype.update = function(newItem) {
  var comp = this.syncedComponents_[newItem.componentID];
  if (!comp) {
    G_DebugL(this,
             "ERROR: Received update from non-synced or unknown component: {%s}"
             .subs(newItem));
    return;
  }

  G_Debug(this, "Received update: " + newItem);
  this.updateQueue_.addItem(newItem);

  // Schedule a send for a short while from now. We wait a little while to get
  // all the associated tab, history, cookie, etc changes all in one shot.
  if (this.started_ && this.sendUpdates_) {
    this.schedule_(this.immediateRate_);
  }
}

CLB_SyncManager.prototype.addObserver = function(observer) {
  this.observers_.push(observer);
}

CLB_SyncManager.prototype.removeObserver = function(observer) {
  for (var i = 0; i < this.observers_.length; i++) {
    if (this.observers_[i] == observer) {
      this.observers_.splice(i, 1);
      return;
    }
  }

  throw new Error("Specified observer not found.");
}

/**
 *
 */
CLB_SyncManager.prototype.cancelSync = function() {
  if (this.currentSyncer_) {
    this.currentSyncer_.abort();
    this.currentSyncer_ = null;
    this.syncFailure(-1, "cancel", "cancel");
  } else {
    G_Debug(this, "Warning: no currentSyncer when trying to cancel sync");
  }
}

/**
 * Starts the syncronization process by starting a settings syncer.
 *
 * @see #settingsSyncComplete
 */
CLB_SyncManager.prototype.startSync = function(opt_skipSettings) {
  G_Debug(this, "Start Sync Called...");

  G_Debug(this, "Refreshing synced and encrypted components...");
  this.refreshComponents();
  this.v3migrated_ = CLB_app.prefs.getPref("v3migrated");

  // Stop any synced components while we download and apply new data.
  // WARNING: Don't change this order!! The start notification should
  // be able to take actions that don't trigger observers that are active
  // before a component is stopped.  In particular, bookmarksyncer relies
  // on this when calling beginUpdateBatch.

  this.notifyObservers_("syncStart");
  
  // If we have a new account, skip the settings sync (there's nothing on
  // the server yet) and go straight to the sync. This is also used by
  // settingsform to avoid having remote settings override the local
  // just-changed settings.
  if (opt_skipSettings || CLB_app.prefs.getPref("reimport", false)) {
    var componentsToImport = [];
    
    componentsToImport.push(CLB_SettingsSyncer.CONTRACT_ID);
    
    for (var componentID in this.syncedComponents_) {
      componentsToImport.push(componentID);
    }
       
    this.startDownload(componentsToImport);
    return;
  }

  G_Debug(this, "Syncing just settings...");

  // Only sync the settings first.
  var syncedComponents = {};
  syncedComponents[CLB_SettingsSyncer.CONTRACT_ID] = CLB_app.settingsSyncer;

  // Make a copy of the current settings so that we can compare to see what was
  // added after.
  this.lastSyncedComponents_ = CLB_app.getListPref("syncedComponents");

  G_Debug(this, "Creating settings downloader...");

  this.currentSyncer_ = 
    new CLB_Downloader(syncedComponents,
                       null /* no components to force download */,
                       this.registeredConflicts_,
                       null, // Don't try to resolve offline changes
                       this.getTimestamp("lastUpdate"),
                       this.getTimestamp("lastSync"),
                       this.settingsSyncComplete.bind(this),
                       this.syncFailure.bind(this),
                       this.notifyObservers_.bind(this, "syncProgress"));
}

/**
 * Once settings syncronization is complete, figure out if settings have
 * changed.  If they have, indicate, and if so start a 'reimport' else 
 * download the latest state
 *
 * @see #startDownload
 */
CLB_SyncManager.prototype.settingsSyncComplete = function() {
  G_Debug(this, "Settings Sync Complete");

  this.refreshComponents();  
  var componentsToImport = [];

  // Reimport any components which other computers explicitly requested be
  // reimported. (Used in settings form so that we don't miss any components the
  // users toggles off and then back on).
  for (var i = 0, item; item = CLB_app.settingsSyncer.syncedItems[i]; i++) {
    if (item.componentID == CLB_app.settingsSyncer.componentID &&
        item.itemID.startsWith(CLB_SyncManager.REIMPORT_PREF_PREFIX)) {
      componentsToImport.push(
          decodeURIComponent(
              item.itemID.substring(
                  CLB_SyncManager.REIMPORT_PREF_PREFIX.length)));
    }
  }

  // Also reimport new components which weren't here before.
  var syncedComponentsXOR = G_SetXOR(this.lastSyncedComponents_,
                                     CLB_app.getListPref("syncedComponents"));

  var newSyncedComponents = syncedComponentsXOR.right;
  var oldSyncedComponents = syncedComponentsXOR.left;

  componentsToImport = G_SetMerge(componentsToImport, newSyncedComponents);

  G_Debug(this, "Importing these components: " + componentsToImport);
 

  // Start new components which weren't here before.
  for (var j = 0, compID; compID = newSyncedComponents[j]; j++) {
    var comp = this.registeredComponents_[compID];

    if (!comp) {
      G_DebugL(this, "WARNING: could not start unknown component: " + compID);
      continue;
    }

    comp.start();
  }

  // Stop old components which aren't here anymore.
  for (var k = 0, compID; compID = oldSyncedComponents[k]; k++) {
    var comp = this.registeredComponents_[compID];

    if (!comp) {
      G_DebugL(this, "WARNING: could not stop unknown component: " + compID);
    }

    comp.stop();
  }

  this.startDownload(componentsToImport);
}

/**
 *
 */
CLB_SyncManager.prototype.changeSettings =
function(syncedComponents, encryptedComponents, clearedComponents,
         reimportComponents, onSuccess, onFailure) {
  // Settings form should have already completed pending updates and changes.
  if (this.checkSending()) {
    throw new Error("Cannot change settings. Update in progress.");
  }

  if (this.updateQueue_.hasPending()) {
    throw new Error("Cannot change settings. Changes are pending.");
  }
  
  var pending = [];

  for (var i = 0; i < clearedComponents.length; i++) {
    var componentID = clearedComponents[i];
    
    if (!this.registeredComponents_[componentID]) {
      G_Debug(this, "WARNING: Could not clear Component, '%s' not registered"
                    .subs(componentID));
      continue;
    }
    
    G_Debug(this, "%s isRemoveAll created".subs(componentID));

    pending.push(new CLB_SyncItem({
      componentID: componentID,
      isRemoveAll: true,
    }));
  }
  
  pending.push(new CLB_SyncItem({
    componentID: CLB_SettingsSyncer.CONTRACT_ID,
    itemID: "extensions.browserstate.syncedComponents",
    properties: {
      value: syncedComponents.join(",")
    }
  }));

  pending.push(new CLB_SyncItem({
    componentID: CLB_SettingsSyncer.CONTRACT_ID,
    itemID: "extensions.browserstate.encryptedComponents",
    properties: {
      value: encryptedComponents.join(",")
    }
  }));

  for (var i = 0; i < reimportComponents.length; i++) {
    var componentID = reimportComponents[i];
    
    pending.push(new CLB_SyncItem({
      componentID: CLB_SettingsSyncer.CONTRACT_ID,
      itemID: CLB_SyncManager.REIMPORT_PREF_PREFIX
            + encodeURIComponent(componentID),
      properties: {
        value: 1
      }
    }));   
  }

  this.updater_ = new CLB_Updater();
  this.updater_.start(pending,
                      false, /* don't read offline file */
                      this.changeSettingsComplete.bind(this, onSuccess), 
                      this.changeSettingsFailure.bind(this, onFailure),
                      function(){} /* don't care about progress notifs here */,
                      true /* send to server */,
                      false /* don't write offline flag */);
}

/**
 *
 */
CLB_SyncManager.prototype.changeSettingsComplete = function(onSuccess) {
  this.updater_ = null;
  onSuccess();
}

/**
 *
 */
CLB_SyncManager.prototype.changeSettingsFailure = 
  function(onFailure, code, status, message) {
  this.updater_ = null;
  onFailure(code, status, message);
}

CLB_SyncManager.prototype.cancelChangeSettings = function() {
  if (this.updater_) {
    this.updater_.cancel();
    this.updater_ = null;
  } else {
    G_Debug(this, "Warning: no updater when trying to cancel update");
  }
}

/**
 * Start the 'state download' process. Note that by 'download' we also
 * include 'upload', mostly just to confuse noobs like Glen.
 *
 * @param {Array) list of components to import
 */
CLB_SyncManager.prototype.startDownload = function(componentsToImport) {
  this.refreshComponents();

  if (isEmptyObject(this.syncedComponents_)) {
    this.syncComplete(null /* no new last update */);
    return;
  }
  
  // Some special-case code so that we can prompt the user for their
  // master password while syncingform is still open (prompting in 
  // #start is after it's closed, and causes Firefox to do strange 
  // things like thinking that the prompt is the browser window).
  if (this.syncedComponents_[CLB_PasswordSyncer.CONTRACT_ID]) {
    if (CLB_app.passwordSyncer.unlockPasswordStore() && 
        CLB_app.prefs.getPref("reimportPasswords", false)) {
      componentsToImport.push(CLB_PasswordSyncer.CONTRACT_ID);
    }
  }

  if (!this.v3migrated_) {
    G_Debug(this, "Not migrated. Adding encrypted components to import...");

    for(var compID in this.encryptedComponents_) {
      G_Debug(this, "  " + compID);
      componentsToImport.push(compID);
    }

    G_Debug(this,"Done.")
  }
  
  var pending;
  
  if (componentsToImport.length) {
    pending = [];

    // Store reimport requirement in case things blow up.
    CLB_app.prefs.setPref("reimport", true);
    CLB_app.savePrefs();

    var alreadyDone = {};
    
    for (var i = 0; i < componentsToImport.length; i++) {
      var componentID = componentsToImport[i];
      
      if (isDef(alreadyDone[componentID])) {
        G_Debug(this, "Duplicate component '%s', skipping".subs(componentID));
        continue;
      }
      
      alreadyDone[componentID] = true;
      
      G_Debug(this, "Importing component '%s'".subs(componentID));
      
      // Note that we use registeredComponents rather than syncedComponents
      // to allow settings import to work.
      var items = this.registeredComponents_[componentID].getCurrentItems();
      
      if (jsInstanceOf(items, Ci.nsISimpleEnumerator)) {
        pending.push(items);
      } else {
        G_Debug(this, "Error: getCurrentItems didn't return an enumerator");
      }
    }
  } else {
    // If we're not importing then the current items are anything that was
    // currently being updated + whatever's in the updatequeue.
    if (this.checkSending()) {
      this.cancelUpdate();
    }

    pending = this.updateQueue_.getPending();
    this.syncingUpdates_ = [];

    // Must clone because the items because downloader mutates them as they get
    // smooshed and whatnot. This isn't ideal, but typically this will have very
    // few items in it.
    for (var i = 0, item; item = pending[i]; i++) {
      this.syncingUpdates_.push(item.clone());
    }

    G_Debug(this,
            "Backed up {%s} update items".subs(this.syncingUpdates_.length));
  }
  
  this.updateQueue_ = new CLB_UpdateQueue();

  if (!this.v3migrated_) {
    G_Debug(this, "Adding v3migrated pref to pending items");

    pending.push(new CLB_SyncItem(
        { componentID: CLB_app.settingsSyncer.componentID,
          itemID: "v3migrated",
          properties: { value: "1" }}))
  }
  
  // This should replace the this.currentSyncer_ returned from startSync
  this.currentSyncer_ = 
    new CLB_Downloader(this.syncedComponents_,
                       componentsToImport,
                       this.registeredConflicts_,
                       pending,
                       this.getTimestamp("lastUpdate"),
                       this.getTimestamp("lastSync"),
                       this.syncComplete.bind(this),
                       this.syncFailure.bind(this),
                       this.notifyObservers_.bind(this, "syncProgress"));
}

/**
 * Tell all enabled components to stop watching changes.
 */
CLB_SyncManager.prototype.stopSyncedComponents = function() {
  G_Debug(this, "Stopping started components...");

  if (!this.started_) {
    G_Debug(this, "SyncManager is not started. Nothing to do.");
    return;
  }
  
  for (var compID in this.syncedComponents_) {
    G_Debug(this, "Stopping {%s}".subs(compID));
    this.syncedComponents_[compID].stop();
  }
}

/**
 * Tell all enabled components to start watching changes.
 */
CLB_SyncManager.prototype.startSyncedComponents_ = function() {
  G_Debug(this, "Starting synced components...");
  
  if (!this.started_) {
    G_Debug(this, "SyncManager is not started. Nothing to do.");
    return;
  }

  for (var compID in this.syncedComponents_) {
    G_Debug(this, "Starting {%s}".subs(compID));
    this.syncedComponents_[compID].start();
  }
}

CLB_SyncManager.prototype.syncComplete = function(lastUpdate) {
  this.currentSyncer_ = null;
  this.syncingUpdates_ = null;

  this.startSendingUpdates();
  
  CLB_app.prefs.setPref("reimport", false);
  CLB_app.prefs.setPref("hasOfflineData", false);
  CLB_app.prefs.setPref("v3migrated", "1");
  
  this.clearedComponents_ = {};
  
  if (lastUpdate) {
    CLB_app.prefs.setPref("lastUpdate", lastUpdate);
    CLB_app.prefs.setPref("lastSync", lastUpdate);

    G_Debug(this, "Set lastSync and lastUpdate to: " + lastUpdate);
  }
  
  CLB_app.savePrefs();
  
  // WARNING: Don't change this order!! The success notification should
  // be able to take actions that don't trigger observers added when
  // a component is started.  In particular, bookmarksyncer relies on this
  // when calling endUpdateBatch.
  this.notifyObservers_("syncComplete");

  this.schedule_(this.periodicRate_);
}

CLB_SyncManager.prototype.syncFailure = function(code, status, message) {
  this.startSendingUpdates();

  this.currentSyncer_ = null;
  this.recycleSyncingUpdates();

  this.notifyObservers_("syncFailure", code, status, message);

  this.schedule_(this.periodicRate_);
}

CLB_SyncManager.prototype.startSendingUpdates = function() {
  this.sendUpdates_ = true;
}

CLB_SyncManager.prototype.restartSync = function() {
  G_Debug(this, "Restarting sync");
  
  if (this.currentSyncer_) {
    G_Debug(this, "Aborting currentSyncer");
    this.currentSyncer_.abort();
    this.currentSyncer_ = null;
    this.syncFailure(-1, "restart", "restart");
  }

  this.recycleSyncingUpdates();
  this.startSync();
}

CLB_SyncManager.prototype.recycleSyncingUpdates = function() {
  if (this.syncingUpdates_) {
    G_Debug(this,
            "Recycling {%s} syncingUpdates".subs(this.syncingUpdates_.length));

    var newUpdateQueue = new CLB_UpdateQueue();

    for (var i = 0, item; item = this.syncingUpdates_[i]; i++) {
      newUpdateQueue.addItem(item);
    }

    newUpdateQueue.append(this.updateQueue_);
    this.updateQueue_ = newUpdateQueue;
    this.syncingUpdates_ = null;
  }
}

CLB_SyncManager.prototype.checkPending = function() {
  for (var componentID in this.syncedComponents_) {
    this.syncedComponents_[componentID].beforeUpdate();
  }

  return this.updateQueue_.hasPending();
}

CLB_SyncManager.prototype.checkSending = function() {
  return Boolean(this.updater_) || Boolean(this.pingReq_);
}

CLB_SyncManager.prototype.checkSyncing = function() {
  return Boolean(this.currentSyncer_);
}

CLB_SyncManager.prototype.sendPending = function(opt_finalSend) {
  G_Debug(this,
          "SendPending for {%s} items"
          .subs(this.updateQueue_.pendingSize()));

  if (this.checkSending()) {
    if (opt_finalSend) {
      G_Debug(this, "Previous update still pending, but this is a final send, "
                  + "so we're recycling it and forging onwards. Tally ho!");

      this.cancelUpdate();
    } else {
      // Fall through and continue with send
      G_Debug(this, "WARNING: Previous update still pending. "
                  + "Skipping request.");
      return false;
    }
  }

  if (this.currentSyncer_ && !opt_finalSend) {
    // We probably don't want to send an update while syncing. 
    // We'll just return and let the scheduled send deal with
    // it next time.
    G_Debug(this, "WARNING: Previous sync still running. "
                + "Skipping request.");
    return;
  }

  this.cancelScheduledSend_();

  if (!opt_finalSend) {
    // Tell components we're about to update so long as this isn't the update
    // right before shutdown.
    this.checkPending();

    // Don't check for sleepiness when we're doing our final update. We always
    // want to run the final update.
    this.maybeSleep_();
    if (this.zzz_) {
      return;
    }
  }

  this.notifyObservers_("updateStart");

  // If we're offline and allowed to reconnect, send a ping to
  // see if the server is accessible
  if (CLB_app.getStatus() == CLB_Application.STATUS_UPDATE_ERROR &&
      CLB_app.canReconnect()) {
    G_Debug(this, "Sending empty ping");
    
    this.pingReq_ = CLB_RequestFactory.getRequest(
        CLB_RequestFactory.PING,
        null /* no querystring */,
        this.handlePingSuccess.bind(this),
        this.handlePingFailure.bind(this),
        this.notifyObserversProgress_,
        true /* use GET */);

    this.pingReq_.send(null);
    return;
  }

  this.startUpdater_(CLB_app.canSend());
}

CLB_SyncManager.prototype.handlePingFailure = 
function(code, status, opt_message) {
  G_Debug(this, "Ping failed :(");
  this.pingReq_ = null;
  this.startUpdater_(false /* don't send to server */);
}

CLB_SyncManager.prototype.handlePingSuccess = function() {
  G_Debug(this, "Ping succeeded");
  this.pingReq_ = null;
  this.startUpdater_(CLB_app.canSend());
}

CLB_SyncManager.prototype.startUpdater_ = function(sendToServer) {
  this.updater_ = new CLB_Updater();
  this.sendingUpdateQueue_ = this.updateQueue_;
  this.updateQueue_ = new CLB_UpdateQueue();

  this.updater_.start(this.sendingUpdateQueue_.getPending(),
                      true /* look for offline changes? */,
                      this.updateSuccessHandler_, 
                      this.updateFailureHandler_,
                      this.notifyObserversProgress_,
                      sendToServer,
                      true /* write offline flag */);
}

CLB_SyncManager.prototype.handleUpdateFailure = 
  function(code, status, opt_message) {
  this.updater_ = null;
  this.notifyObservers_("updateFailure", code, status, opt_message);

  // If the updater failed before writing to disk, recycle the items it tried to
  // write back into the pending queue.
  if (code == CLB_Updater.ERROR_APPLICATION_PRE_FILE_WRITE) {
    G_Debug(this,
            "Recycling {%s} items from failed update"
            .subs(this.sendingUpdateQueue_.pendingSize()));

    this.sendingUpdateQueue_.append(this.updateQueue_);
    this.updateQueue_ = this.sendingUpdateQueue_;
  }

  if (!CLB_app.handleClientTooOldError(code, status, opt_message) &&
      !CLB_app.handleLastSyncTooOldError(code, status, opt_message) ) {
    CLB_app.handleServerError(code, status, opt_message);
  }
    
  if (this.started_) {
    this.schedule_(this.periodicRate_);
  }
}

CLB_SyncManager.prototype.handleUpdateSuccess = function(opt_newLastUpdate) {
  this.updater_ = null;

  if (isDef(opt_newLastUpdate)) {
    CLB_app.prefs.setPref("lastUpdate", opt_newLastUpdate);
    G_Debug(this, "Set lastUpdate to: " + opt_newLastUpdate);
  }

  CLB_app.prefs.setPref("hasOfflineData", false);
  CLB_app.savePrefs();
  
  this.notifyObservers_("updateComplete");

  if (this.started_) {
    this.schedule_(this.periodicRate_);
  }
}

/**
 * Rebuilds the syncedComponents_ lookup from the list in preferences. The 
 * lookup will not include components which are not available on this machine.
 *
 * Ideally, this would be occur as the result of watching the preference with
 * an observer, but that means we need a notification from profile-after-change
 * to install the observer. So we explicitly call this in the main areas we 
 * know that the preference may have changed.
 */
CLB_SyncManager.prototype.refreshSyncedComponents_ = function() {
  G_Debug(this, "Refreshing syncedComponents_ lookup... ");

  this.syncedComponents_ = {};

  CLB_app.getListPref("syncedComponents").forEach(function(id) {
    if (!this.registeredComponents_[id]) {
      G_Debug(this, "WARNING: The component {%s} has not been registered. " + 
                    "Skipping.".subs(id));
    } else {
      this.syncedComponents_[id] = this.registeredComponents_[id];
      G_Debug(this, "  added component {%s}".subs(id));
    }
  }, this);

  G_Debug(this, "Done.");
}

CLB_SyncManager.prototype.refreshEncryptedComponents_ = function() {
  G_Debug(this, "Refreshing encryptedComponents_ lookup... ");

  this.encryptedComponents_ = {};
  
  CLB_app.getListPref("encryptedComponents").forEach(function(id) {
    if (!this.registeredComponents_[id]) {
      G_Debug(this, "WARNING: The component {%s} has not been registered. " + 
                    "Skipping.".subs(id));
    } else {
      this.encryptedComponents_[id] = this.registeredComponents_[id];
      G_Debug(this, "  added component {%s}".subs(id));
    }
  }, this);

  G_Debug(this, "Done.");
}

/**
 * Should called when something (eg settingsform) updates the 
 * synced preferences.
 */
CLB_SyncManager.prototype.refreshComponents = function() {
  this.refreshSyncedComponents_();
  this.refreshEncryptedComponents_();
}

/**
 * Used by updater to determine if it should encrypt items.
 */
CLB_SyncManager.prototype.isEncryptedComponent = function(componentID) {
  if(this.registeredComponents_[componentID].requiresEncryption) {
    return true;
  }
  
  return isDef(this.encryptedComponents_[componentID]);
}

CLB_SyncManager.prototype.schedule_ = function(timeoutInMilliseconds) {
  if (timeoutInMilliseconds <= 0) {
    G_Debug(this, "Skipping schedule because timeout is zero.");
  } else {
    this.cancelScheduledSend_();
    
    G_Debug(this,
            "Scheduling send in {%s} milliseconds".subs(timeoutInMilliseconds));

    this.updateTimer_ = new G_Alarm(this.sendPending.bind(this),
                                    timeoutInMilliseconds);
  }
}

/**
 * Cancels any pending send scheduled with schedule_().
 */
CLB_SyncManager.prototype.cancelScheduledSend_ = function() {
  if (!this.updateTimer_) {
    G_Debug(this, "No scheduled send found to cancel");
    return;
  }

  this.updateTimer_.cancel();
  this.updateTimer_ = null;
}

/**
 * If there is an existing update pending, cancel it and return the items it was
 * sending. Otherwise return an empty array. Canceling the existing update will
 * have one of several effects depending on how much had happened when the
 * cancel occurs:
 *
 * - If the update is still being written to the offline file, the offline file
 *   will end off having some of the items that are also in the updateQueue. The
 *   next time an update is made, these will be smooshed since they have the
 *   same ID.
 *
 * - If the update has already been sent to the server, the update's item will
 *   be present in all of the offline file, the update queue, and the server.
 *   The offline file and update queue will cancel each other as they do above,
 *   and the update when it is sent will overwrite the changes on the server,
 *   since they also have the same ID.
 */
CLB_SyncManager.prototype.cancelUpdate = function() {
  if (!this.checkSending()) {
    G_Debug(this, "No existing update to recycle. Continuing.");
    return;
  }

  if (this.pingReq_) {
    this.pingReq_.abort();
    this.pingReq_ = null;
  }

  if (this.updater_) {
    this.updater_.cancel();
    this.updater_ = null;
  }

  if (isNull(this.sendingUpdateQueue_)) {
    G_DebugL(this,
             "ERROR: Expected sendingUpdateQueue to be non-null since " +
             "updater is. Skipping.");
    return;
  }

  G_Debug(this, "Recycling existing update containing {%s} items"
                .subs(this.sendingUpdateQueue_.pendingSize()));

  this.sendingUpdateQueue_.append(this.updateQueue_);
  this.updateQueue_ = this.sendingUpdateQueue_;
}

CLB_SyncManager.prototype.notifyObservers_ = function(methName) {
  var meth = arguments[0];
  var args = Array.prototype.splice.apply(arguments, [1, arguments.length]);

  for (var i = 0, observer; observer = this.observers_[i]; i++) {
    if (!observer[meth]) {
      continue;
    }

    observer[meth].apply(observer, args);
  }
}

/**
 * Go to sleep if there are no pending changes and there haven't been for too
 * long.
 */
CLB_SyncManager.prototype.maybeSleep_ = function() {
  if (this.zzz_) {
    return;
  }
  
  var now = new Date().getTime();

  var msSinceLastActive = now - this.lastActive_;

  G_Debug(this,
          ("Checking whether should sleep. ms since last active: {%s}, " +
           "limit: {%s}")
          .subs(msSinceLastActive, this.noSleepTill_));

  if (msSinceLastActive > this.noSleepTill_) {
    G_DebugL(this,
             "There has been no activity for too long. Going to sleep. zzz...");

    this.zzz_ = true;
  }
}

/**
 * If we are sleeping, wake up and schedule an update. This get's called
 * zillions of times by mousemove handlers in browseroverlay. Be careful what
 * you do in here.
 */
CLB_SyncManager.prototype.updateSleepyState = function() {
  this.lastActive_ = new Date().getTime();

  if (this.zzz_) {
    // We are sleeping, wake up!
    this.zzz_ = false;

    G_DebugL(this, "Waking up! lastActive is now: {%s}.".subs(this.lastActive_));

    this.sendPending();
  }
}

/**
 * Helper to get a named timestamp from prefs and default if not found.
 */
CLB_SyncManager.prototype.getTimestamp = function(name) {
  return CLB_app.prefs.getPref(name, new Date(0).toISO8601String());
}

G_debugService.loggifier.loggify(CLB_SyncManager.prototype,
                                 "maybeWakeUp");

if (CLB_DEBUG) {
  function TEST_CLB_SyncManager() {
    var zone = "TEST_CLB_SyncManager";
    
    // test notifyObservers_
    var syncMan = new CLB_SyncManager();

    var observer = {
      syncComplete: function(a, b, c) {
        this.a = a;
        this.b = b;
        this.c = c;
      }
    }

    syncMan.addObserver(observer);
    syncMan.notifyObservers_("syncComplete", 1, 2, 3);

    G_AssertEqual(zone, 1, observer.a, "Incorrect value for observer.a");
    G_AssertEqual(zone, 2, observer.b, "Incorrect value for observer.b");
    G_AssertEqual(zone, 3, observer.c, "Incorrect value for observer.c");
  }
}
