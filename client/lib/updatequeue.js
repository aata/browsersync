// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Encapsulates the state of pending updates. Handles collapsing of dataitems.
 */
function CLB_UpdateQueue() {
  this.reset();
}

CLB_UpdateQueue.smooshItems = function(existingItem, newItem) {
  // Keep track of whether the existingItem is modified by the newItem
  // so that we can return this later
  var itemChanged = false;
  
  // If it has, we need to merge the existing update with the new one.
  if (newItem.isRemove) {
    // Check if the existing item was already set to remove so that the
    // itemChanged value is correct.
    if (!existingItem.isRemove) {
      existingItem.isRemove = true;
      existingItem.clearProperties();
      itemChanged = true;
    }
  } else {
    if (existingItem.isRemove) {
      existingItem.isRemove = false;
      itemChanged = true;
    }
    
    // properties are more straightforward. If the properties object is 
    // specified (not |undefined| or |null|), then we just iterate it's keys
    // and replace existing ones.
    var propNames = newItem.getPropertyNames({});
    
    if (propNames.length) {
      propNames.forEach(function(propName) {
        var propVal = newItem.getProperty(propName);

        if (String(existingItem.getProperty(propName)) != String(propVal)) {
          existingItem.setProperty(propName, propVal);
          itemChanged = true;
        }
      }, this);
    }
  }
  return itemChanged;
}

CLB_UpdateQueue.prototype.replaceItem = function(newItem) {
  this.addItem(newItem, true);
}

CLB_UpdateQueue.prototype.addItem = function(newItem, opt_clobber) {
  // check to see if this item has already been queued to update
  var lookupKey = newItem.makeLookupKey();

  var existingItem = this.pendingLookup[lookupKey];

  // if it hasn't simply add it to the list
  if (!existingItem) {
    this.pendingLookup[lookupKey] = newItem;
  } else {

    // We can optionally clobber existing property values.
    if (opt_clobber) {
      existingItem.clearProperties();
    }

    // Update existing item to match newItem
    CLB_UpdateQueue.smooshItems(existingItem, newItem);
  }
}

CLB_UpdateQueue.prototype.getItemByLookupKey = function(lookupKey) {
  if (isDef(this.pendingLookup[lookupKey])) {
    return this.pendingLookup[lookupKey];
  } else {
    return null;
  }
}

CLB_UpdateQueue.prototype.deleteItemByLookupKey = function(lookupKey) {
  if (lookupKey in this.pendingLookup) {
    delete this.pendingLookup[lookupKey];
  } else {
    G_Debug(this, "Warning: trying to delete nonexistant update queue item " +
            " with lookupKey: " + lookupKey);
  }
}

CLB_UpdateQueue.prototype.hasPending = function() {
  return this.pendingLookup.__count__ > 0;
}

/**
 * Get all items in the queue and return in an array.
 * WARNING: This function is linear in terms of how many items are in the
 * array, so use with caution!!
 */
CLB_UpdateQueue.prototype.getPending = function() {
  var pending = [];
  for (var lookupKey in this.pendingLookup) {
    pending.push(this.pendingLookup[lookupKey]);
  }
  return pending;
}

/**
 * Pop any item out of the update queue, deleting it from the queue.
 */
CLB_UpdateQueue.prototype.popNextItem = function() {
  // This is stupid but it's the only way to get one element out of the
  // associative array.
  var lookupKey;
  var nextItem;
  for (lookupKey in this.pendingLookup) {
    nextItem = this.pendingLookup[lookupKey];
    break;
  }
  delete this.pendingLookup[lookupKey];

  return nextItem;
}

CLB_UpdateQueue.prototype.pendingSize = function() {
  return this.pendingLookup.__count__;
}

CLB_UpdateQueue.prototype.append = function(queue) {
  for (var lookupKey in queue.pendingLookup) {
    this.addItem(queue.getItemByLookupKey(lookupKey));
  }
}

CLB_UpdateQueue.prototype.reset = function() {
  this.pendingLookup = {};
}

CLB_UpdateQueue.debugZone = "CLB_UpdateQueue";
G_debugService.loggifier.loggify(CLB_UpdateQueue.prototype);


// crappy unit tests (tm)
if (CLB_DEBUG) {

  function TEST_CLB_UpdateQueue() {

    var q = new CLB_UpdateQueue();

    var oldItem;
    var newItem;
    var zone = "TEST_CLB_UpdateQueue";

    G_Debug(zone, "Starting CLB_UpdateQueue unit tests...");

    oldItem = new CLB_SyncItem({componentID:"@google.com/test",
                                typeID:"test",
                                itemID:"1",
                                properties: {foo: "bar"}});

    newItem = new CLB_SyncItem({componentID:"@google.com/test",
                                typeID:"test",
                                itemID:"1",
                                properties: {foo:"baz", hot:"dog"}});

    // basic update merging
    G_Debug(zone, "Testing basic updates...");
    
    q.addItem(oldItem);
    q.addItem(newItem);

    G_Assert(zone, q.pendingSize() === 1, "Expected 1 item in queue.");

    G_Assert(zone, q.getItemByLookupKey(newItem.makeLookupKey()) === oldItem,
             "Expected item in queue to be old item.");

    G_Assert(zone, oldItem.getProperty("foo") === "baz",
             "Expected foo property to be merged to 'baz'.");

    G_Assert(zone, oldItem.getProperty("hot") === "dog",
             "Expected hot property to be merged into oldItem.");


    // item removal
    G_Debug(zone, "Testing item removal.");
    
    newItem.isRemove = true;
    q.addItem(newItem);

    G_Assert(zone, q.pendingSize() === 1, "Expected 1 item in queue.");

    G_Assert(zone, oldItem.isRemove === true,
             "Expected isRemove to merge into oldItem.");

    G_Assert(zone, oldItem.getPropertyNames().length === 0,
             "Expected zero properties after item removal.");

    G_Assert(zone, oldItem.hasProperty("foo") === false,
             "Expected 'foo' property to have been removed.");


    // item re-addition
    G_Debug(zone, "Testing item readdition");
    
    newItem.clearProperties();
    newItem.setProperty("foo", "bar");
    newItem.isRemove = false;
    q.addItem(newItem);

    G_Assert(zone, oldItem.isRemove === false,
             "Expected isRemove to be false after readdition.");

    G_Assert(zone, oldItem.getPropertyNames().length == 1,
             "Expected 1 property after item readdition.");

    G_Assert(zone, oldItem.getProperty("foo") === "bar",
             "Expected 'foo' property to be set to 'bar' after readdition.");

    // Item replacement of an existing item
    G_Debug(zone, "Testing item replacement of an existing item");

    newItem.clearProperties();
    newItem.setProperty("a", "b");
    newItem.isRemove = false;
    q.replaceItem(newItem);

    G_Assert(zone, oldItem.isRemove === false,
             "Expected isRemove to be false after replacement.");

    G_Assert(zone, oldItem.getPropertyNames().length == 1,
             "Expected 1 property after item replacement.");

    G_Assert(zone, oldItem.getProperty("a") === "b",
             "Expected 'a' property to be set to 'b' after replacement");

    // Calling replace with a new item to make sure it's added
    var anotherNew = new CLB_SyncItem({componentID:"@google.com/test",
                                       typeID:"test",
                                       itemID:"2",
                                       properties: {b:"c"}});
    q.replaceItem(anotherNew);
    G_Assert(zone, q.pendingSize() == 2,
             "Expected 2 items after calling replace with a new item.");

    G_Assert(zone, anotherNew.isRemove === false,
             "Expected isRemove to be false after replaceItem with new item");

    G_Assert(zone, anotherNew.getPropertyNames().length == 1,
             "Expected 1 property after replaceItem with new item");

    G_Assert(zone, anotherNew.getProperty("b") ==="c",
             "Expected 'b' property to be set to 'c' after replaceItem");

    // Test getPending
    var pending = q.getPending();
    G_Assert(zone, pending.length == 2, "Wrong length for getPending");

    // Test popNextItem function
    G_Debug(zone, "Testing popNextItem");
    
    while (q.pendingSize() != 0) {
      var nextItem =  q.popNextItem();
      var lookupKey = nextItem.makeLookupKey();
      G_Debug(this, "Queue: " + uneval(q));

      if (nextItem.itemID == 1) {
        G_Assert(zone, q.getItemByLookupKey(lookupKey) == null,
                 "Item 1 is still in the queue after retrieving it");

      } else if (nextItem.itemID == 2) {
        G_Assert(zone, q.getItemByLookupKey(lookupKey) == null,
                 "Item 2 is still in the queue after retrieving it");

      } else {
        G_Assert(zone, null, "Unexpected item " + nextItem.itemID +
                 " retrieved from queue");
      }
    }
    
    G_Debug(zone, "All CLB_UpdateQueue unit tests passed!");
  }
  
}
