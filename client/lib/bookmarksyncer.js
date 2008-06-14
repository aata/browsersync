// Copyright 2005 and onwards, Google
//
// We use an RDFObserver to listen for changes to the bookmarks datastore.
// We sync folders, bookmarks, separators, and livemarks (not including
// the feed data from the livemark).  The rdf ID is used as the unique
// ID for each item, except for separators.  Separators do not flush their rdf
// ID to disk, so instead their parent and position are concatenated to
// form a unique ID.
//
// Bookmark data is synced in an order independent manner, to ensure
// that data can come out of order to another client.  Because of this,
// we need to use a "Scratch" folder to hold bookmarks that don't have
// existing parents in the rdf tree.  This is applicable in a couple
// of cases:
// 1. A child bookmark update item arrives before a parent folder update.
//    In this case the scratch folder will hold the child so that all
//    we need to do is move the child when the parent is created.
// 2. A child move update item arrives after a parent folder delete update.
//    In this case the scratch folder will hold the children of the deleted
//    folder, so that when an update for the child arrives, the bookmark
//    is found in the rdf tree.
//
// Partial updates are supported by the bookmark syncer, when possible.
// Mostly this applies to property updates (i.e. updating the name, url, etc)
//
// One important limitation that the bookmark syncer works around is
// that the bookmarksService implementation of the rdf datastore imposes
// extra limitations on top of normal rdf.  For example, API users are only
// permitted to assert certain arcs.  One example of a disallowed assertion
// is the bookmarks toolbar folder.  Thus, instead of simply asserting a
// toolbar folder arc, we need to use a special API for modifying the toolbar
// folder.
//
// Another limitation is that the bookmarksService API does not allow us to
// touch any bookmarks not attached to the main bookmark root.  This is
// especially a pain when the RdfObserver receives assertions for
// bookmarks before they are attached to the main tree.  We require access
// to the tree when recording assertions, so that we can check to be sure
// we aren't syncing Livemark children for example.  Thus, we skip assertions
// if they are not attached to the main bookmark tree yet.  Because of this
// limitation, we sync all children of an assertion that the RdfObserver
// receives.  This allows us to catch assertions that we might have missed
// previously.  An example of this is syncing all bookmarks in a folder
// when a folder position is asserted.

/*May want to consider looking for the following:
  postdata??
  livemarklock??
  livemarkexpiration??
  lastvisitdate??
  web_schedule, probably only needed for bookmarks*/

function CLB_BookmarkSyncer() {
  // TODO: private fields should be suffixed by _ per google JS style guidelines

  this.bmDS = Cc["@mozilla.org/rdf/datasource;1?name=bookmarks"]
                .getService(Ci.nsIRDFDataSource);

  this.bmRdfServ = Cc["@mozilla.org/rdf/rdf-service;1"]
                     .getService(Ci.nsIRDFService);

  this.container = Cc["@mozilla.org/rdf/container;1"]
                     .getService(Ci.nsIRDFContainer);

  this.containerUtils = Cc["@mozilla.org/rdf/container-utils;1"]
                          .getService(Ci.nsIRDFContainerUtils);

  this.bmServ = Cc["@mozilla.org/browser/bookmarks-service;1"]
                  .getService(Ci.nsIBookmarksService);
                  
  this.started_ = false;
  this.syncing_ = false;
  this.updatingSelf_ = false;

  // The RDF properties that we will collect for bookmark items, and the 
  // corresponding property names we will store them as in GISyncItem.
  // Note: For the moment, the icon data is not collected because there is
  // no easy way to add it back to the rdf datastore
  this.propertiesToCollect_ = new G_DoubleDictionary();
 
  this.propertiesToCollect_.addMultiple(
    { "title": CLB_BookmarkSyncer.nameRdfStr,
      "url": CLB_BookmarkSyncer.urlRdfStr,
      "description": CLB_BookmarkSyncer.descriptionRdfStr,
      "addDate": CLB_BookmarkSyncer.bookmarkAddDateRdfStr,
      "shortcutURL": CLB_BookmarkSyncer.shortcutRdfStr,
      "webPanel": CLB_BookmarkSyncer.showInSidebarRdfStr,
      "forwardProxy": CLB_BookmarkSyncer.forwardProxyRdfStr,
      "bookmarksToolbarFolder": CLB_BookmarkSyncer.toolbarFolder,
      "feedURL": CLB_BookmarkSyncer.feedUrlRdfStr });

  // Register conflicts with syncMan for conflict resolution during
  // syncing - order is important here, they will be resolved in the
  // order that they are registered
  CLB_syncMan.registerConflict(this, "folder",
    CLB_BookmarkSyncer.toolbarFolderConflict,
    new CLB_ArrayEnumerator(
        [this.propertiesToCollect_.getKey(CLB_BookmarkSyncer.toolbarFolder)]));

  CLB_syncMan.registerConflict(this, "folder",
    CLB_BookmarkSyncer.folderNameConflict,
    new CLB_ArrayEnumerator(
        [this.propertiesToCollect_.getKey(CLB_BookmarkSyncer.nameRdfStr)]));

  CLB_syncMan.registerConflict(this, "bookmark",
    CLB_BookmarkSyncer.urlConflict,
    new CLB_ArrayEnumerator(
        ["parents",
         this.propertiesToCollect_.getKey(CLB_BookmarkSyncer.urlRdfStr)]));

  CLB_syncMan.registerConflict(this, "livemark",
    CLB_BookmarkSyncer.livemarkUrlConflict,
    new CLB_ArrayEnumerator(
        ["parents",
         this.propertiesToCollect_.getKey(CLB_BookmarkSyncer.feedUrlRdfStr)]));
  
  CLB_syncMan.registerConflict(this, null,  // applies for all typeIDs
    CLB_BookmarkSyncer.positionConflict,
    new CLB_ArrayEnumerator(["parents", "positions"]));

  // Initialize the object that will do bookkeeping necessary for
  // conflict resolution
  this.resolver = new CLB_BookmarkResolver();

  // Used to keep track of bookmarks that don't have created parents yet
  // during the onItemAvailable calls.
  // Maps from parent rdf ID -> children array
  this.orphanChildren = {};

  // This is necessary to keep track of a toolbar folder that needs to
  // be deleted during syncing, before another toolbar folder has been set.
  // This can happen if items come out of order.  Some folder
  // must always be set to the toolbar folder, so we wait until another
  // folder has been set before deleting this one.
  this.toolbarItemToDelete = null;

  // This is so that we can clear the scratch folder before and after sync.
  CLB_syncMan.addObserver(this);

  // Used to store data during a batch update so we can determine what
  // changed after the batch update.
  this.updateBatchData_ = {};
}

CLB_BookmarkSyncer.prototype.priority = 2;
CLB_BookmarkSyncer.toolbarFolderConflict = "toolbar";
CLB_BookmarkSyncer.folderNameConflict = "folderName";
CLB_BookmarkSyncer.urlConflict = "url";
CLB_BookmarkSyncer.livemarkUrlConflict = "livemarkUrl"; 
CLB_BookmarkSyncer.positionConflict = "position";

CLB_BookmarkSyncer.rootRdfStr = "NC:BookmarksRoot";
CLB_BookmarkSyncer.oldRootRdfStr = "NC:PersonalToolbarFolder";
CLB_BookmarkSyncer.rdfPrefix = "http://home.netscape.com/NC-rdf#";
CLB_BookmarkSyncer.nameRdfStr = CLB_BookmarkSyncer.rdfPrefix + "Name";
CLB_BookmarkSyncer.urlRdfStr = CLB_BookmarkSyncer.rdfPrefix + "URL";
CLB_BookmarkSyncer.bookmarkAddDateRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "BookmarkAddDate";
CLB_BookmarkSyncer.idRdfStr = CLB_BookmarkSyncer.rdfPrefix + "ID";
CLB_BookmarkSyncer.descriptionRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "Description";
CLB_BookmarkSyncer.iconRdfStr = CLB_BookmarkSyncer.rdfPrefix + "Icon";
CLB_BookmarkSyncer.shortcutRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "ShortcutURL";
CLB_BookmarkSyncer.showInSidebarRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "WebPanel";
CLB_BookmarkSyncer.livemarkRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "Livemark";
CLB_BookmarkSyncer.feedUrlRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "FeedURL";
CLB_BookmarkSyncer.separatorRdfStr = 
  CLB_BookmarkSyncer.rdfPrefix + "BookmarkSeparator";
CLB_BookmarkSyncer.toolbarFolder =
  CLB_BookmarkSyncer.rdfPrefix + "BookmarksToolbarFolder";

CLB_BookmarkSyncer.forwardProxyRdfStr =
 "http://developer.mozilla.org/rdf/vocabulary/forward-proxy#forward-proxy";

CLB_BookmarkSyncer.webRdfPrefix = "http://home.netscape.com/WEB-rdf#";
CLB_BookmarkSyncer.lastCharsetRdfStr = 
  CLB_BookmarkSyncer.webRdfPrefix + "LastCharset";
CLB_BookmarkSyncer.lastModifiedRdfStr = 
  CLB_BookmarkSyncer.webRdfPrefix + "LastModifiedDate";

CLB_BookmarkSyncer.w3RdfPrefix = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
CLB_BookmarkSyncer.nextValRdfStr = CLB_BookmarkSyncer.w3RdfPrefix + "nextVal";

// also should have an int corresponding
// to sequence number 
CLB_BookmarkSyncer.seqRdfStr = CLB_BookmarkSyncer.w3RdfPrefix + "_";  
CLB_BookmarkSyncer.typeRdfStr = CLB_BookmarkSyncer.w3RdfPrefix + "type";
CLB_BookmarkSyncer.instanceOfRdfStr = 
  CLB_BookmarkSyncer.w3RdfPrefix + "instanceOf";
CLB_BookmarkSyncer.sequenceRdfStr = CLB_BookmarkSyncer.w3RdfPrefix + "Seq";

CLB_BookmarkSyncer.anonContentPrefix = "rdf:#$";

// We use a constant ID for this folder for now.  We could keep track of
// the current ID in a pref if this is a problem but this seems more
// straightforward and I have yet to see an rdf that is so non-random
CLB_BookmarkSyncer.scratchFolderID = "rdf:#$111111"

CLB_BookmarkSyncer.RDF_LITERAL = 0;
CLB_BookmarkSyncer.RDF_DATE_LITERAL = 1;
CLB_BookmarkSyncer.RDF_RESOURCE = 2;


CLB_BookmarkSyncer.prototype.debugZone = "CLB_BookmarkSyncer";

  
// nsISupports
CLB_BookmarkSyncer.prototype.QueryInterface = function(aIID) {
  if (!aIID.equals(Ci.nsISupports) &&
      !aIID.equals(Ci.nsIRDFObserver) &&
      !aIID.equals(Ci.GISyncComponent))
    throw Components.results.NS_ERROR_NO_INTERFACE;

  return this;
}


// GISyncObserver
CLB_BookmarkSyncer.prototype.updateStart = 
CLB_BookmarkSyncer.prototype.updateComplete =
CLB_BookmarkSyncer.prototype.updateFailure =
CLB_BookmarkSyncer.prototype.syncProgress =
CLB_BookmarkSyncer.prototype.updateProgress = function() {
  // NOP
}

CLB_BookmarkSyncer.prototype.syncStart = function() {
  this.bmServ.readBookmarks();
  G_Debug(this, "Checking for scratch folder before sync");
  this.ensureScratchFolderRemoved();
}

CLB_BookmarkSyncer.prototype.syncComplete =
CLB_BookmarkSyncer.prototype.syncFailure = function() {
  this.bmServ.readBookmarks();
  G_Debug(this, "Checking for scratch folder after sync");
  this.ensureScratchFolderRemoved();

  // Forces a rebuild of various bits of UI (such as the sidebar) after updating
  // the bookmarks datasource.
  G_Debug(this, "Refreshing bookmark UI...");
  this.updatingSelf_ = true;

  try {
    this.bmDS.beginUpdateBatch();
    this.bmDS.endUpdateBatch();
  } finally {
    this.updatingSelf_ = false;
  }
  
  G_Debug(this, "Done.");
}


// GISyncComponent
CLB_BookmarkSyncer.prototype.componentID = 
  "@google.com/browserstate/bookmark-syncer;1";
CLB_BookmarkSyncer.prototype.componentName = "Bookmarks";
CLB_BookmarkSyncer.prototype.encryptionRequred = false;
CLB_BookmarkSyncer.prototype.syncOfflineChanges = true;
CLB_BookmarkSyncer.prototype.syncBehavior =
  Ci.GISyncComponent.SYNC_SINCE_LAST_UDPATE;

/**
 * Entry point called by sync manager - indicates that we should start
 * sending bookmark changes to the sync manager.
 */
CLB_BookmarkSyncer.prototype.start = function() {
  G_Debug(this, "Starting bookmark syncer");
  
  if(!this.started_) {
    this.bmServ.readBookmarks();

    // Cleanup from bookkeeping needed during sync
    this.orphanChildren = {};
    this.resolver.clear();
    if (this.toolbarItemToDelete) {
      G_Debug(this, "Error: we should have already deleted the old toolbar " +
              " folder with itemID " + this.toolbarItemToDelete.itemID +
              "  Perhaps no other item was set to the toolbar folder");
      this.toolbarItemToDelete = null;
    }

    // Remove scratch folder if it isn't already gone
    // This handles the case when the user hits cancel on the syncing dialog
    this.ensureScratchFolderRemoved();

    // Last, add the observer and record that we are properly started
    this.bmDS.AddObserver(this);
    this.started_ = true;
  }
}

/**
 * Stops the bookmark syncer
 *
 * @see GISyncComponent#stop
 */
CLB_BookmarkSyncer.prototype.stop = function() {
  G_Debug(this, "Stopping bookmark syncer");
  
  this.bmDS.RemoveObserver(this);
  this.started_ = false;
}


CLB_BookmarkSyncer.prototype.onBeforeResolveConflict = function(item) {
  this.bmServ.readBookmarks();

  // Pass the item along to the bookmark conflict resolver - it takes
  // care of the bookkeeping necessary to resolve conflicts
  this.resolver.addDownloadedItem(item);
}

CLB_BookmarkSyncer.prototype.onItemConflict = function(conflict, oldItem,
                                                       newItem) {
  this.bmServ.readBookmarks();

  // This is for extra items we might return to resolve the conflict
  var resolvedItems;

  G_Debug(this, "Conflict detected between " + oldItem.toStringVerbose() +
          " and " + newItem.toStringVerbose());

  if (conflict == CLB_BookmarkSyncer.folderNameConflict) {
    resolvedItems = this.resolver.resolveFolderNameConflict(oldItem, newItem);
    
  } else if (conflict == CLB_BookmarkSyncer.urlConflict) {
    resolvedItems = this.resolver.resolveUrlConflict(oldItem, newItem);

  } else if (conflict == CLB_BookmarkSyncer.livemarkUrlConflict) {
    resolvedItems = this.resolver.resolveUrlConflict(oldItem, newItem);
    
  } else if (conflict == CLB_BookmarkSyncer.positionConflict) {
    resolvedItems = this.resolver.resolvePositionConflict(oldItem, newItem);

  } else if (conflict == CLB_BookmarkSyncer.toolbarFolderConflict) {
    resolvedItems = this.resolver.resolveToolbarConflict(oldItem, newItem);
  }

  G_Debug(this, "After resolving conflict, syncItem is: " +
          oldItem.toStringVerbose());
  G_Debug(this, "There are %s other resolved items.".subs(
              resolvedItems.length));
  // TODO: When we revamp debug logging, add verbose logging here to see
  // all resolved items
  return new CLB_ArrayEnumerator(resolvedItems);
}

/**
 * Entry point called by sync manager to pass along an item that should
 * be added to the existing bookmarks.
 */
CLB_BookmarkSyncer.prototype.onItemAvailable = function(item) {
  this.updatingSelf_ = true;

  try {
    this.bmServ.readBookmarks();
    this.addBookmarkItem(item);
  } finally {
    this.updatingSelf_ = false;
  }
}

CLB_BookmarkSyncer.prototype.getItemByID = function(id, typeid) {
  // First get the rdf root node for this item
  var rdfNode;
  if (typeid == "separator") {
    rdfNode = this.getSeparatorResource(id);
  } else {
    rdfNode = this.bmRdfServ.GetResource(id);
  }

  if (!rdfNode) {
    G_Debug(this, "Warning - could not retrieve resource using id " + id +
            " and typeID " + typeid);
    return null;
  }

  // Now fill in the rest of the item and return
  return this.fillBookmarkItem(rdfNode);
}

CLB_BookmarkSyncer.prototype.getCurrentItems = function() {
  this.bmServ.readBookmarks();
  var e = this.bmDS.GetAllResources();
  return new CLB_BookmarkEnumerator(e);
}

CLB_BookmarkSyncer.prototype.beforeUpdate = function() {
}

// nsIRDFObserver
/**
 * Entry point called when there is a change to the target of an assertion.
 * Unless there is a change to the item ID, we only record the new value
 * because the deletion of the old value is implicit in that case.
 */
CLB_BookmarkSyncer.prototype.onChange = 
function(aDataSource, aSource, aProperty, aOldTarget, aNewTarget) {
  if (this.updatingSelf_) {
    return;
  }

  var newValue = CLB_rdf.getValueFromNode(aNewTarget);
  if (isNull(newValue)) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  G_Debug(this, "onChange: %s %s changed to %s\n\n".subs(aSource.Value, 
             aProperty.Value, newValue));

  var items = this.getUpdateItems(aSource, aProperty, newValue, false);
  if (items) {
    items.forEach(function(item) {
      CLB_syncMan.update(item);
    });

    if (this.syncing_) {
      G_DebugL(this, "onChange detected during sync. Restarting sync.");
      CLB_syncMan.restartSync();
    }
  }
  // CLB_rdf.writeRdfToFile(this.bmDS, -1, "bookmark_dump");
}

/**
 * Entry point called upon the addition of a new assertion.  If the assertion
 * arc is an ordinal arc (meaning it points to a position in a container), then
 * this assertion indicates the addition of a new bookmark, separator,
 * or folder.  Otherwise, the assertion is probably a partial update to
 * an item.
 */
CLB_BookmarkSyncer.prototype.onAssert = 
function(aDataSource, aSource, aProperty, aTarget) {
  if (this.updatingSelf_) {
    return;
  }

  var newValue = CLB_rdf.getValueFromNode(aTarget);
  if (isNull(newValue)) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  G_Debug(this, "onAssert: %s %s %s".subs(aSource.Value, aProperty.Value, 
                newValue));

  var items = this.getUpdateItems(aSource, aProperty, newValue, false);
  if (items) {
    items.forEach(function(item) {
      CLB_syncMan.update(item);
    });

    if (this.syncing_) {
      G_DebugL(this, "onAssert detected during sync. Restarting.");
      CLB_syncMan.restartSync();
    }
  }
}

/**
 * Entry point called on the removal of an assertion.  If the assertion arc
 * is an ordinal arc (meaning it points to a position in a container), then
 * this indicates the deletion of a whole item.  Otherwise, it is probably
 * a partial deletion. Partial deletions are indicated by a null value in
 * the update item.
 */
CLB_BookmarkSyncer.prototype.onUnassert = 
function(aDataSource, aSource, aProperty, aTarget) {
  if (this.updatingSelf_) {
    return;
  }

  G_Debug(this, "onunassert: src: %s property: %s".subs(aSource.Value, 
                aProperty.Value));

  var value = CLB_rdf.getValueFromNode(aTarget);
  if (isNull(value)) {
    G_Debug(this, "Could not extract value from target, skipping");
    return;
  }

  G_Debug(this, "onUnassert: %s %s %s".subs(aSource.Value, aProperty.Value, 
                value));

  var items = this.getUpdateItems(aSource, aProperty, value, true);
  if (items) {
    items.forEach(function(item) {
      CLB_syncMan.update(item);
    });

    if (this.syncing_) {
      G_DebugL(this, "onUnassert detected during sync. Restarting.");
      CLB_syncMan.restartSync();
    }
  }
}

/**
 * Entry point callled when the source of assertion is moved.  As far as
 * I know, this is never called by the bookmarks datastore.
 */
CLB_BookmarkSyncer.prototype.onMove = 
function(aDataSource, aOldSource, aNewSource, aProperty, aTarget) {
  if (this.updatingSelf_) {
    return;
  }

  G_Debug(this, "Warning: bookmark is calling onMove!!");
  var value = CLB_rdf.getValueFromNode(aTarget);
  G_Debug(this, "onMove: %s %s %s %s".subs(aOldSource.Value, aNewSource.Value,
                aProperty.Value, value));
}

/**
 * Batch updates occur if more than 4 items have an operation performed on them
 * at once.  It also occurs during certain bookmark imports.
 *
 * A batch update also occurs when initially reading in the bookmarks file,
 * but at the point that we add the rdfobserver (in start()) we have already
 * read in the bookmarks file, so our batch update notification should never
 * be called while reading the bookmarks initially.
 *
 * Our strategy for dealing with batch updates relies on the fact that
 * every type of batch update involves inserting or deleting a
 * bookmark, potentially updating the properties as well.  Since
 * we have to do a full diff of the datastore, as an optimization
 * only diff parents and positions of bookmarks.  If we detect a
 * change to a bookmark's parent/position or a new bookmark, then record
 * all bookmark properties in case any changed.  Also record deleted
 * bookmarks.
 */
CLB_BookmarkSyncer.prototype.onBeginUpdateBatch = function(aDataSource) {
  if (this.updatingSelf_) {
    return;
  }
  
  G_Debug(this, "Bookmark component calling onBeginUpdateBatch");

  if (this.syncing_) {
    G_DebugL(this, "onBeginUpdateBatch detected during sync. Restarting.");
    CLB_syncMan.restartSync();
    return;
  }
  
  var e = this.bmDS.GetAllResources();
  while (e.hasMoreElements()) {
    var bm = e.getNext();
    
    G_Debug(this, "Attempting to add %s to updateBatchData_"
                  .subs(CLB_rdf.getValueFromNode(bm)));
    
    if (!this.shouldUpdateGivenTarget(bm)) {
      continue;
    }

    var bookmarkID = CLB_rdf.getValueFromNode(bm);

    var parent = this.bmServ.getParent(bm);
    var parentID = CLB_rdf.getValueFromNode(parent);

    var container = CLB_rdf.getInitializedContainer(this.bmDS, parent);
    var position = container.IndexOf(bm);
 
    var typeID = this.getTypeID(bm);

    this.updateBatchData_[bookmarkID] = { parentID: parentID,
                                          position: position,
                                          typeID: typeID };
  }

}

CLB_BookmarkSyncer.prototype.onEndUpdateBatch = function(aDataSource) {
  if (this.updatingSelf_) {
    return;
  }
  
  G_Debug(this, "Bookmark component calling onEndUpdateBatch");

  if (this.syncing_) {
    G_DebugL(this, "onEndUpdateBatch detected during sync. Restarting.");
    CLB_syncMan.restartSync();
    return;
  }
  
  // Enumerate all bookmarks looking for changes from before the batch
  // update and check for changes.
  var e = this.bmDS.GetAllResources();
  while (e.hasMoreElements()) {

    // Skip bookmarks that we don't care about (livemarks, bookmarks not
    // attached to the rdf tree..)
    var bm = e.getNext();
    var bookmarkID = CLB_rdf.getValueFromNode(bm);
    var batchInfo = this.updateBatchData_[bookmarkID];
    
    G_Debug(this, "Evaluating Bookmark " + bookmarkID);
    
    // when doing an updatebatch on a bunch of deleted items, *some* of
    // the deleted items will remain in GetAllResources, but without
    // isBookmarkResource, the following will skip the 'delete this.
    // updateBatchData_[bookmarkID]' step, allowing those items to
    // be deleted by the deletion loop at the end.
    if (!this.shouldUpdateGivenTarget(bm)) {
      G_Debug(this, "Shouldn't update given target, continuing.");
      continue;
    }

    // If the bookmark wasn't in the beforebatch list, then it's new, so
    // create a SyncItem for this to send to the server.
    if (!isDef(batchInfo)) {
      G_Debug(this, "New item inserted");
      var item = this.fillBookmarkItem(bm);
      CLB_syncMan.update(item);
      
      continue;
    }

    // The bookmark was in the beginupdatebatch list, so check for changes
    // to the parent and position to see if we need to record it.
    // There is no UI that allows batch updates to properties without
    // also updating position or parent, so there's no need to check
    // properties alone.
    var parent = this.bmServ.getParent(bm);
    var parentID = CLB_rdf.getValueFromNode(parent);

    var container = CLB_rdf.getInitializedContainer(this.bmDS, parent);
    var position = container.IndexOf(bm);

    if (batchInfo.parentID != parentID ||
        batchInfo.position != position) {
      G_Debug(this, "Old parentID: " + batchInfo.parentID +
              ", New parentID: " + parentID +
              ", Old position: " + batchInfo.position + 
              ", New position: " + position);
      var item = this.fillBookmarkItem(bm);
      CLB_syncMan.update(item);
    }

    // Delete the batch info from the map so that we can tell that the items
    // left in the map at the end should be deleted.
    delete this.updateBatchData_[bookmarkID];
  }

  // Anything left in the map was deleted in the batch update so send
  // delete items to the server.
  for (var bmID in this.updateBatchData_) {
    G_Debug(this, "Item deleted");
    var item =
      new CLB_SyncItem({componentID: this.componentID,
                        typeID: this.updateBatchData_[bmID].typeID,
                        itemID: bmID,
                        isRemove: true,
                        properties: { }});
    CLB_syncMan.update(item);
  }

  this.updateBatchData_ = {};
}

// private
CLB_BookmarkSyncer.prototype.getNodeFromProperty = 
function(propertyString, target) {
  if (propertyString == CLB_BookmarkSyncer.nameRdfStr ||
      propertyString == CLB_BookmarkSyncer.urlRdfStr ||
      propertyString == CLB_BookmarkSyncer.descriptionRdfStr ||
      propertyString == CLB_BookmarkSyncer.shortcutRdfStr ||
      propertyString == CLB_BookmarkSyncer.showInSidebarRdfStr ||
      propertyString == CLB_BookmarkSyncer.feedUrlRdfStr) {
    return this.bmRdfServ.GetLiteral(target);
  } else if (propertyString == CLB_BookmarkSyncer.bookmarkAddDateRdfStr) {
    return this.bmRdfServ.GetDateLiteral(target);
  } else if (propertyString == CLB_BookmarkSyncer.idRdfStr ||
             propertyString == CLB_BookmarkSyncer.forwardProxyRdfStr ||
             propertyString == CLB_BookmarkSyncer.typeRdfStr) {
    return this.bmRdfServ.GetResource(target);
  } else {
    G_Debug(this, "WARNING: addBookmark item got an unexpected assertation");
    return null;
  }
}

/**
 * Figure out if a particular resource is a source resource - older
 * bookmarks files may have different content prefixes
 * (eg NC:BoomarksRoot#$123123 vs. rdf#$123123).
 */
CLB_BookmarkSyncer.prototype.isSourceResource = function(value) {
  return value.startsWith(CLB_BookmarkSyncer.anonContentPrefix) ||
    value.startsWith(CLB_BookmarkSyncer.rootRdfStr + "#$") ||
    value.startsWith(CLB_BookmarkSyncer.oldRootRdfStr);
}

/**
 * Convenience function to determine whether or not we should record
 * changes to the given resource.  Finds the source and arc and then uses
 * the shouldUpdate function below to determine whether this is a
 * livemark, etc.
 */
CLB_BookmarkSyncer.prototype.shouldUpdateGivenTarget = function(bookmarkTarget) {
  if (!(bookmarkTarget instanceof Ci.nsIRDFResource)) {
    G_Debug(this, "Failed to cast a resource to nsIRDFResource");
    return false;
  }
  if (!this.bmServ.isBookmarkedResource(bookmarkTarget)) {
    G_Debug(this, "Shouldn't update: failed isBookmarkedResource check.");
    return false;
  }

  // Get the parent arc so we can run it through our filter.  This
  // protects against collecting livemark children, etc.
  var arcs = this.bmDS.ArcLabelsIn(bookmarkTarget);
  if (!arcs.hasMoreElements()) {
    G_Debug(this, "Shouldn't update: failed arcs.hasMoreElements check.");
    return false;
  }

  // Do a sanity check that the arc pointing at this resource is an
  // ordinal property (i.e. a position in a list).  No other type of
  // arc (apart from the ID) should point to a valid bookmark/folder/
  // separator
  var positionArc;
  var foundPositionArc = false;
  
  while (arcs.hasMoreElements()) {
    var positionArc = arcs.getNext();
    if (this.containerUtils.IsOrdinalProperty(positionArc)) {
      foundPositionArc = true;
      break;
    }
  }
  
  if (!foundPositionArc) {
    G_Debug(this, "Shouldn't update: failed isOrdinalProperty check.");
    return false;
  }
  
  // Retrieve the parent of this bookmark - we can assume there is only
  // one because a bookmark/folder/separator is only allowed to have one
  // position in the bookmark tree.
  var srcs = this.bmDS.GetSources(positionArc, bookmarkTarget, true);
  if (!srcs.hasMoreElements()) {
    G_Debug(this, "Shouldn't update: failed !srcs.hasMoreElements check.");
    return false;
  }
  var parent = srcs.getNext();

  if (!this.shouldUpdate(parent, positionArc)) {
    G_Debug(this, "Shouldn't update because parent failed shouldUpdate check.");
    return false;
  }

  return true;
}

/**
 * This weeds out items that we don't want to sync to the clobber server.
 * For example, we don't want to sync data not connected to the main
 * bookmarks rdf since we can't tell whether or not it's a livemark child
 * yet.  Also, we only want to sync the main livemark item, not the child
 * feed data.
 */
CLB_BookmarkSyncer.prototype.shouldUpdate = function(aSource, aProperty) {
  // If aSource is the livemark itself, as opposed to the children
  // bookmark elements, then it will have an arc identifying it as
  // a livemark
  var typeArc = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.typeRdfStr);
  var livemarkTarget = 
    this.bmRdfServ.GetResource(CLB_BookmarkSyncer.livemarkRdfStr);

  if (this.bmDS.HasAssertion(aSource, typeArc, livemarkTarget, true)) {
    // if this is a livemark, only collect the usual properties, not any
    // child bookmarks, since the children will change every time the
    // livemark is reloaded
    var prop = CLB_rdf.getValueFromNode(aProperty);
    if (this.propertiesToCollect_.hasValue(prop)) {
      return true;
    } else {
      G_Debug(this, "skipping livemark");
      return false;
    }
  }

  // If it's not really part of the rdf datastore yet (meaning its parent
  // chain does not extend to the bookmarks datastore), then skip it for now.
  // We'll get this update when its parent is attached to the rdf datastore,
  // since we recursively get all children after an assert.  The reason
  // why we skip it now is because we can't tell if it's a livemark child
  var arcs = this.bmDS.ArcLabelsIn(aSource);
  if (!arcs.hasMoreElements()) {
    G_Debug(this, "Skipping assertation not in the rdf tree");
    return false;
  }

  // Assumption: livemark bookmarks are only one level under the parent
  // livemark folder
  while (arcs.hasMoreElements()) {
    var arc = arcs.getNext();
    var srcs = this.bmDS.GetSources(arc, aSource, true);
    while (srcs.hasMoreElements()) {
      var src = srcs.getNext();
      if (this.bmDS.HasAssertion(src, typeArc, livemarkTarget, true)) {
        G_Debug(this, "skipping livemark");
        return false;
      }
    }
  }

  return true;
}

CLB_BookmarkSyncer.prototype.parsePositionFromProperty = function(aProperty) {
  var val = CLB_rdf.getValueFromNode(aProperty);
  val = val.replace(CLB_BookmarkSyncer.seqRdfStr, "");
  return parseInt(val);
}

CLB_BookmarkSyncer.prototype.getPropertyFromPosition = function(position) {
  return CLB_BookmarkSyncer.seqRdfStr + position;
}

CLB_BookmarkSyncer.prototype.getAllChildProperties = function(aSource, item) {
  var arcs = this.bmDS.ArcLabelsOut(aSource);
  while (arcs.hasMoreElements()) {
    var arc = arcs.getNext();
    var arcValue = CLB_rdf.getValueFromNode(arc);
    if (!this.propertiesToCollect_.hasValue(arcValue)) {
      continue;
    }
    var targets = this.bmDS.GetTargets(aSource, arc, true);
    // Assumption: only one target
    if (targets.hasMoreElements()) {
      var targetValue = CLB_rdf.getValueFromNode(targets.getNext());
      var itemArcValue = this.propertiesToCollect_.getKey(arcValue);
      if (!item.hasProperty(itemArcValue)) {
        item.setProperty(itemArcValue, targetValue);
      }
    }
  }
}

CLB_BookmarkSyncer.prototype.removeAllChildProperties = function(aSource, url) {
  // Treat livemarks specially.  Unasserting the livemark type will have
  // the effect of deleting all the livemark bookmarks as well
  if (this.isLivemark(aSource)) {
    this.removeLivemarkType(aSource);
  }

  // First make a copy of all arcs, because the iterator gets confused
  // when you start deleting assertations.
  var allArcs = [];
  var shouldDeleteIcon = false;
  var arcs = this.bmDS.ArcLabelsOut(aSource);
  while (arcs.hasMoreElements()) {
    var arc = arcs.getNext();
    var arcVal = CLB_rdf.getValueFromNode(arc);
    if (arcVal == CLB_BookmarkSyncer.iconRdfStr) {
      // We can only delete the icon if we have a valid url for doing so.
      // Otherwise, we're going to have to let it sit in memory until
      // bookmarks are flushed to disk
      if (url != null && url != "") {
        shouldDeleteIcon = true;
      }
    } else {
      allArcs[allArcs.length] = arc;
    }
  }

  // Remove the icon here because it needs to be deleted before the url
  // is unasserted.
  if (shouldDeleteIcon) {
    G_Debug(this, "About to delete icon with url %s".subs(url));
    this.bmServ.removeBookmarkIcon(url);
  }

  // Recursively remove this target's children
  // depth first, so that we don't try to unassert an arc no longer
  // attached to the tree
  for (var i = 0; i < allArcs.length; i++) {
    var arc = allArcs[i];
    var arcValue = CLB_rdf.getValueFromNode(arc);
    var tar = this.bmDS.GetTarget(aSource, arc, true);
    // Sometimes by the time we get to unasserting a target, it has already
    // been removed as a side effect of a different unassert
    if (isNull(tar)) {
      continue;
    }
    // Recurse, but make sure we don't loop infinitely
    if (arcValue != CLB_BookmarkSyncer.idRdfStr &&
        tar instanceof Ci.nsIRDFResource) {
      var newUrl = this.getBookmarkUrl(tar);
      this.removeAllChildProperties(tar, newUrl);
    }

    // Delete the current assertation
    var srcVal = CLB_rdf.getValueFromNode(aSource);
    arcVal = CLB_rdf.getValueFromNode(arc);
    var tarVal = CLB_rdf.getValueFromNode(tar);
    G_Debug(this, "About to unassert %s, %s, %s".subs(srcVal, arcVal, tarVal));
    this.bmDS.Unassert(aSource, arc, tar);
  }
}

CLB_BookmarkSyncer.prototype.getDeletedFolderContents = function(node, items) {
  if (this.isFolder(node)) {
    this.container.Init(this.bmDS, node);
    var bookmarks = this.container.GetElements();
    while (bookmarks.hasMoreElements()) {
      var bm = bookmarks.getNext();
      // Make sure to go depth first so we delete bookmarks in the proper
      // order (i.e. it's still attached to the bookmark tree when we
      // attempt to delete it)
      if (this.isFolder(bm)) {
        this.getDeletedFolderContents(bm, items);
      }
      var item = this.setRequiredFields(bm);
      item.isRemove = true;
      items[items.length] = item;
    }
  }
}

CLB_BookmarkSyncer.prototype.removeLivemarkType = function(node) {
  var t = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.typeRdfStr);
  var lm = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.livemarkRdfStr);
  return this.bmDS.Unassert(node, t, lm, true);
}

CLB_BookmarkSyncer.prototype.isFolder = function(node) {
  return this.containerUtils.IsSeq(this.bmDS, node);
}

CLB_BookmarkSyncer.prototype.isLivemark = function(node) {
  var t = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.typeRdfStr);
  var lm = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.livemarkRdfStr);
  return this.bmDS.HasAssertion(node, t, lm, true);
}

CLB_BookmarkSyncer.prototype.isSeparator = function(node) {
  var t = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.typeRdfStr);
  var s = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.separatorRdfStr);
  return this.bmDS.HasAssertion(node, t, s, true);
}

CLB_BookmarkSyncer.prototype.setTypeID = function(node, item) {
  item.typeID = this.getTypeID(node);
}

CLB_BookmarkSyncer.prototype.getTypeID = function(node) {
  if (this.isLivemark(node)) {
    return "livemark";
  } else if (this.isSeparator(node)) {
    return "separator";
  } else if (this.isFolder(node)) {
    return "folder";
  } else {
    return "bookmark";
  }
}

CLB_BookmarkSyncer.prototype.setItemID = function(node, item,
                                                  opt_parent, opt_pos) {
  // We have to special case separators - since their rdf ID changes
  // every time we restart the browser, make their ID be position+container
  if (this.isSeparator(node)) {
    // Hack alert: opt_parent and opt_pos are only necessary when deleting
    // a separator. The separator ID consists of parent and position,
    // but at the time that we are reporting a deletion, the separator no
    // longer exists in the rdf, so we need to take the info from
    // the unassert notification.
    var parentNode, position;
    if (isDef(opt_parent)) {
      if (!isDef(opt_pos)) {
        throw new Error("Both parent and position should be specified");
      }

      parentNode = opt_parent;
      position = this.parsePositionFromProperty(opt_pos);

      if (isNaN(position)) {
        throw new Error("Incorrectly formatted ordinal node");
      }
    } else {
      parentNode = this.bmServ.getParent(node);
      this.container.Init(this.bmDS, parentNode);
      position = this.container.IndexOf(node);
    }

    var parentValue = CLB_rdf.getValueFromNode(parentNode);
    item.itemID = this.createSeparatorID(parentValue, position);
  } else {
    var value = CLB_rdf.getValueFromNode(node);
    item.itemID = value;
  }
}

CLB_BookmarkSyncer.prototype.createSeparatorID = function(parent, position) {
  return parent + "," + position;
}

CLB_BookmarkSyncer.prototype.annotateType = function(type, node) {
  // TODO: as is, the type is already stored as an assertation - should
  // we get rid of that?
  var t = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.typeRdfStr);
  if (type == "folder") {
    this.containerUtils.MakeSeq(this.bmDS, node);
  } else if (type == "livemark") {
    var lm = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.livemarkRdfStr);
    this.bmDS.Assert(node, t, lm, true);
  } else if (type == "separator") {
    var s = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.separatorRdfStr);
    this.bmDS.Assert(node, t, s, true);
  }
}

CLB_BookmarkSyncer.prototype.setRequiredFields = function(node, opt_parent,
                                                          opt_pos) {
  var item = new CLB_SyncItem({ componentID: this.componentID });
  this.setTypeID(node, item);

  this.setItemID(node, item, opt_parent, opt_pos);

  return item;
}

// TODO: figure out how to combine this with getUpdateItems code
CLB_BookmarkSyncer.prototype.fillBookmarkItem = function(bmNode) {
  var item = this.setRequiredFields(bmNode);
  this.setContainerInfo(item, bmNode);
  this.getAllChildProperties(bmNode, item);
  return item;
}

/**
 * Given a source node, arc, and value, create update items to send to the
 * clobber server.  If the arc is a position value, then we sync all the
 * data in the new folder or bookmark.  Otherwise, we only do a partial
 * update.  If isRemove is true, this a deletion.
 */
CLB_BookmarkSyncer.prototype.getUpdateItems = 
function(aSource, aProperty, value, isRemove) {
  if (!this.shouldUpdate(aSource, aProperty)) {
    G_Debug(this, "Skipping update...");
    return null;
  }

  var valueNode = this.bmRdfServ.GetResource(value);
  var item;
  // If we're adding a new bookmark, we need to keep track of position
  // and container info, in addition to the required fields
  if (this.isSourceResource(value.toString())) {
    item = this.setRequiredFields(valueNode, aSource, aProperty);

    // If this is a delete request, only the componentID, itemID, and typeID
    // should be set
    if (isRemove) {
      item.isRemove = isRemove;
      var otherItems = [];
      this.getDeletedFolderContents(valueNode, otherItems);
      otherItems[otherItems.length] = item;
      return otherItems;
    }

    if (!this.setContainerInfo(item, valueNode)) {
      G_Debug(this, "Problem setting parent and position info. Perhaps " +
                    "the node {%s} is not attached to the rdf " +
                    "tree".subs(valueNode));
      return null;
    }

    // Now find all of the properties associated with this bookmark
    this.getAllChildProperties(valueNode, item);

    // This is a hack for folders - we need to make sure to always get the
    // contents of folders to prevent the contents from being deleted
    var childItems = this.getAllChildItems(valueNode);
    childItems[childItems.length] = item;
    return childItems;
  } else if (this.isSourceResource(aSource.Value)) {
    if (!this.propertiesToCollect_.hasValue(aProperty.Value)) {
      G_Debug(this, "Skipping update to non-recorded property {%s}"
                    .subs(aProperty.Value));
      return null;
    }

    item = this.setRequiredFields(aSource);

    // This is a partial update, so technically we don't need the container
    // info.  However, to prevent potential issues if a partial update and
    // full update come out of order in a full download, include the container
    // info anyway
    this.setContainerInfo(item, aSource);

    var itemPropertyValue = this.propertiesToCollect_.getKey(aProperty.Value);

    if (isRemove) {
      item.setProperty(itemPropertyValue, null);
    } else {
      item.setProperty(itemPropertyValue, value);
    }

    item.isRemove = false;

    G_Debug(this, "Updating for %s".subs(aProperty.Value));
    G_Debug(this, "source: %s".subs(aSource.Value));
    G_Debug(this, "value: %s".subs(value));
    G_Debug(this, "Item ID is %s\n".subs(item.itemID));

    return [item];
  } else {
    return null;
  }
}

CLB_BookmarkSyncer.prototype.setContainerInfo = function(item, bmNode) {
  G_Debug(this, "getting parent for node %s".subs(bmNode.Value));
  var parent = this.bmServ.getParent(bmNode);
  if (!parent) {
    return false;
  }

  this.container.Init(this.bmDS, parent);
  var position = this.container.IndexOf(bmNode);
  var parValue = CLB_rdf.getValueFromNode(parent);

  G_Debug(this, "setting parents: " + parValue + "\n");
  G_Debug(this, "setting positions: " + position + "\n");

  item.setProperty("parents", parValue);
  item.setProperty("positions", position);
  return true;
}

CLB_BookmarkSyncer.prototype.getAllChildItems = function(src) {
  var currentItems = [];
  var outArcs = this.bmDS.ArcLabelsOut(src);
  while (outArcs.hasMoreElements()) {
    var arc = outArcs.getNext();
    var pos = this.parsePositionFromProperty(arc);
    // Skip arcs that don't point to a position in a folder
    if (isNaN(pos)) {
      continue;
    }
    if (!this.shouldUpdate(src, arc)) {
      continue;
    }
    // Assumption: Only one target for each position
    var tar = this.bmDS.GetTarget(src, arc, true);
    if (tar) {
      var item = this.fillBookmarkItem(tar);
      if (item != null) {
        currentItems[currentItems.length] = item;
      }
      // Recurse on this target if it is a resource
      if (tar instanceof Ci.nsIRDFResource) {
        currentItems = currentItems.concat(this.getAllChildItems(tar));
      }
    }
  }
  return currentItems;
}

CLB_BookmarkSyncer.prototype.getContainerFromSeparatorID = function(id) {
  var idComponents = id.split(",");
  if (idComponents.length != 2) {
    G_Debug(this, "WARNING: separator ID incorrectly formatted: " + id);
    return null;
  }
  return idComponents[0];
}

CLB_BookmarkSyncer.prototype.getPositionFromSeparatorID = function(id) {
  var idComponents = id.split(",");
  if (idComponents.length != 2) {
    G_Debug(this, "WARNING: separator ID incorrectly formatted: " + id);
    return null;
  }
  return idComponents[1];
}

CLB_BookmarkSyncer.prototype.isToolbarFolder = function(folderValue) {
  var toolbarNode = this.bmServ.getBookmarksToolbarFolder();
  if (CLB_rdf.getValueFromNode(toolbarNode) == folderValue) {
    return true;
  }
  return false;
}

CLB_BookmarkSyncer.prototype.maybeDeleteOldToolbarFolder = function() {
  if (!this.toolbarItemToDelete) {
    return;
  }
  
  if (this.isToolbarFolder(this.toolbarItemToDelete.itemID)) {
    return;
  }

  this.handleDeleteItem(this.toolbarItemToDelete);
  this.toolbarItemToDelete = null;
}

CLB_BookmarkSyncer.prototype.handleDeleteItem = function(item) {
  var contRes, position;
  if (item.typeID == "separator") {
    // Extract the container from the id - if the id is badly formatted
    // then we could get null here
    var cont = this.getContainerFromSeparatorID(item.itemID);
    position = this.getPositionFromSeparatorID(item.itemID);
    if (isNull(cont) || isNull(position)) {
      G_Debug(this, "Error: skipping delete of separator with malformed id"); 
      return;
    }

    // Be sure to check that the parent exists before trying to delete
    // the separator.
    contRes = this.bmRdfServ.GetResource(cont);
    if (!this.bmServ.isBookmarkedResource(contRes)) {
      G_Debug(this, "Warning: trying to delete a separator that doesn't " +
              " exist");
      return;
    }
    this.container.Init(this.bmDS, contRes);

    var positionProp = this.bmRdfServ.GetResource(
      this.getPropertyFromPosition(position));

    var sep =  this.bmDS.GetTarget(contRes, positionProp, true);
    if (sep && this.isSeparator(sep)) {
      G_Debug(this, "Found and deleting separator at position " + position);
      this.container.RemoveElement(sep, false);
    }
  } else {

    // The delete is either a bookmark or a folder.

    // Do a sanity check that this is actually a bookmark in our tree.
    var srcRes = this.bmRdfServ.GetResource(item.itemID);
    if (!this.bmServ.isBookmarkedResource(srcRes)) {
      return;
    }

    contRes = this.bmServ.getParent(srcRes);
    if (!contRes) {
      G_Debug(this, "Warning: trying to delete an element that doesn't exist");
      return;
    }

    // Special case for bookmark toolbar folder - we can't clear it until
    // another toolbar folder has been set.  keep track of this item so
    // we can clear it later
    if (item.typeID == "folder" && this.isToolbarFolder(item.itemID)) {
      if (this.toolbarItemToDelete) {
        G_Debug(this, "Error: we should never have 2 toolbar " +
                "folders to delete!  itemIDs are " +
                this.toolbarItemToDelete.itemID + " and " +
                item.itemID);
      }
      
      this.toolbarItemToDelete = item;
      return;
    }

    // If this is a folder, rescue any child bookmarks and put them
    // in the scratch folder.  This is in case we have a folder delete
    // and bookmark move coming to the client out of order.  As long as
    // the folder children are in the bookmarks tree somewhere, the
    // move code will work as expected.
    if (item.typeID == "folder") {
      this.rescueFolderChildren(srcRes);
    }

    // Actually delete the bookmark
    this.container.Init(this.bmDS, contRes);
    position = this.container.IndexOf(srcRes);
    var url = this.getBookmarkUrl(srcRes);
    this.removeAllChildProperties(srcRes, url);
    this.container.RemoveElement(srcRes, false);
    this.maybeDecrementNextVal(contRes, position);
  }

  G_Debug(this, "Just deleted item with container " +
                CLB_rdf.getValueFromNode(contRes) + " and position " +
                position);
}

CLB_BookmarkSyncer.prototype.getSeparatorResource = function(itemID) {
  var position = this.getPositionFromSeparatorID(itemID);
  var container = this.getContainerFromSeparatorID(itemID);
  if (isNull(position) || isNull(container)) {
    return null;
  }
  var positionRes = this.bmRdfServ.GetResource(
    this.getPropertyFromPosition(position));
  var containerRes = this.bmRdfServ.GetResource(container);

  var oldSep = this.bmDS.GetTarget(containerRes, positionRes, true);
  if (!isNull(oldSep) && this.isSeparator(oldSep)) {
    return oldSep;
  } else {
    return this.bmRdfServ.GetAnonymousResource();
  }
}

CLB_BookmarkSyncer.prototype.addBookmarkItem = function(item) {
  G_Debug(this, "About to add bookmark with syncitem: " +
          item.toStringVerbose());
  if (!isDef(item.itemID)) {
    G_DebugL(this, "Warning: itemID is null, skipping!!\n");
    return;
  }

  if (item.itemID == CLB_BookmarkSyncer.rootRdfStr) {
    // Users of older versions may have some bad data in their accounts,
    // so let's just skip over it.
    G_DebugL(this, "ERROR: Bookmarks Root item encountered, skipping");
    return;
  }

  if (item.isRemove) {
    this.handleDeleteItem(item);
    return;
  }

  var srcRes;
  if (item.typeID == "separator") {
    srcRes = this.getSeparatorResource(item.itemID);
  } else {
    srcRes = this.bmRdfServ.GetResource(item.itemID);
  }
  var target, tarRes, propRes;

  if (item.hasProperty("positions")) {
    if (!item.hasProperty("parents")) {
      G_Debug(this, "Update item has position but not parents! skipping...");
      return;
    }

    var parent = this.getParent(item);
    var position = this.getPosition(item);
    var contRes = this.bmRdfServ.GetResource(parent);

    if (!this.bmServ.isBookmarkedResource(contRes)) {
      this.recordOrphanChild(parent, CLB_rdf.getValueFromNode(srcRes),
                             position);
            
      contRes = this.getScratchFolder(true /* insert if necessary */);
      this.container.Init(this.bmDS, contRes);

      position = parseInt(this.container.GetCount() + 1);
      parent = CLB_rdf.getValueFromNode(contRes);
    }

    // TODO: fix this up and pull out to a separate function
    this.container.Init(this.bmDS, contRes);
    // Checks if this rdf resource has a parent chain that extends to the
    // root bookmark node
    var isBookmarked = this.bmServ.isBookmarkedResource(srcRes);
    if (isBookmarked) {
      this.maybeMoveBookmark(srcRes, parent, position, item.typeID);
    } else {
      this.insertBookmark(contRes, srcRes, position, item.typeID);
    }
  }

  // Special-case the ID field since it doesn't get stored as a property.
  // Note that we have to get the rdf ID out of the rdf resource, since
  // item.itemID is not a rdf ID for separators.
  this.maybeAssert(
    srcRes,
    this.bmRdfServ.GetResource(CLB_BookmarkSyncer.idRdfStr),
    this.getNodeFromProperty(CLB_BookmarkSyncer.idRdfStr,
                             CLB_rdf.getValueFromNode(srcRes)));

  item.getPropertyNames().forEach(function(prop) {
    // avoid adding the same prop twice
    if (prop == "positions" ||
        prop == "parents") {
      return;
    }

    target = item.getProperty(prop);

    if (!this.propertiesToCollect_.hasKey(prop)) {
      G_Debug(this, "Item contains property " + prop +
              " that does not correspond to an rdf property");
    } else {
      var rdfProp = this.propertiesToCollect_.getValue(prop);
      
      // Special case toolbar folder.  Since we aren't permitted to assert
      // the toolbar folder property, we need to use the bookmarksservice
      // interface instead.  You can only set something to be the toolbar
      // folder, not delete it, so if the value isn't true then do nothing.
      // Any existing toolbar folder property is deleted when a new one
      // is set.
      if (rdfProp == CLB_BookmarkSyncer.toolbarFolder) {
        if (target != "true") {
          G_DebugL(this,
                   "Skipping unexpected target for toolbarFolder: " + target);
          return;
        }

        this.bmServ.setBookmarksToolbarFolder(srcRes);
      }

      propRes = this.bmRdfServ.GetResource(rdfProp);
    
      if (isNull(target)) {
        this.unassertTargets(srcRes, propRes);
      } else if (target == "") {
        // TODO: is this the right thing to do?
        G_Debug(this, "Skipping target with value empty string");
      } else {
        tarRes = this.getNodeFromProperty(rdfProp, target);
        if (isNull(tarRes)) {
          return;
        }
        this.maybeAssert(srcRes, propRes, tarRes);
      }
    }
  }, this);

  this.maybeMoveOrphanChildren(srcRes);
  this.maybeDeleteOldToolbarFolder();
  //CLB_rdf.writeRdfToFile(this.bmDS, -1, "bookmark_dump");
};

CLB_BookmarkSyncer.prototype.maybeMoveOrphanChildren = function(parentRes) {
  var parent = CLB_rdf.getValueFromNode(parentRes);
  if (!parent) {
    G_Debug(this, "Failed to extract rdf value from parent node - this " +
            "should never happen");
  }

  var children = this.orphanChildren[parent];
  if (!isDef(children)) {
    // No children, nothing to do
    return;
  }

  children.forEach(function(childObj) {
    var node = this.bmRdfServ.GetResource(childObj.child);
    if (!node) {
      G_Debug(this, "Could not create a resource from child " +
              childObj.child);
    } else {
      this.maybeMoveBookmark(node, parent, childObj.position);
    }
  }, this);

  // If we don't have anything left in the scratch folder, get rid of it
  this.maybeRemoveScratchFolder();
}

CLB_BookmarkSyncer.prototype.recordOrphanChild = function(parent, child,
                                                          position) {
  var children = this.orphanChildren[parent];
  var childObj = { child: child,
                   position: position };
  if (isDef(children)) {
    children.push(childObj);
  } else {
    this.orphanChildren[parent] = [childObj];
  }
}

CLB_BookmarkSyncer.prototype.rescueFolderChildren = function(folderResource) {
  if (!this.isFolder(folderResource)) {
    G_Debug(this, "Error: trying to rescue children for an item that is not " +
            " a folder, skipping");
    return;
  }

  G_Debug(this, "Moving folder children to the scratch folder");

  // This is the folder we're going to put the children into.
  var scratchFolder = this.getScratchFolder(true /* insert if necessary */);

  // Retrieve all children and move them to the new folder.  Note that the
  // children could be folders or bookmarks.  Ditch separators
  // though, since they are uniquely identified by a parent and position
  // value.
  var container = CLB_rdf.getInitializedContainer(this.bmDS, folderResource);
  var children = container.GetElements();
  while (children.hasMoreElements()) {
    var childResource = children.getNext();

    if (this.isSeparator(childResource)) {
      G_Debug(this, "Skipping moving separator to the scratch folder");
      continue;
    }

    // We'll take the next open position in the scratch folder.
    var scratchFolderPosition = CLB_rdf.getContainerCount(this.bmDS,
                                                          scratchFolder) + 1;
    this.maybeMoveBookmark(childResource, CLB_BookmarkSyncer.scratchFolderID,
                           scratchFolderPosition);
  }
}

CLB_BookmarkSyncer.prototype.getScratchFolder = function(maybeInsert) {
  // Note that we add this folder at position 1, regardless of whether
  // there is something already there.  This should be fine, as long
  // as we don't renumber the folder contents automatically.
  if (!this.scratchFolder) {
    this.scratchFolder =
      this.bmRdfServ.GetResource(CLB_BookmarkSyncer.scratchFolderID);

    if (!this.bmServ.isBookmarkedResource(this.scratchFolder)) {
      // if maybeInsert is true, insert the scratch folder if it isn't already
      // inserted
      if (maybeInsert) {
        G_Debug(this, "Initializing scratch folder");
        this.container.Init(this.bmDS,
                   this.bmRdfServ.GetResource(CLB_BookmarkSyncer.rootRdfStr));
        this.container.InsertElementAt(this.scratchFolder, 1,
                                       false); //Don't renumber everything

        // Must annotate the type after inserting, or it will throw an error
        this.annotateType("folder", this.scratchFolder);

      } else {
        // If maybeInsert is false, return null when it isn't already inserted
        this.scratchFolder = null;
      }
    }
  }

  return this.scratchFolder;
}

CLB_BookmarkSyncer.prototype.maybeRemoveScratchFolder = function() {
  if (!this.scratchFolder) {
    return;
  }

  this.container.Init(this.bmDS, this.scratchFolder);
  G_Debug(this, "Scratch folder count: " + this.container.GetCount());
  if (this.container.GetCount() == 0) {
    this.removeScratchFolder();
  }
}

CLB_BookmarkSyncer.prototype.removeScratchFolder = function() {
  this.container.Init(this.bmDS,
                   this.bmRdfServ.GetResource(CLB_BookmarkSyncer.rootRdfStr));

  this.updatingSelf_ = true;

  try {
    this.container.RemoveElement(this.scratchFolder,
                                 false);  // Don't renumber everything
  } finally {
    this.updatingSelf_ = false;
  }
    
  // Be sure to set it back to something invalid again so that the
  // folder gets reinitialized if necessary
  this.scratchFolder = null;  
}

CLB_BookmarkSyncer.prototype.ensureScratchFolderRemoved = function() {
  this.getScratchFolder(false /* if not inserted already don't insert */);
  if (!this.scratchFolder) {
    return;
  }

  G_Debug(this, "Scratch folder found, deleting folder and contents");
  this.container.Init(this.bmDS, this.scratchFolder);
    
  var bms = this.container.GetElements();
  while(bms.hasMoreElements()) {
    var bm = bms.getNext();
    G_Debug(this, "Deleting " + CLB_rdf.getValueFromNode(bm) +
            " from scratch folder");

    // Actually delete the bookmark
    this.removeBookmark(this.scratchFolder, bm);
  }
    
  // Verify that the count is 0 - if not it's a bug
  if (this.container.GetCount() != 0) {
    G_Debug(this,
            "Error: Count is still not 0 after removing every element");
  }
  this.removeScratchFolder();
}

CLB_BookmarkSyncer.prototype.insertBookmark = 
 function(parentRes, bookmarkRes, position, opt_type) {
  this.maybeIncrementNextVal(parentRes, position);
  this.container.Init(this.bmDS, parentRes);
  this.container.InsertElementAt(bookmarkRes, position,
                                 false);  // Don't renumber everything
  if (isDef(opt_type)) {
    this.annotateType(opt_type, bookmarkRes);
  }
}

CLB_BookmarkSyncer.prototype.removeBookmark = 
function(parentRes, bookmarkRes) {
  this.container.Init(this.bmDS, parentRes);
  var position = this.container.IndexOf(bookmarkRes);
  this.container.RemoveElement(bookmarkRes, false);
  this.maybeDecrementNextVal(parentRes, position);
}

// Note that we only record the immediate parent now, instead of the
// whole parent tree.  Thus, we no longer need to parse the parents value.
CLB_BookmarkSyncer.prototype.getParent = function(item) {
  return item.getProperty("parents");
}

// Note that we only record the position of this item within its parent
// folder now, instead of the chain of positions all the way up the parent
// tree.  Thus we no longer need to parse the positions value.
CLB_BookmarkSyncer.prototype.getPosition = function(item) {
  return item.getProperty("positions");
}

CLB_BookmarkSyncer.prototype.getBookmarkUrl = function(node) {
  var urlProp = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.urlRdfStr);
  var tar = this.bmDS.GetTarget(node, urlProp, true);
  if (tar) {
    return CLB_rdf.getValueFromNode(tar);
  } else {
    return null;
  }
}

CLB_BookmarkSyncer.prototype.maybeIncrementNextVal = 
function(containerRes, position) {
  var prop = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.nextValRdfStr);
  var oldTar = this.bmDS.GetTarget(containerRes, prop, true);
  var count = CLB_rdf.getValueFromNode(oldTar);

  if (parseInt(count) <= parseInt(position)) {
    var tar = this.bmRdfServ.GetLiteral(parseInt(position) + 1);
    G_Debug(this, "Just changed from nextVal: %s to: %s".subs(count, 
                  tar.Value));
    this.bmDS.Change(containerRes, prop, oldTar, tar);
    // CLB_rdf.writeRdfToFile(this.bmDS, -1, "bookmark_dump");
  }
}

CLB_BookmarkSyncer.prototype.maybeDecrementNextVal = 
function(containerRes, position) {
  var prop = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.nextValRdfStr);
  var oldTar = this.bmDS.GetTarget(containerRes, prop, true);
  var count = CLB_rdf.getValueFromNode(oldTar);
  // Only change nextVal if we removed the last resource in the list.
  // Otherwise we are just be creating a hole to insert a different
  // resource
  if (parseInt(count) == parseInt(position) + 1) {
    // Find the new nextVal based on the index of the maximum remaining
    // element in this container
    var tar = this.bmRdfServ.GetLiteral(this.getNewNextVal(containerRes));
    G_Debug(this, "Just changed from nextVal: %s to: %s".subs(count, 
                  tar.Value));
    this.bmDS.Change(containerRes, prop, oldTar, tar);
  }
}

CLB_BookmarkSyncer.prototype.setNewNextVal = function(containerRes) {
  // Compute what the new nextval should be, based on the max existing
  // position in the folder.
  var arc = this.bmRdfServ.GetResource(CLB_BookmarkSyncer.nextValRdfStr);
  var pos = this.getNewNextVal(containerRes);

  // Find the old value and create a resource from the new value.
  var oldTar = this.bmDS.GetTarget(containerRes, arc, true);
  var tar = this.bmRdfServ.GetLiteral(pos);

  // Now update the old value
  this.bmDS.Change(containerRes, arc, oldTar, tar);
}

CLB_BookmarkSyncer.prototype.getNewNextVal = function(containerRes) {
  var arcs = this.bmDS.ArcLabelsOut(containerRes);
  var currentMax = 0;
  while (arcs.hasMoreElements()) {
    var arc = arcs.getNext();
    var pos = this.parsePositionFromProperty(arc);
    if (isNaN(pos)) {
      continue;
    } else if (parseInt(pos) > currentMax) {
      currentMax = parseInt(pos);
    }
  }
  return parseInt(currentMax) + 1
}

// Assumption: we know the bookmark already exists when this function is called
CLB_BookmarkSyncer.prototype.maybeMoveBookmark = 
function(node, containerID, position, opt_type) {
  var parentRes = this.bmRdfServ.GetResource(containerID);
  var posRes = 
    this.bmRdfServ.GetResource(this.getPropertyFromPosition(position));

  if (!parentRes || !posRes) {
    G_Debug(this,
            "Warning: failed to create parent: %s or position node: %s. " + 
            "skipping....\n".subs(containerID, position));
    return;
  }

  var existingNode = this.bmDS.GetTarget(parentRes, posRes, true);

  if (!existingNode ||
      CLB_rdf.getValueFromNode(existingNode) != 
      CLB_rdf.getValueFromNode(node)) {
    var oldParent = this.bmServ.getParent(node);
    this.removeBookmark(oldParent, node);
    this.insertBookmark(parentRes, node, position, opt_type);
  }
}

CLB_BookmarkSyncer.prototype.unassertTargets = function(src, prop) {
  var tars = this.bmDS.GetTargets(src, prop, true);
  while (tars.hasMoreElements()) {
    var tar = tars.getNext();
    this.bmDS.Unassert(src, prop, tar);
    G_Debug(this, "removing: src: %s prop: %s tar: %s".subs(src.Value, 
                  prop.Value, tar.Value));
  }
}

CLB_BookmarkSyncer.prototype.maybeAssert = function(src, prop, tar) {
  if (this.bmDS.HasAssertion(src, prop, tar, true)) {
    return;
  }
  this.unassertTargets(src, prop);
  this.bmDS.Assert(src, prop, tar, true);
}

G_debugService.loggifier.loggify(CLB_BookmarkSyncer.prototype);


if (CLB_DEBUG) {

  function TEST_CLB_BookmarkSyncer() {
    var zone = "TEST_CLB_BookmarkSyncer";

    G_Debug(this, "Starting CLB_BookmarkSyncer unit tests");

    // For convenience, shorten the name of the bookmark syncer
    var bm = CLB_app.bmSyncer;
    bm.bmServ.readBookmarks();
    
    // --------------------
    // Test the handleDeleteItem function

    // Be sure that the function is robust to trying to delete items
    // that don't exist.
    var deleteItem1 =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "separator",
                        itemID: "rdf:#$333333,1",
                        properties: { parents: "rdf:#$333333",
                                      positions: "1" }});
    bm.handleDeleteItem(deleteItem1);

    var deleteItem2 =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "bookmark",
                        itemID: "rdf:#$222222",
                        properties: { parents: "rdf:#$333333",
                                      positions: "1" }});
    bm.handleDeleteItem(deleteItem2);

    // --------------------
    // Test the addBookmarkItem function

    // Add a regular bookmark
    var bm1item =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "bookmark",
                        itemID: "rdf:#$abcd03",
                        properties: { title: "Lovely Bookmark",
                                      url: "http://www.lb.com",
                                      description: "So Lovely",
                                      parents: "NC:BookmarksRoot",
                                      positions: "5" }});
    bm.addBookmarkItem(bm1item);

    // check the resulting properties
    var bm1 = bm.bmRdfServ.GetResource("rdf:#$abcd03");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm1),
             "Failed to insert bm1");
    for (var prop in bm1item.properties) {
      if (prop == "parents") {
        var parValue = CLB_rdf.getValueFromNode(bm.bmServ.getParent(bm1));
        G_Assert(zone, parValue == bm1item.getProperty(prop),
                 "Parent was " + parValue + " but should have been " +
                 bm1item.getProperty(prop));

      } else if (prop == "positions") {
        bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm1));
        G_Assert(zone, bm.container.IndexOf(bm1) == bm1item.getProperty(prop),
                 "Position was " + bm.container.IndexOf(bm1) +
                 " but should have been " + bm1item.getProperty(prop));

      } else {   
        var arc = bm.bmRdfServ.GetResource(
            bm.propertiesToCollect_.getValue(prop));
        var tar = bm.bmDS.GetTarget(bm1, arc, true);
        G_Assert(zone, tar, "Nothing found for property " + prop);
      
        var value = CLB_rdf.getValueFromNode(tar);
        G_Assert(zone, value == bm1item.getProperty(prop),
                 "Incorrect property value " + value + " for property " + prop);
      }
    }
    
    // Add a bookmark that doesn't yet have a parent
    var bm2item =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "bookmark",
                        itemID: "rdf:#$bcde03",
                        properties: { title: "Orphan Bookmark",
                                      url: "http://www.ob.com",
                                      description: "So Lonely",
                                      parents: "rdf:#$cdef03",
                                      positions: "2" }});
    bm.addBookmarkItem(bm2item);

    // check the resulting properties
    var bm2 = bm.bmRdfServ.GetResource("rdf:#$bcde03");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm2),
             "Failed to insert bm2");

    for (var prop in bm2item.properties) {
      if (prop == "parents") {
        var parValue = CLB_rdf.getValueFromNode(bm.bmServ.getParent(bm1));
        G_Assert(zone,
                 parValue == CLB_rdf.getValueFromNode(
                     bm.getScratchFolder(true /* insert if necessary */)),
                 "Bookmark was not added to the scratch folder");

      } else if (prop == "positions") {
        bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm1));
        G_Assert(zone, bm.container.IndexOf(bm1) == 1,
                 "Position should have been 1 but was actually " +
                 bm.container.IndexOf(bm1));

      } else {   
        var arc = bm.bmRdfServ.GetResource(
            bm.propertiesToCollect_.getValue(prop));
        var tar = bm.bmDS.GetTarget(bm2, arc, true);
        G_Assert(zone, tar, "Nothing found for property " + prop);
      
        var value = CLB_rdf.getValueFromNode(tar);
        G_Assert(zone, value == bm2item.getProperty(prop),
                 "Incorrect property value " + value + " for property " + prop);
      }
    }

    // Record the scratch folder for later
    var scratchFolder = bm.getScratchFolder(true /* insert if necessary */);
    
    // Add the parent bookmark now
    var bm3item =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "folder",
                        itemID: "rdf:#$cdef03",
                        properties: { title: "Orphan Parent",
                                      url: "http://www.op.com",
                                      description: "Parent",
                                      parents: "NC:BookmarksRoot",
                                      positions: "5" }});
    bm.addBookmarkItem(bm3item);

    // check the resulting properties
    var bm3 = bm.bmRdfServ.GetResource("rdf:#$cdef03");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm3),
             "Failed to insert bm3");

    for (var prop in bm3item.properties) {
      if (prop == "parents") {
        var parValue = CLB_rdf.getValueFromNode(bm.bmServ.getParent(bm3));
        G_Assert(zone, parValue == bm3item.getProperty(prop),
                 "Bookmark was not added to the proper parent");

      } else if (prop == "positions") {
        bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm3));
        G_Assert(zone, bm.container.IndexOf(bm3) == bm3item.getProperty(prop),
                 "Position should have been " + bm3item.getPeroperty(prop) +
                 " but was actually " + bm.container.IndexOf(bm3));

      } else {   
        var arc = bm.bmRdfServ.GetResource(
            bm.propertiesToCollect_.getValue(prop));
        var tar = bm.bmDS.GetTarget(bm3, arc, true);
        G_Assert(zone, tar, "Nothing found for property " + prop);
      
        var value = CLB_rdf.getValueFromNode(tar);
        G_Assert(zone, value == bm3item.getProperty(prop),
                 "Incorrect property value " + value + " for property " + prop);
      }
    }

    // Now check that the orphan child was moved properly
    var parValue = CLB_rdf.getValueFromNode(bm.bmServ.getParent(bm2));
    G_Assert(zone, parValue == "rdf:#$cdef03",
             "Orphan child was not moved properly");

    // Verify that the scratch folder was removed
    G_Assert(zone, !bm.bmServ.isBookmarkedResource(scratchFolder),
             "Scratch folder didn't get removed");

    // --------------------
    // Test the getItemByID function
    // This is the first bookmark we added above.  Test that we can
    // properly retrieve the bookmark info
    var testItem = bm.getItemByID("rdf:#$abcd03", "bookmark");
    G_Assert(zone, testItem.itemID == "rdf:#$abcd03",
             "Incorrect itemID");
    G_Assert(zone, testItem.typeID == "bookmark",
             "Incorrect typeID");
    G_Assert(zone, testItem.hasProperty("title") &&
             testItem.getProperty("title") == "Lovely Bookmark",
             "Did not retrieve title properly");
    G_Assert(zone, testItem.hasProperty("url") &&
             testItem.getProperty("url") == "http://www.lb.com",
             "Did not retrieve url properly");
    G_Assert(zone, testItem.hasProperty("description") &&
             testItem.getProperty("description") == "So Lovely",
             "Did not retrieve description properly");
    G_Assert(zone, testItem.hasProperty("parents") &&
             testItem.getProperty("parents") == "NC:BookmarksRoot",
             "Did not retrieve parents properly");
    G_Assert(zone, testItem.hasProperty("positions") &&
             testItem.getProperty("positions") == "5",
             "Did not retrieve positions properly");

    // -----------------
    // cleanup all bookmarks that were created thus far
    bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm1));
    bm.container.RemoveElement(bm1, false);

    bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm2));
    bm.container.RemoveElement(bm2, false);

    bm.container.Init(bm.bmDS, bm.bmServ.getParent(bm3));
    bm.container.RemoveElement(bm3, false);


    // ------------------
    // Test that child items are rescued when we delete the parent folder
    var rootNode = CLB_app.bmSyncer.bmRdfServ.GetResource(
        CLB_BookmarkSyncer.rootRdfStr);
    var folder1Res = CLB_app.bmSyncer.bmServ.createFolderInContainer(
        "Folder1", rootNode, 0 /* append */);
    var folder2Res = CLB_app.bmSyncer.bmServ.createFolderInContainer(
        "Folder2", folder1Res, 0 /* append */);
    var bm1 = CLB_app.bmSyncer.bmServ.createBookmarkInContainer(
        "bookmark", "www.bookmark.com", "shortcut", "description",
        "", "", folder1Res, 0 /* append */);
    var bm2 = CLB_app.bmSyncer.bmServ.createBookmarkInContainer(
        "bookmark2", "www.bookmark2.com", "", "description2",
        "", "", folder2Res, 0 /* append */);

    var removeItem =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "folder",
                        itemID: CLB_rdf.getValueFromNode(folder1Res),
                        isRemove: true,
                        properties: { }});
    CLB_app.bmSyncer.addBookmarkItem(removeItem);
    G_Assert(zone, bm.bmServ.isBookmarkedResource(folder2Res),
             "Failed to rescue Folder2");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm1),
             "Failed to rescue bm1");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm2),
             "Failed to rescue bm2");

    var moveFolderItem =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "folder",
                        itemID: CLB_rdf.getValueFromNode(folder2Res),
                        properties: { parents: "NC:BookmarksRoot",
                                      positions: "5" }});
    CLB_app.bmSyncer.addBookmarkItem(moveFolderItem);
    G_Assert(zone, bm.bmServ.isBookmarkedResource(folder2Res),
             "Failed to move Folder2");
    G_Assert(zone,
      CLB_rdf.getValueFromNode(bm.bmServ.getParent(folder2Res)) ==
                               "NC:BookmarksRoot",
      "Failed to move folder under the proper parent");

    var removeItem2 =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "folder",
                        itemID: CLB_rdf.getValueFromNode(folder2Res),
                        isRemove: true,
                        properties: { }});
    CLB_app.bmSyncer.addBookmarkItem(removeItem2);
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm1),
             "Failed to rescue bm1");
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm2),
             "Failed to rescue bm2");

    var moveBookmarkItem =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "bookmark",
                        itemID: CLB_rdf.getValueFromNode(bm1),
                        properties: { parents: "NC:BookmarksRoot",
                                      positions: "5" }});
    CLB_app.bmSyncer.addBookmarkItem(moveBookmarkItem);
    G_Assert(zone, bm.bmServ.isBookmarkedResource(bm1), "Failed to move bm1");
    G_Assert(zone,
      CLB_rdf.getValueFromNode(bm.bmServ.getParent(bm1)) ==
                               "NC:BookmarksRoot",
      "Failed to move bm1 properly");

    var deleteBookmarkItem =
      new CLB_SyncItem({componentID: bm.componentID,
                        typeID: "bookmark",
                        itemID: CLB_rdf.getValueFromNode(bm1),
                        isRemove: true,
                        properties: { }});
    CLB_app.bmSyncer.addBookmarkItem(deleteBookmarkItem);
    G_Assert(zone, !bm.bmServ.isBookmarkedResource(bm1),
             "Failed to delete bm1");

    var deleteBookmarkItem2 = deleteBookmarkItem.clone();
    deleteBookmarkItem2.itemID = CLB_rdf.getValueFromNode(bm2);
    CLB_app.bmSyncer.addBookmarkItem(deleteBookmarkItem2);
    G_Assert(zone, !bm.bmServ.isBookmarkedResource(bm2),
             "Failed to delete bm2");

    // ------------------
    // Test that starting the bookmarksyncer will clear out the
    // scratch folder

    // First get the scratch folder and insert something into it
    scratchFolder = bm.getScratchFolder(true /* insert if necessary */);
    bm.container.Init(bm.bmDS, scratchFolder);
    var newBm = bm.bmServ.createBookmark("name", "url", "shortcut",
                                         "description", "charset", "");
    bm.container.AppendElement(newBm);

    G_Debug(this, "About to start");
    // start bookmarksyncer
    bm.start();

    // verify that scratch folder doesn't exist anymore.
    G_Assert(this, !bm.bmServ.isBookmarkedResource(scratchFolder),
             "Failed to delete scratch folder on startup");

    // stop the bookmarksyncer so it isn't confused
    bm.stop();

    var rootNode = CLB_app.bmSyncer.bmRdfServ.GetResource(
    CLB_BookmarkSyncer.rootRdfStr);
    CLB_app.bmSyncer.maybeDecrementNextVal(rootNode, 5);

    G_Debug(zone, "All bookmarksyncer unittests passed");
  }
}
