// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Encapsulates the state of a sync as it progresses from download, to 
 * parsing, to resolving conflicts with offline items, to uploading conflict
 * resolutions to the server, to farming syncItem objects out to
 * interested components.
 *
 * The downloader can run in download only mode or in normal mode.
 * If newUpdates passed to the downloader is null, then it runs
 * in download only mode.  In this mode, we skip parsing offline items,
 * conflict resolution, and uploading new updates to the server.
 * So, the sequence of events in download only mode is:
 * 1. Send sync requests (sendSyncReqs)
 * 2. Parse synced data (parseNextItem)
 * 3. Farm SyncItems out to components (applySyncItem)
 *
 * In the normal downloader mode the sequence of events is:
 * 1. Parse offline items, adding to sendToServerQueue (parseNextItem)
 * 2. Smoosh newUpdates passed to downloader into sendToServerQueue - Note that
 *    the newUpdates array can contain enumerators (addNewUpdateToSQueue) 
 * 3. Create conflict value maps (addOfflineToConflictMap)
 * 4. Send sync requests (sendSyncReqs)
 * 5. Parse synced (parseNextItem)
 * 6. Do conflict resolution (resolveConflicts)
 * 6. Send offline and resolutions to the server (startUpdate)
 * 7. Farm SyncItems out to components (applySyncItem)
 *
 * Conflicts between items are detected by checking a conflict value
 * map for each conflict rule.  If a conflict is detected, the relevant
 * component is called to resolve the conflict.
 *
 * TODO: Better failure more for if client crashes during farming
 * sync items out to components (perhaps backing up sync items to disk
 * before sending update to server)
 *
 * TODO(aa): Investigate accessing event queue directly so that we don't need
 * timeout-based yielding.
 */
function CLB_Downloader(componentsHash, componentsToSync,
                        registeredConflicts, newUpdates, prevLastUpdate,
                        prevLastSync, onSuccess, onFailure, onProgress) {
  if (isEmptyObject(componentsHash)) {
    throw new Error("No components to sync.");
  }
  
  bindMethods(this);

  this.componentsHash = componentsHash;
  
  // componentsToSync is a list of components whose conents we want to
  // download from the server
  this.componentsToSync = {};
  if (componentsToSync) {
    for (var i = 0; i < componentsToSync.length; i++) {
      this.componentsToSync[componentsToSync[i]] = true;
    }
  }
  
  // The timestamp that was previously stored that we should be syncing from.
  this.prevLastUpdate = prevLastUpdate;
  this.prevLastSync = prevLastSync;

  // The new timestamp that the server returns that we will save to use as
  // prevTimestamp next time this is called.
  this.newTimestamp = null;

  // Notification callbacks 
  this.onProgress = onProgress;
  this.onSuccess = onSuccess;
  this.onFailure = onFailure;
  
  // Keeps track of active sync requests
  this.reqs = [];
  
  // Managed phased item parsing.
  this.itemsBucket = [];
  this.phase = 0;

  // Holds the list of downloaded sync items so they can be parsed
  this.downloadedItems = [];

  // Holds the list of parsed sync items so that they can be resolved
  // We use an update queue here so that new items from conflict resolution
  // can quickly be smooshed on top of items that need to be processed
  this.parsedSyncItems = new CLB_UpdateQueue();

  // applyLocallyQueue holds the items that need to be applied locally
  // localIndex is used while we are asynchronously applying the changes
  // to the browser
  this.applyLocallyQueue = new CLB_UpdateQueue();
  this.localIndex = 0;
  
  // sendToServerQueue holds the items that should be sent to the server after
  // conflict resolution.
  this.sendToServerQueue = new CLB_UpdateQueue();
  this.serverQueueIndex = 0;

  // Handles all aspects of item conflict resolution
  this.conflictResolver = new CLB_ConflictResolver(registeredConflicts,
                                                   this.componentsHash,
                                                   this.sendToServerQueue,
                                                   this.applyLocallyQueue);

  // Initialized as each new phase of downloading and conflict resolution
  // starts.
  this.funQueue = new G_WorkQueue();
  this.funQueue.onError = this.handleWorkQueueError;

  // Make sure that our newUpdates array is not null, indicating that we
  // should start out by parsing offline items.  newUpdates will be an
  // empty array during a normal sync and will contain imported items
  // during an import/sync
  if (newUpdates != null) {
    G_Debug(this, "newUpdates specified. Parsing offline changes.");
    this.newUpdates = newUpdates;

    // First parse the offline items into the sendToServerQueue. This must be
    // done asynchronously since there can be lots of offline items to parse.
    this.funQueue.addJob(this.parseOfflineItems);
  } else {
    // newUpdates is null, so we want to skip looking for offline changes
    // and uploading them to the server.  In practice this is only used for
    // syncing setting changes.
    G_Debug(this, "Warning: Not initializing updater - download only mode");
    this.funQueue.addJob(this.sendSyncReqs);
  }
}

/**
 * Checks the value of the hasOfflineData preference, which updater maintains
 * and will be true if the upater could not send data to the server last time
 * for any reason.
 *
 * If the value is true, then downloader parses these items and adds them to the
 * sendToServerQueue.
 */
CLB_Downloader.prototype.parseOfflineItems = function() {
  G_Debug(this, "Parsing offline file");
  
  if (!CLB_Updater.hasOfflineData()) {
    G_Debug(this, "No offline data to parse, skipping to addNewUpdates");

    this.onProgress(CLB_Application.PROGRESS_UNOFFLINING, 1 /* done! */);
    this.addNewUpdatesToServerQueue();
    return;
  }
  
  try {
    var doc = G_FirefoxXMLUtils.loadXML(CLB_Updater.getOfflineFile());
  } catch (e) {
    // Error parsing file (may have contained junk chars from previous
    // version).
    G_Debug(this, "Offline data was corrupt, skipping.");
    CLB_app.prefs.setPref("hasOfflineData", false);
    
    this.onProgress(CLB_Application.PROGRESS_UNOFFLINING, 1 /* done! */);
    this.addNewUpdatesToServerQueue();
    return;
  }
  
  var items = doc.getElementsByTagName("item");
  var numItems = items.length;
  var index = 0;
  
  // This should usually have 0-1 items in it.
  var cleared = doc.getElementsByTagName("clearedComponents");

  for (var i = 0; i < cleared.length; i++) {
    var xmlItem = cleared[i];
    var child = null;

    for (var u = 0; child = xmlItem.childNodes[u]; u++) {
      if (child.localName != "component") {
        G_Debug(this, "WARNING: item within a <clearedComponents> "
                    + "block was not a <component>");
        continue;
      }

      var syncItem = new CLB_SyncItem({
        isRemoveAll: true
      });


      syncItem.componentID = child.textContent;

      this.sendToServerQueue.addItem(syncItem);
    }
  }
  
  var parseNext = bind(function() {
    // progress
    this.onProgress(CLB_Application.PROGRESS_UNOFFLINING, index / numItems);
                  
    // Check to see if we're done!
    if (index == numItems) {
      G_Debug(this,
              "Done parsing offline items. Next up: add new updates " +
              "to serverqueue.");
      this.addNewUpdatesToServerQueue();
      return;
    }

    var item = CLB_SyncItem.parseAndDecryptFromXML(items[index++]);

    if (item) {
      var comp = CLB_syncMan.getComponent(item.componentID);

      // Only take an offline item if we are supposed to be syncing it,
      // according to our settings
      if (!comp) {
        G_Debug(this,
                "WARNING: Skipping offline item for unregistered component. " +
                "Item: " + item);

      } else if (!comp.syncOfflineChanges) {
        G_Debug(this,
                "WARNING: Skipping offline item for component which " + 
                "doesn't sync offine changes. Item: " + item);

      } else {
        // Add the offline item to the list of things to be sent to the server.
        this.sendToServerQueue.addItem(item);
      }
    }

    this.funQueue.addJob(parseNext);
  }, this);

  G_Debug(this, "There are {%s} offline items to parse".subs(numItems));
  parseNext();
}

/**
 * Adds each of the newUpdates specified in the constructor to the
 * sendToServerQueue on top of the parsed offline items.
 */
CLB_Downloader.prototype.addNewUpdatesToServerQueue = function() {
  G_Debug(this, "Adding new updates to server queue...");
  var index = 0;

  var addNext = bind(function() {
    if (index == this.newUpdates.length) {
      G_Debug(this, "Done adding new updates. Next up: build conflict maps.");

      // We don't do real updates on the gathering stage since we can't really
      // know how many items are in an enumerator. That's OK though because this
      // stage is usually pretty shorty.
      this.onProgress(CLB_Application.PROGRESS_GATHERING, 1 /* done */);

      this.addPendingToConflictResolver();
      return;
    }

    var item = this.newUpdates[index];

    // newUpdates can also be enumerators...
    if (jsInstanceOf(item, Ci.nsISimpleEnumerator)) {
      if (item.hasMoreElements()) {
        this.sendToServerQueue.addItem(item.getNext());
      } else {
        index++;
      }
    } else {
      this.sendToServerQueue.addItem(item);
      index++;
    }

    this.funQueue.addJob(addNext);
  }, this);

  G_Debug(this, "There are {%s} updates to add".subs(this.newUpdates.length));
  addNext();
}

/**
 * Adds each of the pending items (offine items + newUpdates) to the conflict
 * resolver.
 */
CLB_Downloader.prototype.addPendingToConflictResolver = function() {
  G_Debug(this, "Adding pending items to conflict maps");

  var index = 0;
  var items = this.sendToServerQueue.getPending();

  var addNext = bind(function() {
    this.onProgress(CLB_Application.PROGRESS_INDEXING, index / items.length);

    if (index == items.length) {
      G_Debug(this,
              "Done adding items to conflict maps. Next up: send sync reqs");
      this.sendSyncReqs();
      return;
    }

    this.conflictResolver.addToConflictMaps(items[index++]);
    this.funQueue.addJob(addNext);
  }, this);

  G_Debug(this, "There are {%s} items to add".subs(items.length));
  addNext();
}

/**
 * After creating conflict maps, send our sync requests to the server
 */
CLB_Downloader.prototype.sendSyncReqs = function() {
  G_Debug(this, "Sending sync requests");
  this.onProgress(CLB_Application.PROGRESS_DOWNLOADING, 0);

  // split the components into separate lists by timestamp
  var lastSyncComponents = [];
  var lastUpdateComponents = [];
  var everythingComponents = [];

  for (var component in this.componentsHash) {
    if (this.componentsToSync[component]) {
      everythingComponents.push(this.componentsHash[component].componentID);
    } else if (this.componentsHash[component].syncBehavior ==
               Ci.GISyncComponent.SYNC_SINCE_LAST_SYNC) {
      lastSyncComponents.push(this.componentsHash[component].componentID);
    } else {
      lastUpdateComponents.push(this.componentsHash[component].componentID);
    }
  }

  // we send the requests in parallel, but only start parsing once we 
  // receive all responses. This is slightly inefficient, but will make it
  // easier to do progress reporting.
  if (everythingComponents.length > 0) {
    G_Debug(this,
            "Sending a request for everything from components: " +
            everythingComponents.join(","));

    this.sendSyncReq(everythingComponents, new Date(0).toISO8601String());
  }
  
  if (lastSyncComponents.length > 0) {
    G_Debug(this,
            "Sending a request for deltas since last sync from components: " +
            lastSyncComponents.join(","));

    this.sendSyncReq(lastSyncComponents, this.prevLastSync);
  }

  if (lastUpdateComponents.length > 0) {
    G_Debug(this,
            "Sending a request for deltas since last update from components: " +
            lastUpdateComponents.join(","));
    
    this.sendSyncReq(lastUpdateComponents, this.prevLastUpdate);
  }
}

/**
 * Sends a sync request for the specified components from the specified
 * timestamp.
 */
CLB_Downloader.prototype.sendSyncReq = function(components, timestamp) {
  var doc = CLB_XMLUtils.getDoc("SyncRequest", {uid: CLB_app.getSID(),
                                              mid: CLB_app.getMID(),
                                              key: CLB_app.getEncryptedKey()});

  CLB_XMLUtils.addElm(doc.documentElement, "timestamp", timestamp);

  var componentsElm = doc.createElement("components");
  doc.documentElement.appendChild(componentsElm);

  for (var i = 0; i < components.length; i++) {
    CLB_XMLUtils.addElm(componentsElm, "component", components[i]);
  }

  G_Debug(this, "Sending sync request with document:\n" +
                G_FirefoxXMLUtils.getXMLString(doc));

  var req = CLB_RequestFactory.getRequest(
              CLB_RequestFactory.SYNC,
              null,
              this.onLoad,
              this.onError);

  req.send(doc);
  this.reqs.push(req);
}

/**
 * Gets called when there is an error during the sync request downloads.
 */
CLB_Downloader.prototype.onError = function(code, status, message) {
  G_Debug(this,
          "Got error during download. Code: %s, status: %s, message: %s"
          .subs(code, status, message));
  
  this.abort();
  this.onFailure(code, status, message);
}

/**
 * Gets called for each sync request which completes successfully.
 */
CLB_Downloader.prototype.onLoad = function(req) {
  try {
    if (CLB_app.prefs.getPref("log-xml", false)) {
      var file = CLB_app.getUniqueTempFile("download", "xml");
      G_FileWriter.writeAll(file, req.responseText);
      G_Debug(this, "logged download in file: " + file.path);
    }

    var items = req.responseXML.getElementsByTagName("item");
    G_Debug(this, "Number of items downloaded: {%s}".subs(items.length));

    // Squirrel away the timestamp until we are done and will save it.
    this.newTimestamp = CLB_XMLUtils.getTimestamp(req.responseXML);

    // Add all the received items to a list to be processed. this is 
    // synchronous, but should be fast enough (tm). If we were using MochiKit,
    // we could wrap the two in an iterator. Sadness.
    // this.itemsBucket = [];
    
    for (var i = 0; i < items.length; i++) {
      var componentID;
      
      for (var j = 0, child; child = items[i].childNodes[j]; j++) {
        if (child.localName == "componentID") {
          componentID = child.textContent;
          break;
        }
      }
      
      if (!componentID) {
        G_DebugL(this, "No componentID found");
        continue;
      }
      
      var phase = CLB_syncMan.getComponent(componentID).priority;
      
      if (!isDef(phase)) {
        throw new Error("Priority was not defined.");
      }
      
      if (!isDef(this.itemsBucket[phase])) {
        this.itemsBucket[phase] = [];
      }
      
      this.itemsBucket[phase].push(items[i]);
    }
    
    // remove this request from the list of ones we've sent
    this.reqs.splice(this.reqs.indexOf(req), 1);
    
    // Bail if we've not yet received all the requests we sent
    if (this.reqs.length > 0) {
      return;
    }

    // It would be better to update after each request, but really there can
    // only be two and they should come in relatively quickly on after the other
    // so we're not really missing much by not being more granular.
    this.onProgress(CLB_Application.PROGRESS_DOWNLOADING,  1 /* all done */);

    this.parseNextBucket(true /* start at the first bucket */);
  } catch (e) {
    // onLoad gets called asynchronously, from XMLHttpRequest. This catches any
    // unexpected errors that happen on that stack and notifies the UI so that
    // it can stop the progress bar and show the user a error.
    this.onFailure(-1, "Unexpected error", e.toString());
    throw e;
  }
}

/**
 *
 */
CLB_Downloader.prototype.parseNextBucket = function(startFromBeginning) {
  G_Debug(this, "Parsing next bucket");
  
  if (startFromBeginning) {
    this.phase = 0;
  } else {
    CLB_syncMan.notifyObservers_("bucketComplete");
    this.phase++;
  }
  
  if (this.phase >= this.itemsBucket.length) {
    G_Debug(this, "Done resolving all conflicts, next up: update server");
    
    this.startUpdate(); 
    return;
  }
  
  if (!isDef(this.itemsBucket[this.phase]) || 
      this.itemsBucket[this.phase].length == 0) {
    G_Debug(this, "Nothing in this bucket, skipping");
    this.parseNextBucket(false /* not starting from beginning */);
    return;
  }
  
  this.downloadedItems = this.itemsBucket[this.phase];
  this.parseDownloadedItems();
}

/**
 * Once we have downloaded the newest state from the server, we parse it into
 * syncitems and check for duplicates. The only time we can get dupes is if one
 * was encrypted and one was not. In this case, we take the one that is in the
 * current encrypt state.
 */
CLB_Downloader.prototype.parseDownloadedItems = function() {
  G_Debug(this, "Parsing downloaded items");
  var index = 0;

  var parseNext = bind(function() {
    this.onProgress(CLB_Application.PROGRESS_PARSING,
                    index / this.downloadedItems.length);

    if (index == this.downloadedItems.length) {
      G_Debug(this, "Done parsing items. Next up: resolve conflicts");
      this.smooshDownloadedWithOffline();
      return;
    }

    var syncItem =
      CLB_SyncItem.parseAndDecryptFromXML(this.downloadedItems[index++]);

    if (syncItem) {
      var comp = CLB_syncMan.getComponent(syncItem.componentID);

      if (!comp) {
        G_DebugL(this, "ERROR: Could not find component with ID: {" +
                 syncItem.componentID + "} for item {" +
                 syncItem.itemID + "} . Dropping.");
      } else {
        var lookupKey = syncItem.makeLookupKey();
        var prevItem = this.parsedSyncItems.getItemByLookupKey(lookupKey);
        var compIsEncrypted =
          CLB_syncMan.isEncryptedComponent(comp.componentID);

        // The "originallyEncrypted" property is set in
        // CLB_SyncItem.parseAndDecryptFromXML
        if (prevItem && prevItem.originallyEncrypted == compIsEncrypted) {
          G_Debug(this,
                  "Smooshing previous item on top of synced item because " +
                  "there are two items with the same ID and the previous " +
                  "one is in the correct encryption state.");

          CLB_UpdateQueue.smooshItems(syncItem, prevItem);
          this.parsedSyncItems.deleteItemByLookupKey(lookupKey);
        }

        this.parsedSyncItems.addItem(syncItem);
      }
    }

    this.funQueue.addJob(parseNext);
  }, this);

  G_Debug(this,
          "There are {%s} items to parse".subs(this.downloadedItems.length));

  parseNext();
}

  
CLB_Downloader.prototype.smooshDownloadedWithOffline = function() {
  G_Debug(this, "Smooshing downloaded items with offline items.");
  var index = 0;
  var items = this.parsedSyncItems.getPending();

  var smooshNext = bind(function() {
    if (index == items.length) {
      G_Debug(this,
              "Done smooshing downloaded items with offline items. Next up: " +
              "resolve conflicts.");
      this.resolveConflicts();
      return;
    }

    var syncItem = items[index++];
    var itemsEqual = this.conflictResolver.smooshWithOffline(syncItem);

    // If there is an offline item that is exactly equal to the synced item,
    // there's no need to even process the synced item since we know that
    // offline changes win.
    if (itemsEqual) {
      this.parsedSyncItems.deleteItemByLookupKey(syncItem.makeLookupKey());
    } else {
      // There must be a component for this sync item since we already checked
      // in parseDownloadedItems.
      CLB_syncMan.getComponent(syncItem.componentID)
        .onBeforeResolveConflict(syncItem.clone());
    }

    this.funQueue.addJob(smooshNext);
  }, this);

  G_Debug(this,
          "There are {%s} items to smoosh".subs(items.length));

  smooshNext();
}

/**
 * Goes through each of the parsed downloaded items and uses conflictResolver
 * to resolve any conflicts it might cause.
 */
CLB_Downloader.prototype.resolveConflicts = function() {
  G_Debug(this, "Resolving conflicts");
  var index = 0;

  var resolveNext = bind(function() {
    this.onProgress(CLB_Application.PROGRESS_RESOLVING,
                    index / this.parsedSyncItems.pendingSize());

    if (this.parsedSyncItems.pendingSize() == 0) {
      G_Debug(this, "Done resolving conflicts for this phase");
      this.parseNextBucket(false /* not starting from beginning */);
      return;
    }

    index++;

    var syncItem = this.parsedSyncItems.popNextItem();
    var isDownloaded = !syncItem.includesConflictResolution;
    
    // Resolve conflicts
    var moreItems = this.conflictResolver.resolveConflicts(syncItem,
                                                           isDownloaded);

    // Add the newly created items to the queue of items that need to
    // have conflict resolution performed. (Note that the created
    // items do not include the sync item - that item should be modified
    // directly)
    for (var i = 0; i < moreItems.length; i++) {
      this.parsedSyncItems.addItem(moreItems[i]);

      // Mark the item as including conflict resolution changes.  This tells
      // us that we need to upload this item, and also allows us to treat
      // it differently in the conflict resolver.
      var lookupKey = moreItems[i].makeLookupKey();
      this.parsedSyncItems.getItemByLookupKey(lookupKey)
        .includesConflictResolution = true;
    }

    // Add synced item to sync queue - keep this after conflict resolution
    // so that resolution code can distinguish between the new item and items
    // already in the queues
    this.applyLocallyQueue.replaceItem(syncItem);

    this.funQueue.addJob(resolveNext);
  }, this);

  G_Debug(this, "There are {%s} items to check for conflicts"
                .subs(this.parsedSyncItems.pendingSize()));
  resolveNext();
}

/**
 * Once we've resolved all conflicts, we will be left with the items to send to
 * the server. We do so here.
 */
CLB_Downloader.prototype.startUpdate = function() {
  if (this.sendToServerQueue.pendingSize() > 0) {
    G_Debug(this, "Sending {%s} items to the server"
                  .subs(this.sendToServerQueue.pendingSize()));

    this.updater = new CLB_Updater();
    this.updater.start(this.sendToServerQueue.getPending(),
                       false /* don't look for offline data */,
                       this.updateComplete, 
                       this.onFailure,
                       this.onProgress,
                       true /* send data to server */,
                       false /* write offline file */);
  } else {
    G_Debug(this, "There are zero updates to send.");
    this.updateComplete();
  }
}

CLB_Downloader.prototype.updateComplete = function(opt_newLastUpdate) {
  G_Debug(this, "Update successful. Next up: apply local changes");

  // We can either be called as the success handler from CLB_Updater or directly
  // if there were no updates to perform. If we did an update, overwrite the
  // timestamp we recorded on the last sync with the timestamp from that update.
  if (opt_newLastUpdate) {
    this.newTimestamp = opt_newLastUpdate;
  }
  
  // Now that the update completed successfully, we can apply the
  // synced changes to Firefox's local datastore
  this.applyLocalChanges();
}

CLB_Downloader.prototype.applyLocalChanges = function() {
  G_Debug(this, "Applying local changes");
  
  var index = 0;
  var items = this.applyLocallyQueue.getPending();

  var applyNext = bind(function() {
    if (index == items.length) {
      // w00t!
      G_Debug(this, "Done applying local changes. Firing success handler!");
      this.onSuccess(this.newTimestamp);
      return;
    }

    this.onProgress(CLB_Application.PROGRESS_APPLYING,
                    index / items.length);

    var syncItem = items[index++];
    var comp = CLB_syncMan.getComponent(syncItem.componentID);

    comp.onItemAvailable(syncItem);
    this.funQueue.addJob(applyNext);
  }, this);

  G_Debug(this, "There are {%s} local changes to apply".subs(items.length));
  applyNext();
}

/**
 * Abort a download in progress
 */
CLB_Downloader.prototype.abort = function() {
  // cancel all pending requests
  this.reqs.forEach(function(req) {
    req.abort();
  });

  if (this.updater) {
    this.updater.cancel();
    this.updater = null;
  }

  if (this.funQueue) {
    this.funQueue.cancel();
    this.funQueue = null;
  }
}

/**
 * Handles errors thrown from within workqueue jobs.
 */
CLB_Downloader.prototype.handleWorkQueueError = function(job, e) {
  G_DebugL(this,
           "Error during downloader workqueue job.\n" +
           "%s\n%s:%s".subs(e.message, e.fileName, e.lineNumber));

  this.onFailure(-1, "Unexpected error", e.toString());
}

CLB_Downloader.prototype.debugZone = "CLB_Downloader";
G_debugService.loggifier.loggify(CLB_Downloader.prototype);
