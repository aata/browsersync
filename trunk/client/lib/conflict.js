// Copyright (C) 2006 and onwards Google, Inc.
//
// Holds information related to a particular conflict rule, including the
// name of the conflict, the item properties used to detect a conflict,
// and a map from property values -> item identifiers used to quickly
// lookup a potential conflict.

CLB_Conflict.CONFLICT_VALUE_SEPARATOR = ",";

function CLB_Conflict(name, typeID, props) {
  // Name of the conflict, passed to resolveConflict, so that the component
  // knows which type of conflict it is trying to resolve
  this.name = name;

  // The typeID that this conflict applies to.  This can be null, to indicate
  // that all typeIDs apply.
  this.typeID = typeID;
  
  // The property values that should be used to detect a conflict
  this.props_ = props;

  // map from property values -> item lookup (componentID/typeID/itemID)
  this.conflictValues_ = {};
}

CLB_Conflict.prototype.cloneWithoutValues = function() {
  return new CLB_Conflict(this.name, this.typeID, this.props_);
}

/**
 * Given an item, create a conflict value string based on the 
 * properties specified in the props array.  If any required property
 * is missing from the item, then return the empty string
 */
CLB_Conflict.prototype.makeConflictValueString = function(item) {
  if (item.isRemove) {
    return "";
  }

  // If this conflict has a particular typeID specified, only calculate
  // a conflict string if this item is the same typeID.
  if (this.typeID != null &&
      (!isDef(item.typeID) || this.typeID != item.typeID)) {
    return "";
  }
  
  var missingProp = false;
  var valueArray = [];
  for (var i = 0; i < this.props_.length; i++) {
    var prop = this.props_[i];
    if (!item.hasProperty(prop)) {
      missingProp = true;
      G_Debug(this, "Warning: item " + item.itemID + " doesn't have prop " +
              prop + " needed for conflict resolution");
    } else {
      valueArray.push(item.getProperty(prop));
    }
  }

  // In the case that only some of the properties necessary to make the
  // value are present, return null
  if (missingProp && parseInt(valueArray.length) > 0) {
    G_Debug(this, "Error: cannot create conflict string for item " +
            item.itemID + " because only some required fields are present.");
    return null;
  }

  // Note that this could return the empty string, if no relevant properties
  // are in the item.
  return valueArray.join(CLB_Conflict.CONFLICT_VALUE_SEPARATOR);
}

/**
 * Add conflictValue -> lookupKey to our conflict value hash
 */
CLB_Conflict.prototype.addConflictValue = function(conflictValue, lookupKey) {
  if (conflictValue == "" || isNull(conflictValue)) {
    return;
  }

  if (isDef(this.conflictValues_[conflictValue]) &&
      this.conflictValues_[conflictValue] != lookupKey) {
    G_Debug(this, "Error: same conflict value: " + conflictValue +
            " found for " + lookupKey +
            " and " + this.conflictValues_[conflictValue]);
    return;
  }

  this.conflictValues_[conflictValue] = lookupKey;
}

CLB_Conflict.prototype.removeConflictValue = function(conflictValue,
                                                      lookupKey) {
  if (conflictValue == "" || isNull(conflictValue)) {
    return;
  }

  if (isDef(this.conflictValues_[conflictValue]) &&
      this.conflictValues_[conflictValue] == lookupKey) {
    delete this.conflictValues_[conflictValue];
  } else {
    G_Debug(this, "Warning: trying to delete a conflict value that does " +
            "not exist for conflict " + this.name);
  }
}

/**
 * Given an oldItem that was already added to the conflict values,
 * update the conflict values given the new item
 */
CLB_Conflict.prototype.updateConflictValues = function(oldItem, newItem) {
  var lookupKey = oldItem.makeLookupKey();
  var newLookupKey = newItem.makeLookupKey();

  if (lookupKey != newLookupKey) {
    G_Debug(this, "Error: cannot update conflict values for two different " +
            "items: " + lookupKey + " and " + newLookupKey);
    return;
  }

  var oldConflictValue = this.makeConflictValueString(oldItem);
  var conflictValue = this.makeConflictValueString(newItem);
          
  // If the new item is marked for deletion, then just make sure
  // the conflict value is removed
  if (newItem.isRemove) {
    this.removeConflictValue(oldConflictValue, lookupKey);
  } else {
    // Otherwise check and adjust any property differences
    if (oldConflictValue != conflictValue) {
      this.removeConflictValue(oldConflictValue, lookupKey);
      this.addConflictValue(conflictValue, lookupKey);
    }
  }
}

/**
 * Given an update to an old item, if the update contains a valid
 * conflict value, remove the old conflict value from the map.
 * This is used when an update is returned as the result of conflict
 * resolution, but the item has not yet been processed.  In that case,
 * we don't want the old conflict value to sit around and create
 * bogus conflicts.
 */
CLB_Conflict.prototype.maybeDeleteConflictValues = function(oldItem,
                                                            newUpdate) {
  var conflictValue = this.makeConflictValueString(newUpdate);
  if (newUpdate.isRemove || (!isNull(conflictValue) && conflictValue != "")) {
    var oldConflictValue = this.makeConflictValueString(oldItem);
    var lookupKey = oldItem.makeLookupKey();
    this.removeConflictValue(oldConflictValue, lookupKey);

    G_Debug(this, "New conflict value: " + conflictValue);
    G_Debug(this, "Removed conflict value: " + oldConflictValue);
  }
}

CLB_Conflict.prototype.hasConflictValue = function(conflictValue) {
  return isDef(this.conflictValues_[conflictValue]);
}

CLB_Conflict.prototype.getLookupKey = function(conflictValue) {
  return this.conflictValues_[conflictValue];
}

if (CLB_DEBUG) {

  function TEST_CLB_Conflict() {
    var zone = "TEST_CLB_Conflict";

    G_Debug(zone, "Starting CLB_Conflict unit tests...");

    // ----------------
    // Test makeConflictValueString function
    var conflict1 = new CLB_Conflict("test", null, [ "a", "c", "d" ]);
    var item1 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID1",
                                  properties: { a: "aValue",
                                                b: "bValue",
                                                c: "cValue",
                                                d: "dValue" }});

    var item1conf = conflict1.makeConflictValueString(item1);
    G_Assert(zone, item1conf == "aValue,cValue,dValue",
             "Conflict value for item1 is incorrect: " + item1conf);

    // Check a conflict value that doesn't have all the fields
    // required to form a conflict value
    var item2 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID2",
                                  properties: { a: "aValue",
                                                b: "bValue" }});
    var item2conf = conflict1.makeConflictValueString(item2);
    G_Assert(zone, item2conf == null,
             "Conflict value for item2 is incorrect: " + item2conf);

    // Check a conflict value that doesn't have any of the fields
    // required to form a conflict value
    var item3 = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID2",
                                  properties: { b: "bValue" }});
    var item3conf = conflict1.makeConflictValueString(item3);
    G_Assert(zone, item3conf == "",
             "Conflict value for item3 is incorrect: " + item3conf);

    // ----------------
    // Test addConflictValue function
    conflict1.addConflictValue(item1conf, "a");
    G_Assert(zone, conflict1.hasConflictValue(item1conf),
             "Does not have conflict value for " + item1conf +
             " which we just added");

    // make sure it doesn't clobber an existing value
    conflict1.addConflictValue(item1conf, "b");
    G_Assert(zone, conflict1.hasConflictValue(item1conf),
             "Does not have conflict value for " + item1conf +
             " which we added before");
    G_Assert(zone, conflict1.getLookupKey(item1conf) == "a",
             "Clobbered old item lookup key with new conflict value");

    // ----------------
    // Test removeConflictValue function
    conflict1.removeConflictValue(item1conf, "a");
    G_Assert(zone, !conflict1.hasConflictValue(item1conf),
             "Should have removed conflict value " + item1conf);

    // ----------------
    // Test updateConflictValues function

    // Updating from item1 to item1b will replace with item1b conflict value
    var item1b = new CLB_SyncItem({componentID: "@google.com/test",
                                  itemID: "testID1",
                                  properties: { a: "aValue2",
                                                b: "bValue2",
                                                c: "cValue2",
                                                d: "dValue2" }});
    conflict1.updateConflictValues(item1, item1b);
    G_Assert(zone,
      !conflict1.hasConflictValue(conflict1.makeConflictValueString(item1)),
      "Failed to  remove conflict value");
    G_Assert(zone,
      conflict1.hasConflictValue(conflict1.makeConflictValueString(item1b)),
      "Failed to update with new conflict value");

    // Updating to item1c should clear conflict value from map.
    var item1c = new CLB_SyncItem({componentID: "@google.com/test",
                                   itemID: "testID1",
                                   isRemove: true,
                                   properties: { a: "aValue3",
                                                 b: "bValue3",
                                                 c: "cValue3",
                                                 d: "dValue3" } });
    conflict1.updateConflictValues(item1b, item1c);
    G_Assert(zone,
      !conflict1.hasConflictValue(conflict1.makeConflictValueString(item1b)),
      "Failed to remove old conflict value");
    G_Assert(zone,
      !conflict1.hasConflictValue(conflict1.makeConflictValueString(item1c)),
      "Erroneous add of new conflict value");
  }
}
