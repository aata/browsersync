// Copyright 2006 and onwards, Google

/**
 * Handles bookkeeping necessary to resolve bookmark conflicts.
 * In particular, this class builds data structures that makes it easy
 * to answer questions about the union of items that have not yet been
 * added to the local store and items already in the local store.
 *
 * Currently we record parent and position information for all
 * downloaded items, as well as local items in the same folder as downloaded
 * items.  This creates a picture of each affected folder as it would
 * be if the download were applied.  This helps with things like
 * merging folders and resolving position conflicts, as well as closing
 * position holes in a folder after an item is deleted.  Note that the
 * applied downloaded items are after smooshing so that any offline
 * changes that will win have already been applied.
 *
 * Folder name and folder parent are recorded in a lazy fashion.  They are
 * recorded for all downloaded folders that have those fields set in the
 * update item. It is also recorded if we ever looked it up in the local
 * store. So, it is retrieved on demand and is stored after that point.
 */

function CLB_BookmarkResolver() {
  // Map from folder rdf id -> CLB_Folder
  // The folders are a merge of info in the Firefox local store and
  // downloaded items.  This allows easy lookup of things like the
  // contents of a folder and the max position in a folder before
  // the updates have actually been added to Firefox
  this.folders_ = {};
}

CLB_BookmarkResolver.folderPathSeparator = "/";
CLB_BookmarkResolver.oldToolbarName = "Personal Toolbar Folder";
CLB_BookmarkResolver.newToolbarName = "Bookmarks Toolbar Folder";

/**
 * Releases reference to folder map
 */
CLB_BookmarkResolver.prototype.clear = function() {
  this.folders_ = {};
}

/**
 * Given a downloaded item, update our folder map appropriately.  This
 * includes folder contents and position information.  Note that this is
 * the downloaded item _after_ smooshing, so if any offline change was
 * going to beat the downloaded item, it's already been taken care of.
 */
CLB_BookmarkResolver.prototype.addDownloadedItem = function(item) {
  // We're interested in 4 pieces of information for a downloaded item
  // currently, since that is all we need for conflict resolution:
  // parent, position, folder name, and folder parent.
  //
  // Item parent and position is always recorded.
  //
  // We only record the folder name and folder parent if item is a
  // folder (duh).  Also, this recording is lazy since it is used
  // infrequently (for folder name conflicts).  Thus the info is
  // only recorded for downloaded items or for local items that we've
  // already looked up.  Both folder name and folder parent are recorded
  // as properties on CLB_Folder
  var parent, pos;

  // First extract parent/position info
  if (!item.isRemove) {
    // For non isRemove items we can find the item parent and position info
    // directly in the item
    parent = CLB_app.bmSyncer.getParent(item);
    pos = CLB_app.bmSyncer.getPosition(item);

  } else {
    // This item is a removal, so it must be removing a local item, since the
    // server promises to only send one item per itemID for each download.
    // Find the parent and position info from the local store.
    var bmNode;
    if (item.typeID == "separator") {
      bmNode = CLB_app.bmSyncer.getSeparatorResource(item.itemID);
    } else {
      bmNode = CLB_app.bmSyncer.bmRdfServ.GetResource(item.itemID);
    }

    if (!bmNode) {
      G_Debug(this, "Warning, could not form resource from item " +
              item.itemID + ", skipping");
      return;
    }
    
    // Maybe this is a bogus isRemove - if so stop here
    if (!CLB_app.bmSyncer.bmServ.isBookmarkedResource(bmNode)) {
      G_Debug(this, "Warning: bogus isRemove sent from the server " +
              " with itemID " + item.itemID);
      return;
    }

    // Initialize the rdf resources and container necessary to
    // extract parent and pos info
    var parentNode = CLB_app.bmSyncer.bmServ.getParent(bmNode);
    var container = Cc["@mozilla.org/rdf/container;1"]
                    .getService(Ci.nsIRDFContainer);
    container.Init(CLB_app.bmSyncer.bmDS, parentNode);

    // Actually extract the parent and pos info
    parent = CLB_rdf.getValueFromNode(parentNode);
    pos = container.IndexOf(bmNode);
  }
  
  if (!parent || !pos /* valid pos starts at 1 */ ) {
    G_Debug(this, "Error: every bookmark item should contain a parent and " +
            " position - perhaps this is old data?");
    return;
  }
  
  // If the parent folder hasn't yet been seen, create a new object for it
  var parentFolder = this.getFolder(parent);

  // Next update the folder contents by adding the bookmark
  if (item.isRemove) {
    parentFolder.removeBookmark(item.itemID);
  } else {
    parentFolder.addBookmark(item.itemID, item.typeID, pos);
  }

  // We finished adding this item to its folder.  Next extract parent and
  // name info for this item if it's a folder
  if (!item.isRemove && item.typeID == "folder") {
    // TODO: The getFolder call here is perhaps overkill, since it initializes
    // all the items in the folder as well.  Perhaps we could make the
    // folder have a state where it is uninitialized, and in that state
    // we don't read in the local items in the folder
    var folder = this.getFolder(item.itemID);
    var folderParent = CLB_app.bmSyncer.getParent(item);
    folder.setParent(folderParent);

    var nameProperty = CLB_app.bmSyncer.propertiesToCollect_.getKey(
        CLB_BookmarkSyncer.nameRdfStr);
    if (item.hasProperty(nameProperty)) {
      var folderName = item.getProperty(nameProperty);
      folder.setName(folderName);
    }
  }
}

CLB_BookmarkResolver.prototype.getFolder = function(parent) {
  var folder = this.folders_[parent];
  if (!isDef(folder)) {
    folder = new CLB_Folder(parent);
    this.folders_[parent] = folder;
  }
  return folder;
}

/**
 * Helper function that shifts items in a folder up or down starting
 * at startPosition, with the goal of creating a hole or closing a hole
 * in the position list.
 *
 * If shiftDown is true, we shift items down if they
 * are > startPosition.  However, if there is already an item at
 * startPosition, we abort the shift since there is no hole.
 *
 * If shiftUp is true, we shift items up if they are >= startPosition.
 * However, if there is already a blank position at startPosition, we abort the
 * shift, since there is already a hole.
 */
CLB_BookmarkResolver.prototype.shiftItems = function(folderID, startPosition,
                                                     shiftDown) {
  var folder = this.getFolder(folderID);

  // This is used to determine whether or not to actually shift items up - if
  // there is already a hole at the position we are inserting at, then no
  // need to shift
  var foundItemAtStartPosition = false;
  
  // Look for items that have larger positions than the start position
  // and create GISyncItems for these bookmarks
  var shiftedItems = [];
  for (var bm in folder.contents_) {
    var currentBmPosition = folder.getBookmarkPosition(bm);
    var typeID = folder.getBookmarkTypeID(bm);

    if (currentBmPosition == parseInt(startPosition)) {
      // record that we found an item at our start position - we'll
      // use this later to determine whether or not to actually shift
      // up.  (If there is already a hole in the list at that position
      // then no need to shift up.)
      foundItemAtStartPosition = true;
      
      // If we are shifting items down and there is another item at the
      // same position, abort shifting the other items down
      // since there is no hole.
      if (shiftDown) {
        return [];
      }
    }

    // Now create an update item for any item that needs to be moved.
    // Note that this must be >= for the shifting up case, to catch the
    // item at the start position
    if (currentBmPosition >= parseInt(startPosition)) {
      var newBmPosition;
      if (shiftDown) {
        newBmPosition = currentBmPosition - 1;
      } else {
        newBmPosition = currentBmPosition + 1;
      }

      var itemID;
      if (typeID == "separator") {
        // When shifting separators need to delete the old one
        var separatorDeleteItem =
          new CLB_SyncItem({ componentID: CLB_app.bmSyncer.componentID,
                             typeID: typeID,
                             itemID: bm,
                             isRemove: true,
                             properties: {  } });
        shiftedItems.push(separatorDeleteItem);

        itemID = CLB_app.bmSyncer.createSeparatorID(folderID, newBmPosition);
      } else {
        itemID = bm;
      }

      var item =
        new CLB_SyncItem({ componentID: CLB_app.bmSyncer.componentID,
                           typeID: typeID,
                           itemID: itemID,
                           properties: { parents: folderID,
       	                                 positions: newBmPosition } });
      shiftedItems.push(item);
    }
  }

  // If we're shifting up and didn't find an item at the start position,
  // abort the shift.  There is no need to shift if there is already a hole
  if (!shiftDown && !foundItemAtStartPosition) {
    return [];
  }

  // We're sure we're going to return these items, so apply the
  // changes to the folder
  shiftedItems.forEach(function(shiftedItem) {
    if (shiftedItem.isRemove) {
      folder.removeBookmark(shiftedItem.itemID);
    } else {
      this.addItemToFolder(shiftedItem, false /* Don't shift items */);
    }
  }, this);

  return shiftedItems;
}

/**
 * Helper function that extracts the parent and position info from an
 * item, finds the folder corresponding to the parent, and removes the
 * bookmark from the folder.
 * If shiftItems is true, all bookmarks in a position > the one we just
 * removed will be shifted down one.
 */
CLB_BookmarkResolver.prototype.removeItemFromFolder =
function(item, shiftItems) {
  if (item.isRemove) {
    G_Debug(this, "Error: removeItemFromFolder should never be called " +
            " with an isRemove item because these items don't contain " +
            " parent and position info.");
    return;
  }

  var parent = CLB_app.bmSyncer.getParent(item);
  var positionToInsert = CLB_app.bmSyncer.getPosition(item);

  var folder = this.getFolder(parent);
  
  // Remove the bookmark we are deleting from the folder.
  // Make sure to do this before shifting items, so that this
  // item won't be included in the shift
  folder.removeBookmark(item.itemID);

  // If we don't have to shift items in the folder, we're done
  var shiftedItems;
  if (!shiftItems) {
    shiftedItems = [];
  } else {
    shiftedItems = this.shiftItems(parent, positionToInsert,
                                   true /* shift down */);
  }

  return shiftedItems;
}

/**
 * Helper function that extracts the parent and position info from an item,
 * finds the folder corresponding to the parent, and adds the bookmark
 * to the folder.
 * If shiftItems is true, all bookmarks in a position >= the one we just
 * added will be shifted up one.
 */
CLB_BookmarkResolver.prototype.addItemToFolder = function(item,
                                                          shiftItems) {
  if (item.isRemove) {
    G_Debug(this, "Error: addItemToFolder should never be called " +
            " with an isRemove item because these items don't contain " +
            " parent and position info.");
    return;
  }

  var parent = CLB_app.bmSyncer.getParent(item);
  var positionToInsert = CLB_app.bmSyncer.getPosition(item);

  var folder = this.getFolder(parent);

  // Make sure to remove any existing instance of this item in the folder
  // so it isn't included in shifted items that are returned
  folder.removeBookmark(item.itemID);
  
  // If we don't have to shift items in the folder, we're done
  var shiftedItems;
  if (!shiftItems) {
    shiftedItems = [];
  } else {
    shiftedItems = this.shiftItems(parent, positionToInsert,
                                   false /* shift up */);
  }

  // Insert the bookmark into the folder - make sure this is after
  // we shifted items so that it doesn't get shifted too
  folder.addBookmark(item.itemID, item.typeID, positionToInsert);
  
  return shiftedItems;
}

/**
 * Get the full folder name path all the way to the root element.  Individual
 * folder names are escaped and then separated with the folderPathSeparator
 * constant
 */
CLB_BookmarkResolver.prototype.getParentPath = function(id) {
  var path = "";
  var currentParent = id;
  do {
    var nextParent = null;
    if (isDef(this.folders_[currentParent])) {
      nextParent = this.folders_[currentParent].getParent();
    }
    
    if (nextParent == null) {
      // Either the parent was never initialized on the folder object or
      // there is no existing folder object, so just look for it in the
      // local store.
      var bmNode = CLB_app.bmSyncer.bmRdfServ.GetResource(currentParent);
      var nextParentNode = CLB_app.bmSyncer.bmServ.getParent(bmNode);
      if (!nextParentNode) {
        G_Debug(this, "Error: Tried to get parent for folder " +
                currentParent +
                " but it did not exist in the local store");
        return null;
      }
      nextParent = CLB_rdf.getValueFromNode(nextParentNode);
    }

    var folderName = null;
    if (isDef(this.folders_[nextParent])) {
      folderName = this.folders_[nextParent].getName();
    }
    
    if (folderName == null) {
      // Either the folder name was never initialized on the folder object
      // or there is no existing folder object, so just look for it in the
      // local store.
      var nextParentNode = CLB_app.bmSyncer.bmRdfServ.GetResource(nextParent);
      var nameArc = CLB_app.bmSyncer.bmRdfServ.GetResource(
          CLB_BookmarkSyncer.nameRdfStr);
      var tar = CLB_app.bmSyncer.bmDS.GetTarget(nextParentNode, nameArc, true);
      if (!tar) {
        G_Debug(this, "Error: Tried to get name for folder " + nextParent +
                " but it did not exist in the local store");
        return null;
      }
      folderName = CLB_rdf.getValueFromNode(tar);
    }

    // We escape the folder name before inserting the separator, to prevent
    // against screwing this comparison up by using the separator in the
    // folder name somewhere.
    path = encodeURIComponent(folderName) +
           CLB_BookmarkResolver.folderPathSeparator +
           path;

    currentParent = nextParent;
    
  // The root node does actually have a name attached to it, so getting
  // the name on that node will not cause an error.
  } while (currentParent != CLB_BookmarkSyncer.rootRdfStr);

  return path;
}

/**
 * If two folders have the same name, then delete one folder and move
 * the contents of that folder to the other folder.  Note that any new
 * conflicts created during this move will be detected by the conflict
 * resolver.
 */
CLB_BookmarkResolver.prototype.resolveFolderNameConflict =
function(oldItem, newItem) {
  // Sanity check
  if (oldItem.typeID != "folder" && newItem.typeID != "folder") {
    G_Debug(this, "Error: trying to resolve a folder name conflict " +
            " for non folders - how did we get here?");
    return [];
  }

  // First verify that these folders that have the same name actually
  // have the same parent names too.
  var path1 = this.getParentPath(oldItem.itemID);
  var path2 = this.getParentPath(newItem.itemID);
  if (isNull(path1) || isNull(path2) || path1 != path2) {
    return [];
  }

  return this.mergeFolders(oldItem, newItem);
}

CLB_BookmarkResolver.prototype.mergeFolders = function(oldFolder, newFolder) {
  // Update the folder info - some bookmarks might be shifted
  // as a result of the folder deletion
  var resolvedItems = this.removeItemFromFolder(oldFolder,
                                              true /* renumber other items */);

  // Find the folder for the item that we're deleting - we need to move the
  // contents to the new folder
  var folder = this.getFolder(oldFolder.itemID);

  // Move any contents of the old folder into the new folder
  // Create a GISyncItem for every moved bookmark
  var parent = newFolder.itemID;
  for (var id in folder.contents_) {
    // Create the actual GISyncItem
    var position = folder.getBookmarkPosition(id);
    var typeID = folder.getBookmarkTypeID(id);

    var itemID;
    if (typeID == "separator") {
      var separatorDeleteItem =
        new CLB_SyncItem({ componentID: CLB_app.bmSyncer.componentID,
                           typeID: typeID,
                           itemID: id,
                           isRemove: true,
                           properties: { } });
      resolvedItems.push(separatorDeleteItem);

      itemID = CLB_app.bmSyncer.createSeparatorID(parent, position);
    } else {
      itemID = id;
    }

    var item =
      new CLB_SyncItem({ componentID: CLB_app.bmSyncer.componentID,
                         typeID: typeID,
                         itemID: itemID,
              properties: { "parents": parent,
                            "positions": position } });
    resolvedItems.push(item);

    // Remove the bookmark from the old folder
    folder.removeBookmark(itemID);

    // Add the bookmark to the new folder
    this.addItemToFolder(item, false /* Don't shift items */);
  }

  // Before marking the old folder for delete, check if it was marked
  // as the toolbar folder.  If so, then move the toolbar folder attribute
  // over to the other folder with the same name.  Note that at this
  // point we've already done toolbar folder conflict resolution, so
  // if this folder was going to lose as toolbar folder, the property
  // would already be deleted.
  var toolbarProperty = CLB_app.bmSyncer.propertiesToCollect_.getKey(
      CLB_BookmarkSyncer.toolbarFolder);
  if (oldFolder.hasProperty(toolbarProperty) &&
      !isNull(oldFolder.getProperty(toolbarProperty))) {
    var newItemUpdate = newFolder.clone();
    newItemUpdate.setProperty(toolbarProperty, "true");
    resolvedItems.push(newItemUpdate);
  }

  // Mark the old folder for delete
  oldFolder.clearProperties();
  oldFolder.isRemove = true;

  return resolvedItems;
}

/**
 * If two bookmarks have the same url, or if two livemarks have the same
 * feedUrl, then delete one and shift the items in the folder it was
 * deleted from accordingly.
 */
CLB_BookmarkResolver.prototype.resolveUrlConflict = function(oldItem, newItem) {

  // Update folder to indicate that we are removing this item - some
  // bookmarks might shift as a result of this deletion
  var resolvedItems = this.removeItemFromFolder(oldItem,
                                             true /* renumber other items */ );

  oldItem.clearProperties();
  oldItem.isRemove = true;

  // No other items to send in an update, so return empty array
  return resolvedItems;
}

/**
 * If two bookmarks are in the same position, then move one to the next
 * available position in that folder
 */
CLB_BookmarkResolver.prototype.resolvePositionConflict = function(oldItem,
                                                                  newItem) {  
  var position = CLB_app.bmSyncer.getPosition(oldItem);
  var parent = CLB_app.bmSyncer.getParent(oldItem);

  // The rule for resolving position conflicts is to take the next position
  // and bump up whatever is in the way
  var newPosition = parseInt(position) + 1;
  
  // For separators, we delete the old item and add a new item, since changing
  // position requires changing the ID.
  var itemToInsert;
  if (oldItem.typeID == "separator") {
    // Prepare the new separator item to insert - note that we set the new
    // position below
    itemToInsert = oldItem.clone();
    itemToInsert.itemID = CLB_app.bmSyncer.createSeparatorID(parent,
                                                             newPosition);
    
    // Remove the old separator 
    this.removeItemFromFolder(oldItem);
    oldItem.clearProperties();
    oldItem.isRemove = true;

  } else {
    itemToInsert = oldItem;
  }

  itemToInsert.setProperty("positions", newPosition);
  
  var shiftedItems = this.addItemToFolder(itemToInsert, true /* shift items */);

  // Be sure to add the new separator item to the array of items to return.
  // We could do this earlier, but it's faster to append one item on to the
  // end of shifted items, rather than appending all the shifted items
  // onto the back of an array of one item.
  if (itemToInsert.typeID == "separator") {
    shiftedItems.push(itemToInsert);
  }

  return shiftedItems;
}

/**
 * If two folders are marked as being the toolbar folder, then remove
 * one mark, so that there is only one folder marked as the toolbar folder
 */
CLB_BookmarkResolver.prototype.resolveToolbarConflict =
function(oldItem, newItem) {
  
  if (oldItem.typeID != "folder") {
    return [];
  }
  
  var toolbarProperty = CLB_app.bmSyncer.propertiesToCollect_.getKey(
      CLB_BookmarkSyncer.toolbarFolder);

  // Be sure to set the toolbar folder property to null, so that the
  // property is removed from items on the server.
  oldItem.setProperty(toolbarProperty, null);

  var titleProperty = CLB_app.bmSyncer.propertiesToCollect_.getKey(
    CLB_BookmarkSyncer.nameRdfStr);
  var oldItemTitle = oldItem.getProperty(titleProperty);
  var newItemTitle = newItem.getProperty(titleProperty);
  if ((oldItemTitle == CLB_BookmarkResolver.oldToolbarName &&
       newItemTitle == CLB_BookmarkResolver.newToolbarName) ||
       (oldItemTitle == CLB_BookmarkResolver.newToolbarName &&
       newItemTitle == CLB_BookmarkResolver.oldToolbarName)) {
    return this.mergeFolders(oldItem, newItem);
  }

  // No other items needed to resolve the conflict, so return the empty array
  return [];
}

G_debugService.loggifier.loggify(CLB_BookmarkResolver.prototype);


/**
 * Keeps track of the contents of a folder, including the positions of
 * each item contained in the folder.  This is a helper class for the
 * bookmark resolver.
 *
 * On construction, the folder class looks in the local store to get
 * the items in the folder.  After that, all items are applied on top
 * of the local items.
 */
function CLB_Folder(parent) {
  // Note that folder positions start at 1, so this is really an invalid
  // position
  this.maxPosition_ = 0;

  // We lazily keep track of the folder name - if it is in a downloaded
  // item we record it or if it is looked up locally to resolve a folder
  // name conflict, we also record it here.
  this.name_ = null;

  // We lazily keep track of the folder parent as well - if it is in a
  // downloaded item we record it or if it is looked up locally to resolve
  // a folder name conflict, we also record it here.
  this.parent_ = null;

  // Map from rdf id -> position, typeID, allows fast lookup by id
  this.contents_ = {};

  // Now that we are tracking this folder, check if there are items in
  // the local store that we need to keep track of.  Any downloaded items
  // with the same id will override these items.
  var parentNode = CLB_app.bmSyncer.bmRdfServ.GetResource(parent);
  if (!CLB_app.bmSyncer.bmServ.isBookmarkedResource(parentNode)) {
    return;
  }

  var container = Cc["@mozilla.org/rdf/container;1"]
                  .getService(Ci.nsIRDFContainer);
  container.Init(CLB_app.bmSyncer.bmDS, parentNode);
  var localBms = container.GetElements();
  while (localBms.hasMoreElements()) {
    var bm = localBms.getNext();
    var bmValue = CLB_rdf.getValueFromNode(bm);
    
    // get position of the bookmark in the folder and typeID
    var pos = container.IndexOf(bm);
    var typeID = CLB_app.bmSyncer.getTypeID(bm);

    // Add the bookmark and adjust max position if necessary
    if (typeID == "separator") {
      var itemID = CLB_app.bmSyncer.createSeparatorID(parent, pos);
      this.addBookmark(itemID, typeID, pos);
    } else {
      this.addBookmark(bmValue, typeID, pos);
    }
  }
  
}

/**
 * Add a bookmark to this folder.  If any bookmark with the same id exists
 * already in the folder, the older item will be overwritten.
 * Also adjust the max value used in folder if necessary.  Note that
 * id corresponds to itemID
 *
 * This function can also be used to move a bookmark already in the
 * map to a new position.  The existing folder name will also be moved.
 */
CLB_Folder.prototype.addBookmark = function(id, typeID, position) {
  // First add the bookmark to our contents map and print a warning
  // if it already exists.
  if (isDef(this.contents_[id])) {

    G_Debug(this, "Warning: adding the same bookmark again. " +
            " id: " + id +
            " Old position: " + this.contents_[id].position + 
            " New position: " + position);
  }

  position = parseInt(position);
  if (isNaN(position)) {
    G_Debug(this, "Could not parse position value, not adding bookmark " + id);
    return;
  }

  this.contents_[id] = { position: position,
                         typeID: typeID };

  // Now update our max position, if necessary
  if (position > this.maxPosition_) {
    this.maxPosition_ = position;
  }
}

/**
 * Remove a bookmark from the folder.  Also adjust the max value used in
 * the folder, if necessary.  Note that id corresponds to itemID
 */
CLB_Folder.prototype.removeBookmark = function(id) {
  // Decrement max position if we just removed the last bookmark
  var bm = this.contents_[id];
  if (!isDef(bm)) {
    G_Debug(this, "Warning: deleting nonexistant item " + id +
            " from a folder");
    return;
  }
  
  if (this.maxPosition_ > 0 &&
      this.maxPosition_ == bm.position) {
    this.maxPosition_ = this.maxPosition_ - 1;
  }

  // Remove from the contents map
  delete this.contents_[id];
}

CLB_Folder.prototype.hasBookmark = function(id) {
  return isDef(this.contents_[id]);
}

CLB_Folder.prototype.getBookmarkPosition = function(id) {
  return this.contents_[id].position;
}

CLB_Folder.prototype.getBookmarkTypeID = function(id) {
  return this.contents_[id].typeID;
}

CLB_Folder.prototype.setName = function(newName) {
  this.name_ = newName;
}
  
CLB_Folder.prototype.getName = function() {
  return this.name_;
}

CLB_Folder.prototype.setParent = function(parentID) {
  this.parent_ = parentID;
}

CLB_Folder.prototype.getParent = function() {
  return this.parent_;
}
  
CLB_Folder.prototype.toString = function() {
  var str = "{ CLB_Folder Max Position: %s Contents: ".subs(this.maxPosition_);
  for (var id in this.contents_) {
    str += "id=%s, typeid=%s, position=%s - ".subs(
        id, this.getBookmarkTypeID(id), this.getBookmarkPosition(id));
  }
  str += " }";
  return str;
}

G_debugService.loggifier.loggify(CLB_Folder.prototype);


if (CLB_DEBUG) {

  function TEST_CLB_BookmarkResolver() {
    var zone = "TEST_CLB_BookmarkResolver";

    G_Debug(this, "Starting CLB_BookmarkResolver unittests...");
    
    var resolver = new CLB_BookmarkResolver();
    CLB_app.bmSyncer.bmServ.readBookmarks();

    // *******
    // Test getParentPath

    // Add stuff to local state so we can look up folder names there
    var rootNode = CLB_app.bmSyncer.bmRdfServ.GetResource(
        CLB_BookmarkSyncer.rootRdfStr);
    var folder1Res = CLB_app.bmSyncer.bmServ.createFolderInContainer(
        "Folder1Local", rootNode, 0 /* append */);
    var folder2Res = CLB_app.bmSyncer.bmServ.createFolderInContainer(
        "Folder2>WithSeparator", folder1Res, 0 /* append */);
    var bm1 = CLB_app.bmSyncer.bmServ.createBookmarkInContainer(
        "bookmark", "www.bookmark.com", "shortcut", "description",
        "", "", folder2Res, 0 /* append */);

    // Store the folder1 state in a CLB_Folder so that we test a path that
    // is a mix of local state and in memory state
    var clbFolder1 = resolver.getFolder(CLB_rdf.getValueFromNode(folder1Res));
    clbFolder1.setName("Folder1Downloaded");
    clbFolder1.setParent(CLB_BookmarkSyncer.rootRdfStr);

    // Now make sure the path is retrieved appropriately
    var bm1Path = resolver.getParentPath(CLB_rdf.getValueFromNode(bm1));
    G_Assert(zone,
             bm1Path == "Bookmarks/Folder1Downloaded/Folder2%3EWithSeparator/",
             "Failed to retrieve parent path for bm1 correctly: " + bm1Path);

	// Cleanup the bookmarks we created
    CLB_app.bmSyncer.container.Init(CLB_app.bmSyncer.bmDS, rootNode);
    CLB_app.bmSyncer.container.RemoveElement(folder1Res, true);

    // *******
    // Test resolveFolderNameConflict

    // First create two items with the same folder name

    // folder1 will be the downloaded folder that will lose the resolution
    var folder1 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "folder",
                        itemID: "rdf:#$wxyz01",
                        properties: { title: "folder name",
                                      parents: "NC:BookmarksRoot",
                                      positions: "1" }});
    // folder2 will be the local folder that will win the resolution
    var folder2 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "folder",
                        itemID: "rdf:#$wxyz02",
                        properties: { title: "folder name",
                                      parents: "NC:BookmarksRoot",
                                      positions: "2" }});

    // Set up existing items in the folder that will be deleted
    resolver.addDownloadedItem(folder1);
    var clbFolder1 = resolver.getFolder("rdf:#$wxyz01");
    clbFolder1.addBookmark("id1", "bookmark", 1);
    clbFolder1.addBookmark("rdf:#$wxyz01,2", "separator", 2);
    clbFolder1.addBookmark("id3", "bookmark", 3);

    // This is just a convenient way to add folder2 to our in memory state
    resolver.addDownloadedItem(folder2);

    // Now resolve the conflict
    var resolved = resolver.resolveFolderNameConflict(folder1, folder2);

    // Check that the items that were in folder1 are moved to folder2
    G_Assert(zone, resolved.length == 4,
             "Expected 4 resolved items, instead received " + resolved.length);
    
    for (var i = 0; i < 3; i++) {
      // The old separator should have been deleted
      if (resolved[i].itemID == "rdf:#$wxyz01,2") {
        G_Assert(zone, resolved[i].typeID == "separator",
                 "Wrong typeID for old separator");
        G_Assert(zone, resolved[i].isRemove, "Old separator not deleted");

      } else {
        // All other items should have been moved into the new folder
        G_Assert(zone, resolved[i].getProperty("parents") == "rdf:#$wxyz02",
                 "Item " + resolved[i].itemID + " did not get moved");
    
        if (resolved[i].itemID == "id1") {
          G_Assert(zone, resolved[i].typeID == "bookmark",
                   "Wrong typeID for item id1");
        
        } else if (resolved[i].itemID == "rdf:#$wxyz02,2") {
          G_Assert(zone, resolved[i].typeID == "separator",
                   "Wrong typeID for item id2");

        } else if (resolved[i].itemID == "id3") {
          G_Assert(zone, resolved[i].typeID == "bookmark",
                   "Wrong typeID for item id3");

        } else {
          throw new Error("Unexpected itemID " + resolved[i].itemID);
        }
      }
    }

    // Check that the old folder is marked for deletion
    G_Assert(zone, folder1.isRemove, "Old folder not deleted");

    // ******
    // Test #1 for resolvePositionConflict function

    // This is an item for the bookmark we already added to the folder above
    // For this test, pretend that this is the offline item, so it will
    // win the conflict resolution.
    var offlinePositionConflictItem =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "bookmark",
                        itemID: "id1",
                        properties: { parents: "rdf:#$wxyz02",
                                      positions: "1" }});
    // This is a new separator item.
    // For this test, pretend that this is the synced item, so it wlil
    // be moved during conflict resolution.
    var syncedPositionConflictItem =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "separator",
                        itemID: "rdf:#$wxyz02,1",
                        properties: { parents: "rdf:#$wxyz02",
                                      positions: "1" }});
    // This is a convenient way to add the item to our in memory state
    resolver.addDownloadedItem(syncedPositionConflictItem);

    // Resolve the position conflict
    var items = resolver.resolvePositionConflict(syncedPositionConflictItem,
                                                 offlinePositionConflictItem);

    // As a result of the conflict, the synced separator should be pushed up to
    // position 2 and nothing should be shifted, since there is already a
    // separator there with the same id
    G_Assert(this, items.length == 1, "Items shifted unexpectedly");
    G_Assert(this, items[0].itemID == "rdf:#$wxyz02,2",
             "New separator item ID incorrect");
    G_Assert(this, items[0].getProperty("positions") == 2,
             "New separator item has incorrect position");

    G_Assert(this, syncedPositionConflictItem.isRemove == true,
             "Shifted separator not deleted");

    // ******
    // Test #2 for resolvePositionConflict function

    // Setup another item to be shifted
    var clbFolder2 = resolver.getFolder("rdf:#$wxyz02");
    clbFolder2.addBookmark("id4", "bookmark", 4);

    // This is an item for the bookmark we already added to the folder above
    // For this test, pretend that this is the offline item, so it will
    // win the conflict resolution.
    var offlinePositionConflictItem2 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "bookmark",
                        itemID: "id3",
                        properties: { parents: "rdf:#$wxyz02",
                                      positions: "3" }});
    // This is a new separator item - for the purpose of this test, pretend
    // that this is the synced item, so it will be moved during conflict
    // resolution
    var syncedPositionConflictItem2 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "separator",
                        itemID: "rdf:#$wxyz02,3",
                        properties: { parents: "rdf:#$wxyz02",
                                      positions: "3" }});
    // This is a convenient way to add the item to our in memory state
    resolver.addDownloadedItem(syncedPositionConflictItem2);

    // Resolve the position conflict
    items = resolver.resolvePositionConflict(syncedPositionConflictItem2,
                                             offlinePositionConflictItem2);

    // As a result of the conflict, the synced separator should be
    // pushed up to position 4 and the item in position 4 should be shifted
    // out of the way.
    G_Assert(this, items.length == 2, "Incorrect number of shifted items");
    for (var i = 0; i < items.length; i++) {
      if (items[i].itemID == "rdf:#$wxyz02,4") {
        G_Assert(this, items[i].getProperty("parents") == "rdf:#$wxyz02",
                 "Incorrect parent for new separator");
        G_Assert(this, items[i].getProperty("positions") == "4",
                 "Incorrect position for new separator");
      } else if (items[i].itemID == "id4") {
        G_Assert(this, items[i].getProperty("parents") == "rdf:#$wxyz02",
                 "Incorrect parent for shifted bookmark");
        G_Assert(this, items[i].getProperty("positions") == "5",
                 "Incorrect position for shifted bookmark");
      }
    }
    G_Assert(this, syncedPositionConflictItem2.isRemove,
             "Shifted separator 2 not deleted");
    
    // *******
    // Test addItemToFolder and removeItemFromFolder
    var clbFolder3 = resolver.getFolder("rdf:#$wxyz03");
    clbFolder3.setName("folder name");
    clbFolder3.setParent("NC:BookmarksRoot");
    clbFolder3.addBookmark("id1", "bookmark", 1);
    clbFolder3.addBookmark("rdf:#$wxyz03,2", "separator", 2);
    clbFolder3.addBookmark("id3", "bookmark", 3);

    // Add an item without shifting anything
    var bm2 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "bookmark",
                        itemID: "id4",
                        properties: { parents: "rdf:#$wxyz03",
                                      positions: "3" }});
    var shiftedItems = resolver.addItemToFolder(bm2, false);
    G_Assert(zone, shiftedItems.length == 0,
             "Incorrect shifted items when adding bm2 to the folder");

    // Add an item with shifting
    var bm3 =
      new CLB_SyncItem({componentID: CLB_BookmarkSyncer.componentID,
                        typeID: "bookmark",
                        itemID: "id5",
                        properties: { parents: "rdf:#$wxyz03",
                                      positions: "2" }});
    shiftedItems = resolver.addItemToFolder(bm3, true);

    G_Assert(zone, shiftedItems.length == 4,
             "Expected 4 shifted items, instead received " + resolved.length);
    
    for (var i = 0; i < shiftedItems.length; i++) {
      var shiftedItem = shiftedItems[i];

      if (shiftedItem.itemID == "rdf:#$wxyz03,2") {
        G_Assert(zone, shiftedItem.isRemove, "Didn't delete old separator");

      } else if (shiftedItem.itemID == "rdf:#$wxyz03,3") {
        G_Assert(zone, shiftedItem.typeID == "separator",
                 "Separator typeID incorrect");
        G_Assert(zone, shiftedItem.getProperty("parents") == "rdf:#$wxyz03",
                 "Incorrect parent");
        G_Assert(zone, shiftedItem.getProperty("positions") == "3",
                 "Incorrect position");

      } else if (shiftedItem.itemID == "id3") {
        G_Assert(zone, shiftedItem.getProperty("positions") == "4",
                 "Incorrect position for bookmark id3");

      } else if (shiftedItem.itemID == "id4") {
        G_Assert(zone, shiftedItem.getProperty("positions") == "4",
                 "Incorrect position for bookmark id4");

      } else {
        G_Assert(zone, null, "Unexpected itemID " + shiftedItem.itemID);
      }
    }

    // Remove an item with shifting but at a position where there is
    // already another bookmark.  In this case nothing should shift
    shiftedItems = resolver.removeItemFromFolder(bm2, true);
    G_Debug(zone, "items: " + uneval(shiftedItems));
    G_Assert(zone, shiftedItems.length == 0,
             "Items incorrectly shifted when removing bm2");

    // Remove an item with shifting
    shiftedItems = resolver.removeItemFromFolder(bm3, true);

    G_Assert(zone, shiftedItems.length == 3,
             "Expected 3 shifted items, instead received " + resolved.length);
    
    for (var i = 0; i < shiftedItems.length; i++) {
      var shiftedItem = shiftedItems[i];

      if (shiftedItem.itemID == "rdf:#$wxyz03,3") {
        G_Assert(zone, shiftedItem.isRemove, "Didn't delete old separator");

      } else if (shiftedItem.itemID == "rdf:#$wxyz03,2") {
        G_Assert(zone, shiftedItem.typeID == "separator",
                 "Separator typeID incorrect");
        G_Assert(zone, shiftedItem.getProperty("parents") == "rdf:#$wxyz03",
                 "Incorrect parent");
        G_Assert(zone, shiftedItem.getProperty("positions") == "2",
                 "Incorrect position");

      } else if (shiftedItem.itemID == "id3") {
        G_Assert(zone, shiftedItem.getProperty("positions") == "3",
                 "Incorrect position for bookmark id3");

      } else {
        G_Assert(zone, null, "Unexpected itemID " + shiftedItem.itemID);
      }
    }
    
    G_Debug(this, "CLB_BookmarkResolver unittests passed!");
  }

}
