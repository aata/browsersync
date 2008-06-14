// Copyright (C) 2006 and onwards Google, Inc.
//
// Handles conflict map maintenance and main conflict resolution work.
// The conflict resolver is used by the downloader during a sync
//
// The function that does all the work is resolveConflicts.
// The resolveConflicts function takes a synced item and follows this
// sequence of events:
// 1. smoosh offline item on top of the synced item - if the synced item is
//    a delete and the offline item is an update, we special case this
//    and ask the component to fill in the update, in case it was only
//    a partial update
// 2. Go through each conflict type and see if this item triggers a conflict.
//    If so, call into the component to resolve the conflict.
// 3. Update the conflict maps with the result of conflict resolution
// 4. Update the queues with the result of conflict resolution

function CLB_ConflictResolver(registeredConflicts,
                              componentsHash,
                              sendToServerQueue,
                              applyLocallyQueue) {
  this.initializeRegisteredConflicts(registeredConflicts);
  this.componentsHash_ = componentsHash;
  this.sendToServerQueue_ = sendToServerQueue;
  this.applyLocallyQueue_ = applyLocallyQueue;
}

/**
 * Clone registered conflicts into a member variable so that we don't
 * modify the master copy owned by syncmanager
 */
CLB_ConflictResolver.prototype.initializeRegisteredConflicts =
function(registeredConflicts) {
  
  this.registeredConflicts_ = {};
  for (var componentID in registeredConflicts) {
    var conflicts = registeredConflicts[componentID];
    var clonedConflicts = [];
    
    conflicts.forEach(function(conflict) {
      // This shouldn't actually contain conflict values anyway,
      // since they should be clean copies from syncmanager.  Just to
      // be extra paranoid, clear the values when we clone
      clonedConflicts.push(conflict.cloneWithoutValues());
    }, this);
    
    this.registeredConflicts_[componentID] = clonedConflicts;
  }
}

/**
 * Go through registered conflicts and add this item to the conflict map
 * when the item has all properties specified by the conflict type.  The
 * conflict map is from property values -> lookupKey value.  The item
 * lookup consists of componentID, typeID, and itemID and is used to uniquely
 * identify an item.
 */
CLB_ConflictResolver.prototype.addToConflictMaps = function(item) {
  if (item.isRemove) {
    return;
  }

  var conflicts = this.registeredConflicts_[item.componentID];
  if (isDef(conflicts)) {
    conflicts.forEach(function(conflict) {
    
      var conflictValue = conflict.makeConflictValueString(item);

      if (conflictValue == null) {
        // Print a special error for this case since it should never happen
        G_Debug(this, "Error: Cannot perform conflict resolution on item " +
                item.itemID + " because a partial update contains " +
                "only some of the properties required for conflict" +
                conflict.name);
      } else {
        // Add it to our conflict map for offline offers
        var lookupKey = item.makeLookupKey();
        conflict.addConflictValue(conflictValue, lookupKey);
      }
    }, this);
  }
}


/**
 * Given a list of items that may be updates to items already in the conflict
 * map, make any necessary adjustments to the conflict map.
 * If isUpdate is true, then the new items are just updates to the existing
 * items, otherwise they are replacements to the existing items
 */
CLB_ConflictResolver.prototype.updateConflictMaps = function(items, isUpdate) {
  items.forEach(function(item) {
    var conflicts = this.registeredConflicts_[item.componentID];
    if (isDef(conflicts)) {
      var lookupKey = item.makeLookupKey();
      var oldItem = this.findInLocalOrServerQueue(lookupKey);

      // If no old item exists, or if it was marked for remove then just
      // add the new item
      if (!oldItem || oldItem.isRemove) {
        this.addToConflictMaps(item);
      } else {

        // If is an update, not a replacement to the existing item,
        // smoosh on top of the old item in order to update conflict maps
        // appropriately
        var newItem;
        if (isUpdate) {
          newItem = oldItem.clone();
          CLB_UpdateQueue.smooshItems(newItem, item);
        } else {
          newItem = item;
        }
        
        // Update conflict values for each conflict type
        conflicts.forEach(function(conflict) {
          conflict.updateConflictValues(oldItem, newItem);
        }, this);
      }
    }
  }, this);
}

CLB_ConflictResolver.prototype.maybeDeleteConflictValues = function(oldItem,
                                                                    update) {
  var conflicts = this.registeredConflicts_[oldItem.componentID];
  if (conflicts) {
    conflicts.forEach(function(conflict) {
      conflict.maybeDeleteConflictValues(oldItem, update);
    }, this);
  }
}

/**
 * Check for an item first in the local queue and then in the server queue.
 * Note that the local queue is given priority because it will contain
 * all info about an item, including downloaded changes from server, smooshed
 * with offline changes, plus conflict resolution changes.  However, the
 * server queue may only contain a subset of that information that need
 * to be sent back to the server.  Thus, fall back on the sendToServerQueue
 * only if there is nothing in the local queue (i.e. it may be an offline
 * change)
 */
CLB_ConflictResolver.prototype.findInLocalOrServerQueue = function(lookupKey) {
  var item = this.applyLocallyQueue_.getItemByLookupKey(lookupKey);
  if (item == null) {
    item = this.sendToServerQueue_.getItemByLookupKey(lookupKey);
  }
  // Note that item can be null if it isn't in either queue
  return item;
}

CLB_ConflictResolver.prototype.smooshWithOffline = function(syncedItem) {
  // Keep track of whether the items are equal - we'll return this at the end
  var itemsEqual = false;
  var syncedLookupKey = syncedItem.makeLookupKey();

  var offlineItem = this.sendToServerQueue_.getItemByLookupKey(syncedLookupKey);
  if (offlineItem != null) {
    // If the synced item is a delete request and the offline item is
    // an update, then we need to special case it.  Since the update might
    // be only a partial update, the component must retrieve the whole
    // item, so that the server maintains a full copy of the item.
    // Note that this works with every component that maintains a local
    // store.  For tabsyncing, we don't record offline items so this is ok
    if (syncedItem.isRemove && !offlineItem.isRemove) {

      // Components are allowed to return null if they don't have enough
      // information to provide the item.  In this case, just continue
      // with the item that we have
      var comp = this.componentsHash_[offlineItem.componentID];
      var compItem = comp.getItemByID(offlineItem.itemID, offlineItem.typeID);
      if (!compItem) {
        G_Debug(this, "Warning - component returned null for getItemByID, " + 
                "continuing with an item that might be a partial update");
      } else {

        // Sanity check that the component doesn't return a bogus item
        if (compItem.itemID != offlineItem.itemID ||
            compItem.typeID != offlineItem.typeID) {
          G_Debug(this, "Error, component returned an item with a different " +
                  " id or typeID, continuing with an item that might be " +
                  " a partial update");
        } else {
          offlineItem = compItem;

          // The offline item has already been added to the conflict maps,
          // so be sure to update that before replacing the existing item
          // in the sendToServerQueue
          this.updateConflictMaps([offlineItem], false);
          this.sendToServerQueue_.replaceItem(offlineItem);
        }
      }
    }

    // Smoosh the offline item on top of the synced item - the offline item
    // wins.
    var changed = CLB_UpdateQueue.smooshItems(syncedItem, offlineItem);
    if (!changed) {
      // If the offline item doesn't change anything in the synced item
      // when smooshing, then there is no need to send the offline item
      // to the server.
      this.sendToServerQueue_.deleteItemByLookupKey(syncedLookupKey);

      // If the item didn't change as the result of smooshing, check if
      // the synced and offline item are exactly equal.  In that case,
      // we don't have to apply the synced item locally either.
      if (syncedItem.equals(offlineItem)) {
        itemsEqual = true;
      }
    }
    // TODO: When we revamp the debug logging, add non privacy sensitive
    // logging here to see the item after smooshing
  }
  return itemsEqual;
}

/**
 * For a single item, look for conflicts and call out to components to
 * resolve them.
 */
CLB_ConflictResolver.prototype.resolveItemConflicts = function(syncedItem,
                                                               conflict,
                                                               resolvedItems) {
  var syncedLookupKey = syncedItem.makeLookupKey();
  
  var conflictValue = conflict.makeConflictValueString(syncedItem);
  G_Debug(this, "Conflict: " + conflict.name + " value: " +
          conflictValue);

  // No conflict here, continue to the next rule.
  if (conflictValue == "" || !conflict.hasConflictValue(conflictValue)) {
    return false;
  }

  // print a special error message for this case, since it should
  // never happen.
  if (conflictValue == null) {
    G_Debug(this, "Error: Cannot perform conflict resolution on item " +
            syncedItem.itemID + " because a partial update contains " +
            "only some of the properties required for conflict" +
            conflict.name);
    return false;
  }
          
  // We only need to do conflict resolution if the two items do not
  // have the same ID.  Items of the same ID are permitted to have
  // overlapping values.
  var conflictLookupKey = conflict.getLookupKey(conflictValue);
  if (conflictLookupKey == syncedLookupKey) {
    G_Debug(this, "Skipping conflict on value: " + conflictValue +
            " because items have the same lookupID: " + syncedLookupKey);
    return false;
  }
          
  var conflictItem = this.findInLocalOrServerQueue(conflictLookupKey);
  if (!conflictItem) {
    G_Debug(this, "Error: Could not find item in updateQueue and " +
            "syncQueue for lookup key: " + conflictLookupKey);
    return false;
  }
        
  // This is a real conflict, let the component resolve it.
  var comp = this.componentsHash_[syncedItem.componentID];
  var resolvedEnum = comp.onItemConflict(conflict.name, syncedItem,
                                         conflictItem.clone());
  
  // Sanity check that component did not change lookup key:
  var newLookup = syncedItem.makeLookupKey();
  if (newLookup != syncedLookupKey) {
    G_Debug(this, "Error, component changed syncItem lookup value. " +
            "This should never happen - instead, component should " +
            " return the item with a different ID in the enumerator");
  }
        
  // Add the new resolutions to our list of items to upload.
  // Note that this list of items does not include the actual syncedItem
  while (resolvedEnum.hasMoreElements()) {
    var resolved = resolvedEnum.getNext();
    if (resolved.itemID == syncedItem.itemID) {
      G_Debug(this, "Error: component should not return an update to the " +
              " synced item - it should modify the item directly");
    } else {
      resolvedItems.push(resolved);
    }
  }

  G_Debug(this, "Total items returned for conflict resolution: " +
          resolvedItems.length);
  return true;
}

/**
 * Do the real work of detecting and resolving conflicts.
 */
CLB_ConflictResolver.prototype.resolveConflicts = function(syncedItem,
                                                           isDownloaded) {
  // Look up this item's component
  var comp = this.componentsHash_[syncedItem.componentID];
  
  // Keep track of whether we alter the synced item, since we'll have
  // to send it back to the server if we do.  If this is not a downloaded
  // item, we should always send it back to the server
  var shouldUploadItem = !isDownloaded;
  
  var syncedLookupKey = syncedItem.makeLookupKey();

  if (!isDownloaded) {
    // We already smooshed synced items with offline changes, so only
    // try to smoosh again here if we're dealing with a change that
    // is not downloaded (i.e. it is the result of conflict resolution).
    // Make sure that the conflict resolution change wins
    var previousUpdate = this.findInLocalOrServerQueue(syncedLookupKey);

    if (previousUpdate != null) {
      G_Debug(this, "Found previous update, smooshing");

      // We don't care if the item changes during smooshing - the changes are
      // already accounted for in the queues
      var tmp = previousUpdate.clone();
      CLB_UpdateQueue.smooshItems(tmp, syncedItem);
      syncedItem.updateFrom(tmp);
      // TODO: When we revamp the debug logging, add non privacy sensitive
      // logging here to see the item after smooshing
    }
  }

  // Then check for conflicts in each conflict type for this component.
  var resolvedItems = [];
  var conflicts = this.registeredConflicts_[syncedItem.componentID];
  if (isDef(conflicts)) {
    conflicts.forEach(function(conflict) {

      // Be sure not to clobber the old value in shouldUpdateItem - if
      // it ever changes, for any conflict, we should always update
      var foundConflict = this.resolveItemConflicts(syncedItem, conflict,
                                                    resolvedItems);
      shouldUploadItem = shouldUploadItem || foundConflict;
    }, this);
  }
  
  // Delete conflict values from the map that are invalidated by
  // the new update.
  resolvedItems.forEach(function(itemUpdate) {
    var lookupKey = itemUpdate.makeLookupKey();
    var previousUpdate =
      this.findInLocalOrServerQueue(lookupKey);
    if (!isNull(previousUpdate)) {
      this.maybeDeleteConflictValues(previousUpdate, itemUpdate);
    }
  }, this);

  // Update the conflict maps with the new sync item. This will remove any
  // mappings that are no longer relevant and add the new mappings.
  this.updateConflictMaps([syncedItem], false /* isn't partial update */);
  
  // After conflict resolution, we get a modified version of the
  // syncedItem that no longer conflicts (hopefully).
  // Add it to our server queue, so that the changes are sent back to
  // the server.  Note that we use replace instead of add because we
  // already smooshed the item in the updateQueue on top of the syncedItem.
  if (shouldUploadItem) {
    G_Debug(this, "Uploading the synced item to the server, since it " +
            "changed");
    this.sendToServerQueue_.replaceItem(syncedItem);
  }

  // Return these items to be appended to the end of the sync queue - we'll
  // run another round of conflict resolution on them, in case there were
  // new issues created.  Note that a misbehaved component could create
  // an endless loop here.
  return resolvedItems;
}

CLB_ConflictResolver.prototype.debugZone = "CLB_ConflictResolver";
G_debugService.loggifier.loggify(CLB_ConflictResolver.prototype);


if (CLB_DEBUG) {

  function TEST_CLB_utl_verifyItemProperties(item, id, a, c) {
    var zone = "TEST_CLB_ConflictResolver";
    G_Assert(zone, item.itemID == id, "ItemID incorrect");

    if (!a) {
      G_Assert(zone, !item.hasProperty("a"),
               "Item contains property a: " + item.getProperty("a"));
    } else {
      G_Assert(zone, item.hasProperty("a") && item.getProperty("a") == a,
               "Property a incorrect");
    }

    if (!c) {
      G_Assert(zone, !item.hasProperty("c"),
               "Item contains property c: " + item.getProperty("c"));
    } else {
      G_Assert(zone, item.hasProperty("c") && item.getProperty("c") == c,
               "Property c incorrect");
    }
  }

  function TEST_CLB_ConflictResolver() {
    var zone = "TEST_CLB_ConflictResolver";

    G_Debug(zone, "Starting CLB_ConflictResolver unit tests...");

    // ----------------
    // Test initializeRegisteredConflicts function
    var serverQueue = new CLB_UpdateQueue();
    var localQueue = new CLB_UpdateQueue();
    var conflict1 = new CLB_Conflict("test1", null, [ "a", "c" ]);
    var conflict2 = new CLB_Conflict("test2", null, [ "b", "d" ]);
    
    // Add bogus value to be sure it's cleared in the constructor
    conflict1.addConflictValue("test", "value");
    G_Assert(zone, conflict1.hasConflictValue("test"),
             "Failed to add test conflict value");
    
    var cr = new CLB_ConflictResolver(
      { "@google.com/test" : [ conflict1, conflict2 ] },
      null, serverQueue, localQueue);

    var clonedConfs = cr.registeredConflicts_["@google.com/test"];
    G_Assert(zone, clonedConfs[0].name == "test1", "Name after clone wrong");
    G_Assert(zone, !clonedConfs[0].hasConflictValue("test"),
             "Conflict values not cleared in conflict clone");
    G_Assert(zone, clonedConfs[1].name == "test2", "Name after clone wrong");

    // Reassign the conflict pointers so the rest of the unittests pass
    conflict1 = clonedConfs[0];
    conflict2 = clonedConfs[1];

    // ----------------
    // Test addToConflictMaps function

    // make sure that an isremove item doesn't get added to the conflict
    // map, even if it has valid properties
    var item1 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID1",
                                  isRemove: true,
                                  properties: { a: "aValue",
                                                b: "bValue",
                                                c: "cValue",
                                                d: "dValue" }});
    cr.addToConflictMaps(item1);
    G_Assert(zone,
      !conflict1.hasConflictValue(conflict1.makeConflictValueString(item1)),
      "Added conflict value even when item marked as isRemove");
    G_Assert(zone,
      !conflict2.hasConflictValue(conflict2.makeConflictValueString(item1)),
      "Added conflict value even when item marked as isRemove");

    // check adding values for a regular item
    var item2 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID2",
                                  properties: { a: "aValue",
                                                b: "bValue",
                                                c: "cValue",
                                                d: "dValue" }});
    cr.addToConflictMaps(item2);
    G_Assert(zone,
      conflict1.hasConflictValue(conflict1.makeConflictValueString(item2)),
      "Failed to add conflict1 value for item2 in addToConflictMaps test")
    G_Assert(zone,
      conflict2.hasConflictValue(conflict2.makeConflictValueString(item2)),
      "Failed to add conflict2 value for item2 in addToConflictMaps test");

    // ----------------
    // Test updateConflictMaps function

    // Check that adding an isRemove item properly removes the old values.
    // Put the old item in the queue, since updateConflictMaps looks for it
    // there
    serverQueue.addItem(item2);
    var item2b = new CLB_SyncItem({componentID: "@google.com/test",
                                   itemID: "testID2",
                                   isRemove: true,
                                   properties: { } });
    // Check that adding an item without an existing item in the queue
    // will simply add conflict values
    var item3 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID3",
                                  properties: { a: "aValue2",
                                                c: "cValue2" }});
    cr.updateConflictMaps([ item2b, item3 ], false);

    // Testing results for item2b update
    G_Assert(zone,
      !conflict1.hasConflictValue(conflict1.makeConflictValueString(item2)),
      "Failed to remove conflict value for item2")
    G_Assert(zone,
      !conflict2.hasConflictValue(conflict2.makeConflictValueString(item2)),
      "Added conflict value even when item marked as isRemove");

    // Testing results for item3 update
    G_Assert(zone,
      conflict1.hasConflictValue(conflict1.makeConflictValueString(item3)),
      "Failed to add conflict value for item3");

    // ----------------
    // Test resolveConflicts function
    // test smooshing offline item onto syncedItem so that offline wins
    // test that 2 items with same lookup values can have identical conflict
    //   values
    // Test that the right things are added to update queue.

    // First set up the data structures
    serverQueue = new CLB_UpdateQueue();
    localQueue = new CLB_UpdateQueue();
    conflict1 = new CLB_Conflict("test1", null, [ "a", "c" ]);
    // Initialize the ConflictResolver
    var componentStub = { onItemConflict: function(name, oldItem, newItem) {
      if (oldItem.itemID == "testID5") {
        throw new Error("Should not have called conflict resolution code " +
                        "for item testID5");
      } else if (oldItem.itemID == "testID6b") {
        oldItem.setProperty("a", "notconflicting");
      } else if (oldItem.itemID == "testID7b") {
        oldItem.setProperty("c", "notconflict");
        var resolved = new CLB_SyncItem({componentID: "@google.com/test",
                                         itemID: "testID7",
                                         isRemove: true,
                                         properties: { } });
        return new CLB_ArrayEnumerator([resolved]);
      }
      return new CLB_ArrayEnumerator([]);
    } }
    var cr2 = new CLB_ConflictResolver(
      { "@google.com/test" : [ conflict1 ] },
      { "@google.com/test" : componentStub },
        serverQueue, localQueue);

    clonedConfs = cr2.registeredConflicts_["@google.com/test"];
    G_Assert(this, clonedConfs[0].name == "test1",
             "Incorrect cloned conflict");
    conflict1 = clonedConfs[0];
    
    // ###########
    // test smooshWithOffline
    // Test that if there is an offline item in
    // the serverQueue, it will win when smooshed with a synced item.
    var offlineItem4 = new CLB_SyncItem({componentID: "@google.com/test",
                                         itemID: "testID4",
                                         properties: { a: "offline4A",
                                                       c: "offline4C" }});
    var syncedItem4 = new CLB_SyncItem({componentID: "@google.com/test",
                                        itemID: "testID4",
                                        properties: { a: "synced4bA",
                                                      c: "synced4bC" }});

    // First add offlineItem4 to the serverQueue and create conflict values
    cr2.addToConflictMaps(offlineItem4);
    serverQueue.addItem(offlineItem4);
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(offlineItem4)),
      "Conflict value not added for offlineItem4");

    // Now resolve syncedItem4 with offlineItem4
    cr2.smooshWithOffline(syncedItem4);

    // End result should be that items get smooshed together, and the offline
    // values win
    
    // Make sure the conflict values remain correct
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(offlineItem4)),
      "Conflict value removed for offlineItem4");

    // Make sure the queues are updated properly
    G_Assert(zone, serverQueue.pendingSize() == 1,
             "Wrong server queue length");
    var serverItem =  serverQueue.getItemByLookupKey(
        offlineItem4.makeLookupKey());
    // Offline properties should win
    TEST_CLB_utl_verifyItemProperties(serverItem, "testID4",
                                      "offline4A", "offline4C");

    // Downloader adds the synced item to the queue so just check the
    // values in syncedItem4 directly.
    G_Assert(zone, localQueue.pendingSize() == 0,
             "Wrong local queue length - " + localQueue.pendingSize() +
             " instead of 0");
    // Offline properties should win
    TEST_CLB_utl_verifyItemProperties(syncedItem4, "testID4",
                                      "offline4A", "offline4C")

    // ###########
    // resolveConflicts test#2
    // Test that items with the same id and
    // conflict values will not cause any conflict resolution
    var offlineItem5 = new CLB_SyncItem({componentID: "@google.com/test",
                                         itemID: "testID5",
                                         properties: { a: "5A",
                                                       c: "5C" }});
    var syncedItem5 = new CLB_SyncItem({componentID: "@google.com/test",
                                        itemID: "testID5",
                                        properties: { a: "5A",
                                                      c: "5C" }});

    // First add offlineItem5 to the serverQueue and create conflict values
    cr2.addToConflictMaps(offlineItem5);
    serverQueue.addItem(offlineItem5);
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(offlineItem5)),
      "Conflict value not added for offlineItem5");

    // Now resolve syncedItem5 with offlineItem5. The onItemConflict
    // function will throw if it's called.
    cr2.resolveConflicts(syncedItem5, true);

    // make sure that queues were updated properly.
        G_Assert(zone, serverQueue.pendingSize() == 2,
             "Wrong server queue length");
    serverItem =  serverQueue.getItemByLookupKey(offlineItem5.makeLookupKey());
    // No change in property values
    TEST_CLB_utl_verifyItemProperties(serverItem, "testID5", "5A", "5C")

    // Downloader adds the synced item to the queue so just check the
    // values in syncedItem5 directly.
    G_Assert(zone, localQueue.pendingSize() == 0,
             "Wrong local queue length - " + localQueue.pendingSize() +
             " instead of 0");
    // No change in property values
    TEST_CLB_utl_verifyItemProperties(syncedItem5, "testID5", "5A", "5C")

    // ############
    // resolveConflicts test #3
    // This will be used to test that a valid conflict is resolved
    var offlineItem6 = new CLB_SyncItem({componentID: "@google.com/test",
                                         itemID: "testID6",
                                         properties: { a: "conflicting",
                                                       c: "value" }});
    var syncedItem6b = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID6b",
                                  properties: { a: "conflicting",
                                                c: "value" }});

    // First add offlineItem6 to the serverQueue and create conflict values
    cr2.addToConflictMaps(offlineItem6);
    serverQueue.addItem(offlineItem6);
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(offlineItem6)),
      "Conflict value not added for offlineItem6");

    // Now resolve syncedItem6b with offlineItem6
    cr2.resolveConflicts(syncedItem6b, true);

    // Check that the conflict values were updated properly
    G_Assert(zone,
             syncedItem6b.hasProperty("a") &&
             syncedItem6b.getProperty("a") == "notconflicting",
             "Did not update property for conflict resolution");
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(offlineItem6)),
      "Failed to update conflict value for offlineItem6 after resolution");
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(syncedItem6b)),
      "Failed to add conflict value for syncedItem6b");

    // make sure that queues were updated properly.
    // Both the offline item and the synced item were added to the server
    // queue, so that brings the total length to 4
    G_Assert(zone, serverQueue.pendingSize() == 4,
             "Wrong server queue length");

    // Offline item wins, so values remain the same
    serverItem =  serverQueue.getItemByLookupKey(offlineItem6.makeLookupKey());
    TEST_CLB_utl_verifyItemProperties(serverItem, "testID6",
                                      "conflicting", "value")

    // Downloader adds the synced item to the local queue so it will still
    // be empty at this point
    G_Assert(zone, localQueue.pendingSize() == 0,
             "Wrong local queue length");

    // The synced Item should have been updated to not conflict with
    // the offline item.  Since the syncedItem changed, it should be in
    // the queue to send back to the server
    var serverItem2 =  serverQueue.getItemByLookupKey(
        syncedItem6b.makeLookupKey());
    TEST_CLB_utl_verifyItemProperties(serverItem2, "testID6b",
                                      "notconflicting", "value")

    // ########
    // resolveConflicts test#4
    // This will test that a synced item with no conflict
    // initially still triggers conflict resolution later.
    // Also, we'll test that a conflict resolution returned as
    // a separate item works here as well.
    var syncedItem7 = new CLB_SyncItem({componentID: "@google.com/test",
                                         itemID: "testID7",
                                         properties: { a: "another",
                                                       c: "conflict" }});
    var syncedItem7b = new CLB_SyncItem({componentID: "@google.com/test",
                                        itemID: "testID7b",
                                        properties: { a: "another",
                                                      c: "conflict" }});

    // First add syncedItem7 to the applyLocallyQueue (it's a previously
    // synced item) and create conflict values
    cr2.addToConflictMaps(syncedItem7);
    localQueue.addItem(syncedItem7);
    var syncedItem7ConflictValue =
      conflict1.makeConflictValueString(syncedItem7);
    G_Assert(zone, conflict1.hasConflictValue(syncedItem7ConflictValue),
             "Conflict value not added for syncedItem7");

    // Now resolve syncedItem7b with syncedItem7
    var resolvedItems = cr2.resolveConflicts(syncedItem7b, true);

    // The end result should be that syncedItem7 is marked for remove
    // and syncedItem7b has property c changed to "notconflict"

    // Make sure the new syncedItem7b conflict value got added
    G_Assert(zone,
      conflict1.hasConflictValue(
          conflict1.makeConflictValueString(syncedItem7b)),
      "Failed to add conflict value for syncedItem7b");

    // Make sure that a deletion was returned as a resolved item.
    G_Assert(zone, resolvedItems.length == 1,
             "More than 1 resolved item returned");
    G_Assert(zone, resolvedItems[0].componentID == "@google.com/test" &&
             resolvedItems[0].itemID == "testID7" &&
             resolvedItems[0].isRemove == true,
             "Item testID7 not remove as a result of conflict resolution");
    
    // make sure that queues were updated properly.
    // synced item should have been added to the send to server queue,
    // bringing total length up to 5
    G_Assert(zone, serverQueue.pendingSize() == 5,
             "Wrong server queue length");

    // The synced item should have had a property changed
    serverItem2 =  serverQueue.getItemByLookupKey(
        syncedItem7b.makeLookupKey());
    TEST_CLB_utl_verifyItemProperties(serverItem2, "testID7b",
                                      "another", "notconflict");
    
    G_Debug(zone, "CLB_ConflictResolver unit tests passed!");
  }
}
