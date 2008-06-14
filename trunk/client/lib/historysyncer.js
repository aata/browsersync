// Copyright 2005 and onwards, Google

/**
 * Syncs browser history by listening through an rdf observer for changes.
 * Each sync item is a url, with some associated meta information, like
 * visit count, first visit date, and last visit date.
 */

function CLB_HistorySyncer() {
  this.hist_ = Cc["@mozilla.org/browser/global-history;2"]
               .getService(Ci.nsIGlobalHistory2)
               .QueryInterface(Ci.nsIBrowserHistory);

  this.histDS_ = Cc["@mozilla.org/rdf/datasource;1?name=history"]
                 .getService(Ci.nsIRDFDataSource);
  this.histRdfServ_ = Cc["@mozilla.org/rdf/rdf-service;1"]
                      .getService(Ci.nsIRDFService);
  this.ioSvc_ = Cc["@mozilla.org/network/io-service;1"]
                .getService(Ci.nsIIOService);

  this.obsSvc_ = Cc["@mozilla.org/observer-service;1"]
                 .getService(Ci.nsIObserverService);

  // Used to store data during a batch update so we can determine what
  // changed after the batch update
  this.updateBatchData_ = {};

  // Whether or not syncmanager has called start on us
  this.started_ = false;

  // Whether browser shutdown has been initiated - we need to know this
  // because the syncmanger doesn't record anything after shutdown
  // begins but history expiration happens after that
  this.inShutdown_ = false;

  // Whether we are currently processing an onItemAvailable - used to prevent
  // apply/update loops.
  this.inOnItemAvailable_ = false;

  // The RDF properties that we will collect for history items, and the 
  // corresponding property names we will store them as in GISyncItem.
  this.propertiesToCollect_ = new G_DoubleDictionary();
  this.propertiesToCollect_.addMultiple(
    { "name": CLB_HistorySyncer.nameRdfStr,
      "date": CLB_HistorySyncer.dateRdfStr,
      "firstDate": CLB_HistorySyncer.firstDateRdfStr,
      "visitCount": CLB_HistorySyncer.visitCountRdfStr });
}

CLB_HistorySyncer.global = this;
CLB_HistorySyncer.prototype.priority = 2;
CLB_HistorySyncer.rootRdfStr = "NC:HistoryRoot";

CLB_HistorySyncer.rdfPrefix = "http://home.netscape.com/NC-rdf#";
CLB_HistorySyncer.nameRdfStr = CLB_HistorySyncer.rdfPrefix + "Name";
CLB_HistorySyncer.dateRdfStr = CLB_HistorySyncer.rdfPrefix + "Date";
CLB_HistorySyncer.firstDateRdfStr =
  CLB_HistorySyncer.rdfPrefix + "FirstVisitDate";
CLB_HistorySyncer.visitCountRdfStr =
  CLB_HistorySyncer.rdfPrefix + "VisitCount";
CLB_HistorySyncer.childRdfStr = CLB_HistorySyncer.rdfPrefix + "child";


CLB_HistorySyncer.prototype.debugZone = "CLB_HistorySyncer";

// nsISupports
CLB_HistorySyncer.prototype.QueryInterface = function(aIID) {
  if (!aIID.equals(Ci.nsISupports) &&
      !aIID.equals(Ci.GISyncComponent) &&
      !aIID.equals(Ci.nsIRDFObserver))
    throw Components.results.NS_ERROR_NO_INTERFACE;

  return this;
}

// nsIObserver
CLB_HistorySyncer.prototype.observe = function(subject, topic, data) {
  if (topic == "quit-application") {
    this.inShutdown_ = true;
    this.obsSvc_.removeObserver(this, "quit-application");
  }
}

// GISyncComponent
CLB_HistorySyncer.prototype.componentID =
  "@google.com/browserstate/history-syncer;1";
CLB_HistorySyncer.prototype.componentName = "History";
CLB_HistorySyncer.prototype.encryptionRequred = false;
CLB_HistorySyncer.prototype.syncOfflineChanges = true;
CLB_HistorySyncer.prototype.syncBehavior =
  Ci.GISyncComponent.SYNC_SINCE_LAST_UPDATE;

/**
 * Starts the history syncer
 *
 * @see GISyncComponent#start
 */
CLB_HistorySyncer.prototype.start = function() {
  if(!this.started_) {
    this.histDS_.AddObserver(this);

    // This is needed so that we can flush our expired history to disk
    this.obsSvc_.addObserver(this, "quit-application", false);

    // Setup an alarm to send expired history items to syncmanager, if the
    // file exists
    new G_Alarm(function() {
      if (!this.hasHistoryExpirationFile_()) {
        return;
      }

      var file = this.getHistoryExpirationFile_();
      var urls = G_FileReader.readAll(file).split(G_File.LINE_END_CHAR);

      urls.forEach(function(url) {
        if (url) {
          var item = this.getHistoryDeleteItem_(url);
          CLB_syncMan.update(item);
        }
      }, this);

      // Now get rid of the file so we don't do this over and over
      file.remove(false);
    }.bind(this), 0);

    this.started_ = true;
  }
}

/**
 * Stops the history syncer
 *
 * @see GISyncComponent#stop
 */
CLB_HistorySyncer.prototype.stop = function() {
  if (this.started_) {
    this.histDS_.RemoveObserver(this);
    this.obsSvc_.removeObserver(this, "quit-application");
    this.started_ = false;
  }
}

/**
 * Notification that an item has been downloaded
 *
 * @see GISyncComponent#onItemDownloaded
 */
CLB_HistorySyncer.prototype.onBeforeResolveConflict = function(item) {
}

/**
 * Notification that a conflict has been detected between items
 *
 * @see GISyncComponent#onItemConflict
 */
CLB_HistorySyncer.prototype.onItemConflict = function(conflict, oldItem,
                                                      newItem) {
}

/**
 * Notification that an item is available to be applied to the local
 * Firefox store
 *
 * @see GISyncComponent#onItemAvailable
 */
CLB_HistorySyncer.prototype.onItemAvailable = function(item) {
  this.inOnItemAvailable_ = true;

  try {
    this.initializeHistory_();
    this.addHistoryItem_(item);
  } finally {
    this.inOnItemAvailable_ = false;
  }
}

/**
 * Need to retrieve a SyncItem by ID, to fill in a partial update
 *
 * @see GISyncComponent#getItemByID
 */
CLB_HistorySyncer.prototype.getItemByID = function(id, typeid) {
  this.initializeHistory_();

  // All history items have the same parent and arc
  var root = this.histRdfServ_.GetResource(CLB_HistorySyncer.rootRdfStr);
  var childArc = this.histRdfServ_.GetResource(CLB_HistorySyncer.childRdfStr);

  return this.getUpdateItem_(root, childArc, id);
}

/**
 * Retrieve all items currently in the history datastore
 *
 * @see GISyncComponent#getCurrentItems
 */
CLB_HistorySyncer.prototype.getCurrentItems = function() {
  this.initializeHistory_();

  var e = this.histDS_.GetAllResources();
  return new CLB_HistoryEnumerator(e);
}

/**
 * Notification that the syncmanager is about to send an update to the server
 *
 * @see GISyncComponent#beforeUpdate
 */
CLB_HistorySyncer.prototype.beforeUpdate = function() {
}


// nsIRDFObserver

/**
 * Notification sent when the target of an arc changes.
 *
 * @see nsIRDFObserver#onChange
 */
CLB_HistorySyncer.prototype.onChange = function(aDataSource, aSource,
                                                aProperty, aOldTarget,
                                                aNewTarget) {
  if (this.inOnItemAvailable_) {
    // Skip our own updates
    return;
  }
  
  var newValue = CLB_rdf.getValueFromNode(aNewTarget);
  if (!newValue) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  var item = this.getUpdateItem_(aSource, aProperty, newValue, false);

  if (item) {
    CLB_syncMan.update(item);
  }
}

/**
 * Notification sent when a new assertion is created
 *
 * @see nsIRDFObserver#onAssert
 */
CLB_HistorySyncer.prototype.onAssert = function(aDataSource, aSource,
                                                aProperty, aTarget) {
  if (this.inOnItemAvailable_) {
    // Skip our own updates
    return;
  }
  
  var value = CLB_rdf.getValueFromNode(aTarget);
  if (!value) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  var item = this.getUpdateItem_(aSource, aProperty, value, false);

  if (item) {
    CLB_syncMan.update(item);
  }

  //CLB_rdf.writeRdfToFile(this.histDS_, -1, "history_dump");
}

/**
 * Notification sent when an assertion is removed
 *
 * @see nsIRDFObserver#onUnassert
 */
CLB_HistorySyncer.prototype.onUnassert = function(aDataSource, aSource,
                                                  aProperty, aTarget) {
  if (this.inOnItemAvailable_) {
    // Skip our own updates
    return;
  }
  
  var value = CLB_rdf.getValueFromNode(aTarget);
  if (!value) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  // The following cases are handled in onBeginUpdateBatch and
  // onEndUpdateBatch, but if that's slow we could probably do some
  // fancy pattern matching to handle it here:
  //
  // 1. The case where match=Hostname and text=<hostname>, when
  // all items are deleted from that hostname
  // really find:datasource=history&match=AgeInDays&method=is&
  // text=0&groupby=Hostname child is find:datasource=history&match
  // =AgeInDays&method=is&text=0&datasource=history&match=Hostname
  // &method=is&text=<hostname>
  //
  // 2. The case where NC:HistoryByDateAndSite child is
  // find:datasource=history&match=AgeInDays&method=is&text=0&
  // groupby=Hostname
  //
  // 3. The case where NC:HistoryByDate child is
  // find:datasource=history&match=AgeInDays&method=is&text=0

  var item = this.getUpdateItem_(aSource, aProperty, value, true);

  if (item) {
    CLB_syncMan.update(item);
  }
}

/**
 * Notification when the source of an assertion is moved.
 * Since this is never called by the history datasource, we should never
 * see this notification here.
 *
 * @see nsIRDFObserver#onMove
 */ 
CLB_HistorySyncer.prototype.onMove = function(aDataSource, aOldSource,
                                              aNewSource, aProperty, aTarget) {

  if (this.inOnItemAvailable_) {
    // Skip our own updates
    return;
  }
  
  G_Debug(this, "WARNING: unexpected move from history component");
}

/**
 * This indicates that there is about to be a large update to items, and
 * there will not be individual notifications sent out (how convenient!)
 * This sort of notification works well for UI, which only has to be
 * updated at the end of a change, but for us it isn't so convenient.
 *
 * For the history datasource, this is called only when a batch of
 * things are deleted (i.e. deleting all urls from a host, etc.
 * To find out what changed, we build a map of the urls before the
 * change and compare that to the urls after the change.
 *
 * @see nsIRDFObserver#onBeginUpdateBatch
 */
CLB_HistorySyncer.prototype.onBeginUpdateBatch = function(aDataSource) {
  G_Debug(this, "onBeginUpdateBatch!!");

  // make sure the existing array doesn't have any remaining data
  this.updateBatchData_ = {};

  // put the url of each history item into the associative array
  var root = this.histRdfServ_.GetResource(CLB_HistorySyncer.rootRdfStr);
  var childArc = this.histRdfServ_.GetResource(CLB_HistorySyncer.childRdfStr);
  var targets = this.histDS_.GetTargets(root, childArc, true);

  while (targets.hasMoreElements()) {
    var tar = targets.getNext();
    var url = CLB_rdf.getValueFromNode(tar);
    this.updateBatchData_[url] = 1;
  }
}

/**
 * This indicates that a large update to items just finished (see comments
 * in onBeginUpdateBatch).
 *
 * For our purposes, we compare the existing history items with the history
 * items before this batch update and record the items that have been deleted.
 *
 * @see nsIRDFObserver#onEndUpdateBatch
 */
CLB_HistorySyncer.prototype.onEndUpdateBatch = function(aDataSource) {
  G_Debug(this, "onEndUpdateBatch!!");

  // For each url currently in history, if it was also here before
  // the batch update, remove it from our array. (we're only keeping
  // track of batch deletes here)
  var root = this.histRdfServ_.GetResource(CLB_HistorySyncer.rootRdfStr);
  var childArc = this.histRdfServ_.GetResource(CLB_HistorySyncer.childRdfStr);
  var targets = this.histDS_.GetTargets(root, childArc, true);

  while (targets.hasMoreElements()) {
    var tar = targets.getNext();
    var url = CLB_rdf.getValueFromNode(tar);
    if (this.updateBatchData_[url]) {
      delete this.updateBatchData_[url];
    } else {
      G_Debug(this, "Warning - something was added during the batch update: " +
              url);
    }
  }

  // We're left with our batch delete
  if (this.inShutdown_) {
    // HACK ALERT: If we are shutting down, syncmanager won't get these updates
    // so flush them to disk.
    // Be sure we only do this once
    this.inShutdown_ = false;

    // First form a string to flush
    var urlsToFlush = [];
    for (var hist in this.updateBatchData_) {
      urlsToFlush.push(hist);
    }

    // Actually write the string to disk if there are any expired history
    // items
    if (urlsToFlush.length > 0) {
      var expiredFile = this.getHistoryExpirationFile_();
      G_FileWriter.writeAll(expiredFile,
                            urlsToFlush.join(G_File.LINE_END_CHAR));
      G_Debug(this, "Wrote history expiration file with " +
              urlsToFlush.length + "urls");
    }
  } else {

    // If we're not shutting down, then syncman can accept our updates,
    // so form update items for each deleted url
    for (var hist in this.updateBatchData_) {
      var item = this.getHistoryDeleteItem_(hist);
      CLB_syncMan.update(item);
    }
  }

  // clean out updateBatchData for the next round
  this.updateBatchData_ = {};
}


// private

/*
 * Hack to force the history database to initialize itself, since
 * there is no API to do this.
 */
CLB_HistorySyncer.prototype.initializeHistory_ = function() {
  // We need to do something with this variable, otherwise JS compiler
  // optimizes it away. Don't want to log it because this gets called a lot.
  CLB_HistorySyncer.global.foo_ = this.hist_.lastPageVisited;
}

/**
 * Get the file where we will flush expired history items to on shutdown
 */
CLB_HistorySyncer.prototype.getHistoryExpirationFile_ = function() {
  return G_File.getProfileFile("browserstate-expiredHistory.txt");
}

CLB_HistorySyncer.prototype.hasHistoryExpirationFile_ = function() {
  var file = this.getHistoryExpirationFile_();
  return file.exists();
}

/**
 * This is a legacy function for returning all history items
 * TODO: remove as soon as we are sure the built in enumerator works for us.
 */
CLB_HistorySyncer.prototype.getAllHistoryItems_ = function() {
  var currentItems = [];
  var root = this.histRdfServ_.GetResource(CLB_HistorySyncer.rootRdfStr);
  var childArc = this.histRdfServ_.GetResource(CLB_HistorySyncer.childRdfStr);
  var targets = this.histDS_.GetTargets(root, childArc, true);

  while (targets.hasMoreElements()) {
    var tar = targets.getNext();
    var tarValue = CLB_rdf.getValueFromNode(tar);
    var item = this.getUpdateItem_(root, childArc, tarValue, false);
    if (item != null) {
      currentItems[currentItems.length] = item;
    }
  }

  return currentItems;
}

/**
 * Given a history url, create a delete item for that url
 */
CLB_HistorySyncer.prototype.getHistoryDeleteItem_ = function(url) {
  var item = new CLB_SyncItem();
  this.setRequiredFields_(item, url);
  item.isRemove = true;
  return item;
}

/**
 * Given a GISyncItem, apply the changes to the local firefox datastore.
 * We have to use the history APIs to do this, since the RDF APIs have
 * not been fully implemented.
 */
CLB_HistorySyncer.prototype.addHistoryItem_ = function(item) {
  if (!isDef(item.itemID)) {
    G_Debug(this, "Warning: itemID is null, skipping!!\n");
    return;
  }

  // Create a uri out of the itemID (which is the url)
  var uri = this.ioSvc_.newURI(item.itemID, null, null);

  if (item.isRemove) {
    this.hist_.removePage(uri);
    return;
  }

  // We store first visit date, last visit date, and visit count.
  // However, there is no way to update visit count directly, so we
  // do addPageWithDetails for each history item.
  // WARNING: There's a potential performance issue here - how high
  // can visit counts get?
  // TODO: Perhaps we should add an upper limit here
  var name = item.getProperty(
    this.propertiesToCollect_.getKey(CLB_HistorySyncer.nameRdfStr));
  var firstDate = item.getProperty(
    this.propertiesToCollect_.getKey(CLB_HistorySyncer.firstDateRdfStr));
  var date = item.getProperty(
    this.propertiesToCollect_.getKey(CLB_HistorySyncer.dateRdfStr));
  var visitCount = item.getProperty(
    this.propertiesToCollect_.getKey(CLB_HistorySyncer.visitCountRdfStr));

  if (!isDef(name) || !isDef(firstDate) ||
      !isDef(date) || !isDef(visitCount)) {
    G_Debug(this, "Warning: some fields are undefined, " +
            "skipping history item");
    return;
  }

  // If this page isn't in our history yet, make sure we add the page with
  // the first visit date.
  if (!this.hist_.isVisited(uri)) {
    this.hist_.addPageWithDetails(uri, name, firstDate);
  }

  // If the recorded visit count is more than the current visit count, keep
  // adding the history item until we get to the desired visit count
  var urlNode = this.histRdfServ_.GetResource(item.itemID);
  var currentCount = this.getVisitCount_(urlNode);
  if (currentCount == 0) {
    G_Debug(this, "WARNING: failed to retrieve current visit count. " +
            "Skipping history item " + item.itemID);
    return;
  }

  while (currentCount < visitCount) {
    this.hist_.addPageWithDetails(uri, name, date);
    currentCount++;
  }

  //CLB_rdf.writeRdfToFile(this.histDS_, -1, "history_dump");
}

/**
 * Given an rdf resource corresponding to a history item, find the
 * visit count for that history item.
 */
CLB_HistorySyncer.prototype.getVisitCount_ = function(node) {
  var arc = this.histRdfServ_.GetResource(CLB_HistorySyncer.visitCountRdfStr);
  var target = this.histDS_.GetTarget(node, arc, true);
  if (!target) {
    return 0;
  }

  // target of this arc is the visit count
  var targetValue = CLB_rdf.getValueFromNode(target);
  return targetValue;
}

/**
 * Helper to see if we really want to send the results of a particular
 * assertion to the server.  We always ignore assertions with find: in
 * them because they correspond to database query and should not even be
 * there says beng.
 */
CLB_HistorySyncer.prototype.shouldUpdate_ = function(srcValue, targetValue) {
  if (srcValue.toString().startsWith("find:") ||
      targetValue.toString().startsWith("find:")) {
    return false;
  }
  return true;
}

/**
 * Given a GISyncItem to fill and an rdf resource representing the root
 * of a history item, get all attributes attached to the history item.
 * This actually isn't very much - a name, visit count, first visit date,
 * and last visit date.
 */
CLB_HistorySyncer.prototype.fillHistoryItemDetails_ = function(item, node) {
  var arcs = this.histDS_.ArcLabelsOut(node);
  while (arcs.hasMoreElements()) {
    var arc = arcs.getNext();
    var arcValue = CLB_rdf.getValueFromNode(arc);

    // Check to see if we collect this arc value or not
    if (!this.propertiesToCollect_.hasValue(arcValue)) {
      continue;
    }

    // Extract the target value
    try {
      var target = this.histDS_.GetTarget(node, arc, true);
      // Assumption: only one target
      if (target) {
        var targetValue = CLB_rdf.getValueFromNode(target);
        if (!targetValue) {
          continue;
        }

        // If the property isn't already in the item, add it
        if (!item.hasProperty(this.propertiesToCollect_.getKey(arcValue))) {
          item.setProperty(this.propertiesToCollect_.getKey(arcValue),
                           targetValue);
        }
      }
    } catch (e) {
      // Calling GetTarget on Referrer can raise an exception if the
      // referrer is blank.  Ignore the exception and treat it as an
      // empty target
    }
  }
}

/**
 * This is the main function called after we recieve a notification
 * through the nsIRDFObserver.  It takes the values in an assertion
 * and creates a GISyncItem out of it if we should report something
 * to the server.
 */
CLB_HistorySyncer.prototype.getUpdateItem_ = function(aSource, aProperty,
                                                     value, isRemove) {
  var srcValue = CLB_rdf.getValueFromNode(aSource);
  var propValue = CLB_rdf.getValueFromNode(aProperty);
  var valueNode = this.histRdfServ_.GetResource(value);

  // First check if this is the type of assertion that we record
  if (!this.shouldUpdate_(srcValue, value)) {
    return null;
  }

  // Create a new item to fill below
  var item = new CLB_SyncItem();

  // If we're adding a new history item, get all of the related assertations
  // so that we have enough information to reinsert the history item later
  if (srcValue == CLB_HistorySyncer.rootRdfStr &&
      propValue == CLB_HistorySyncer.childRdfStr) {
    this.setRequiredFields_(item, value);

    // For a deleted item, only the required fields should be set
    if (isRemove) {
      item.isRemove = true;
      return item;
    }

    // It's not a deleted item, so fill in all the other item metadata
    this.fillHistoryItemDetails_(item, valueNode);
    return item;
    
  }

  if (this.propertiesToCollect_.hasValue(propValue)) {
    
    // We'll only ever get here if onAssert/onChange was called for a date
    // or for a name.  Sanity check on isRemove
    if (isRemove) {
      G_Debug(this, "WARNING: unassert called on something other than url");
      return null;
    }

    // Fill in the rest of the history info
    this.setRequiredFields_(item, srcValue);
    this.fillHistoryItemDetails_(item, aSource);
    item.isRemove = false;
    return item;
    
  }

  G_Debug(this, "Error, cannot make update out of unexpected assertion, " +
          "returning null");
  return null;
}

/**
 * Set the itemID and componentID, both of which are required fields.
 * History doesn't have type IDs.
 */
CLB_HistorySyncer.prototype.setRequiredFields_ = function(item, url) {
  item.componentID = this.componentID;
  item.itemID = url;
}

G_debugService.loggifier.loggify(CLB_HistorySyncer.prototype);
