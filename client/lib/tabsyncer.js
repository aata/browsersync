// Copyright (C) 2005 and onwards Google, Inc.

/**
 * CLB_TabSyncer - Sync Component responsible for storing tab and window
 * state.
 *
 * The recorded state is separated into two types: "tab" and "window".
 * Each type has a unique ID space.
 * For details on the  format of sync items, see the design doc.
 *
 * The work of synchronizing tabs is really divided into three separate classes
 * of which this is just the one which interacts with syncmanager. They are:
 *
 * - BrowserOverlay: 
 *   Uses G_TabbedBrowserWatcher to catch event such as tab opens/closes and
 *   forwards them onto CLB_TabSyncer. We do it this way since we can reuse
 *   the G_TabbedBrowserWatcher which BrowserOverlay already has to create for
 *   other reasons, and because this way it's easy to manage the watcher and
 *   event listener lifetimes (they die with the browser window dies).
 *
 * - TabSyncer:
 *   This class. Fulfills GISyncComponent. Massages the events sent to it by
 *   BrowserOverlay and creates the necessary syncitems to send to syncman.
 *   In onItemAvailable, received items are forwarded directly to 
 *   RestoreTabsUI. 
 *
 * - RestoreTabsUI:
 *   Displays the UI which allows the user to choose the tabs to restore.
 */

function CLB_TabSyncer() {
  bindMethods(this);

  this.winMed_ = Cc["@mozilla.org/appshell/window-mediator;1"]
                 .getService(Ci.nsIWindowMediator);

  // Keeps track of the next available number used to create itemIDs.
  this.nextID_ = 1;

  // This is true after syncman calls start() -- which is when components should
  // synchronize state.
  this.started_ = false;

  // Used to avoid processing items during a sync. We don't want to do this 
  // because the IDs we might use could conflict with IDs we're downloading. We
  // initialize to true because there is some tabsyncer activity that happens 
  // even before the first syncStart and we don't want to process that either.
  this.syncing_ = true;

  // We keep a reference to all downloaded items here so that we can send
  // removes for them in start().
  this.syncedItems_ = [];

  // On window unload, instead of sending the unloaded windows and tabs to the
  // server immediately, we queue then for UNLOAD_QUEUE_SECONDS. When the timer 
  // expires, we send the queued updates as normal. But, if another window is 
  // unload before the timer elapses, we reset the timer for 
  // UNLOAD_QUEUE_SECONDS again. The point of all this is to make sure that
  // users don't inadvertently erase all their window state by closing windows
  // when they are done with the browser.
  this.queuedUnload_ = null;

  CLB_syncMan.addObserver(this);
}

CLB_TabSyncer.prototype.priority = 0;

/**
 * The number of seconds to wait before syncing a window.unload event. If 
 * another window.unload occurs before this time is elapsed, then we start 
 * counting at zero again. If we ever get to zero, then we sync the unloaded 
 * window.
 *
 * We need to wait because users typically quit the browser by closing all 
 * windows, not using the Quit function. So if we just blindly sync windows when 
 * they close, you'd always end up with just one window synced -- the last one.
 *
 * BTW, this number was derived through the extremely scientific process of 
 * watching Susan close all her windows and counting how long it typically took.
 * Keep in mind that this also includes the time to dismiss the "are you sure
 * you want to close 10 tabs?" dialog. We might need to fine-tune this if there
 * are users that take longer between closing one window and the next.
 */
CLB_TabSyncer.UNLOAD_QUEUE_SECONDS = 15;

// GISyncComponent
CLB_TabSyncer.prototype.componentID = 
  "@google.com/browserstate/tab-syncer;1";
CLB_TabSyncer.prototype.componentName = "Tabs and Windows";
CLB_TabSyncer.prototype.encryptionRequred = false;
CLB_TabSyncer.prototype.syncOfflineChanges = false;
CLB_TabSyncer.prototype.syncBehavior =
  Ci.GISyncComponent.SYNC_SINCE_LAST_SYNC;

// Unused GISyncObserver methods
CLB_TabSyncer.prototype.updateStart = 
CLB_TabSyncer.prototype.updateProgress =
CLB_TabSyncer.prototype.updateComplete =
CLB_TabSyncer.prototype.updateFailure =
CLB_TabSyncer.prototype.syncProgress = function() {
  // NOP
}

/**
 * Start the tab syncer
 *
 * @see GISyncComponent#start
 */
CLB_TabSyncer.prototype.start = function() {
  this.started_ = true;
}

/**
 * Syncman has notified us that sync is starting.
 */
CLB_TabSyncer.prototype.syncStart = function() {
  this.syncing_ = true;
}

/**
 * Syncman has notified us that sync failed.
 */
CLB_TabSyncer.prototype.syncFailure = function() {
  this.syncing_ = false;
}

/**
 * Syncman has notified us that sync completed.
 */
CLB_TabSyncer.prototype.syncComplete = function() {
  var initialTabs = this.getCurrentItems(true /* clear old IDs */);

  // TODO(aa): It might be nice to queue these first updates for a little
  // while. That would probably be done in the syncman or someplace like
  // that however, at the same time that the bubble goes away.
  G_Debug(this, "Sending remove items for tabsyncer to syncman.");
  if (this.syncedItems_) {
    for (var i = 0, syncedItem; syncedItem = this.syncedItems_[i]; i++) {
      CLB_syncMan.update(new CLB_SyncItem({
        componentID: syncedItem.componentID,
        typeID: syncedItem.typeID,
        itemID: syncedItem.itemID,
        isRemove: true }));
    }

    // Reinitialize for the next sync
    this.syncedItems_ = [];
  }

  var updateItem;
  while (updateItem = initialTabs.getNext()) {
    G_Debug(this, "Sending update item to syncman: " + updateItem);
    CLB_syncMan.update(updateItem);
  }

  this.syncing_ = false;
}

/**
 * Stops the tab syncer
 *
 * @see GISyncComponent#stop
 */
CLB_TabSyncer.prototype.stop = function() {
  this.started_ = false;
}


/**
 * Called by downloader when an tabsyncer item should be applied to the local
 * datastore. In our case, that means handing the item to the restore UI to 
 * display to the user.
 */
CLB_TabSyncer.prototype.onBeforeResolveConflict = function(item) {
  G_Debug(this, "onItemAvailable - item: " + item);

  if (!isDef(item.itemID) || !isDef(item.typeID) || !isDef(item.componentID)) {
    G_DebugL(this,
             "ERROR: Skipping malformed item. " +
             "itemID: {%s}, typeID: {%s}, componentID: {%s}"
             .subs(item.itemID, item.typeID, item.componentID));
    return;
  }

  // It doesn't really make sense to have a delete item for windows/tabs
  // on startup.  All delete items should have been collapsed with server
  // state
  if (item.isRemove) {
    G_Debug(this, "WARNING: Skipping delete item: " + item);
    return;
  }

  if (item.typeID == "window") {
    CLB_RestoreTabsUI.addWindowItem(item);
  } else if (item.typeID == "tab") {
    CLB_RestoreTabsUI.addTabItem(item);
  } else {
    G_DebugL(this, "Skipping item with unexpected {%s}".subs(item.typeID));
    return;
  }
  
  this.syncedItems_.push(item);
  this.updateID_(item.itemID);
}

/**
 * Called by syncMan when a tab is available (post conflict-resolution), not
 * used.
 */
CLB_TabSyncer.prototype.onItemAvailable = function(item) {
  // nop
}

/**
 * Called by syncman when two items conflict according to the conflict rules
 * the component specifies. Since we don't specify any conflict rules this 
 * method is not used.
 */
CLB_TabSyncer.prototype.onItemConflict = function(conflict, oldItem,
                                                  newItem) {
  return new CLB_ArrayEnumerator([]);
}


CLB_TabSyncer.prototype.getItemByID = function(id, typeid) {
  // Should never call this function - tabsyncer doesn't record offline items
  return null;
}

/**
 * Required by GISyncComponent.
 */
CLB_TabSyncer.prototype.getCurrentItems = function(opt_resetIDs) {
  var result = [];
  var winEnum = this.winMed_.getEnumerator("navigator:browser");

  while (winEnum.hasMoreElements()) {
    var win = winEnum.getNext();
    
    // This should win me some sort of prize:
    var xulWin = win.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShellTreeItem)
                    .treeOwner
                    .QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIXULWindow);

    if (opt_resetIDs || !isDef(win.__winID)) {
      // the window is new, assign it an ID
      win.__winID = this.getNextID_();
    }

    var newItem = new CLB_SyncItem({
        componentID: this.componentID,
        typeID: "window",
        itemID: win.__winID,
        properties: {
          topWindow: (xulWin.zLevel == Ci.nsIXULWindow.highestZ)}});

    result.push(newItem);

    // now walk the tabs
    var tab;
    var tabBrowser = win.document.getElementById("content");
    for (var tabIndex = 0; tab = tabBrowser.browsers[tabIndex]; tabIndex++) {
      G_Debug(this, "checking tabID: " + tab.__tabID);

      if (opt_resetIDs || !isDef(tab.__tabID)) {
        tab.__tabID = this.getNextID_();
      }

      var newItem =
        new CLB_SyncItem({componentID: this.componentID,
                          typeID: "tab",
                          itemID: tab.__tabID,
                          properties: {url: tab.contentWindow.location.href,
                                       title: tab.contentDocument.title,
                                       tabIndex: tabIndex,
                                       activeTab: 
                                         tabBrowser.selectedBrowser == tab,
                                       windowID: win.__winID}});

      result.push(newItem);
    }
  }

  return new CLB_ArrayEnumerator(result);
}

/**
 * Called by browseroverlay when a browser window has loaded. Create a syncitem
 * and send to syncman.
 */
CLB_TabSyncer.prototype.onLoad = function(win) {
  G_Debug(this, "Received onload event for win {%s}".subs(win.__winID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  if (isDef(win.__winID)) {
    G_Debug(this, "Window already created with winID {%s}. Ignoring."
                  .subs(win.__winID));
    return;
  }

  win.__winID = this.getNextID_();

  var syncItem = new CLB_SyncItem({componentID: this.componentID,
                                   typeID: "window",
                                   itemID: win.__winID});

  G_Debug(this, "Sending new window item to syncman: " + syncItem);
  CLB_syncMan.update(syncItem);

  // The first tabloads are actually fired way before the window's onload, which
  // means its before we hook up the event handler which records it. So we make
  // sure it got recorded now.
  var tabBrowser = win.document.getElementById("content");
  if (tabBrowser) {
    for (var i = 0, browser; browser = tabBrowser.browsers[i]; i++) {
      this.createTab_(win, browser,
                      tabBrowser.selectedBrowser == browser /* selected */,
                      i /* position */);
    }
  } else {
    G_Debug(this, "ERROR: Could not get first browser.");
  }
}

/**
 * Helper to record a syncitem for tab creation if it hasn't already been done.
 */
CLB_TabSyncer.prototype.ensureTabCreated_ = function(win, browser, isSelected) {
  if (isDef(browser.__tabID)) {
    G_Debug(this, "Tab already created with tabID {%s}. Ignoring."
                  .subs(browser.__tabID));
    return false;
  }

  if (!isDef(win.__winID)) {
    G_Debug(this, "ERROR: Could not get winID from window. Ignoring.");
    return false;
  }

  var tabPos = CLB_TabSyncer.findBrowserPosition(win, browser);
  if (tabPos == -1) {
    G_Debug(this, "ERROR: Could not find position of tab. Ignoring.");
    return false;
  }

  this.createTab_(win, browser, isSelected, tabPos);
}

/**
 * Helper to record a sync item for tab creation.
 */
CLB_TabSyncer.prototype.createTab_ = function(win, browser, isSelected,
                                              tabPos) {
  browser.__tabID = this.getNextID_();
  G_Debug(this, "Assigned ID {%s} to new tab".subs(browser.__tabID));

  var syncItem = new CLB_SyncItem({componentID: this.componentID,
                                   typeID: "tab",
                                   itemID: browser.__tabID});

  syncItem.setProperty("tabIndex", tabPos);
  syncItem.setProperty("activeTab", isSelected);
  syncItem.setProperty("windowID", win.__winID);

  G_Debug(this, "Sending new tab item to syncman: " + syncItem);
  CLB_syncMan.update(syncItem);

  return true;
}

/**
 * Called by browseroverlay when a new tab is created. 
 */
CLB_TabSyncer.prototype.onTabLoad = function(win, ev) {
  G_Debug(this, "tabload for window {%s}.".subs(win.__winID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  this.ensureTabCreated_(win, ev.browser, ev.isSelected);
}

/**
 * Called by browseroverlay when a tab is closed. 
 */
CLB_TabSyncer.prototype.onTabUnload = function(win, ev) {
  G_Debug(this, "tabunload for tab {%s}".subs(ev.browser.__tabID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  var browser = ev.browser;

  if (!isDef(browser.__tabID)) {
    G_Debug(this, "ERROR: Could not find tabID for unloaded tab.");
    return;
  }

  // Make a note to ourselves that this browser is unloading. This is used in
  // tabswitch to prevent us from recording the a tabswitch in that case.
  browser.__isUnloading = true;

  var syncItem = new CLB_SyncItem({componentID: this.componentID,
                                   typeID: "tab",
                                   itemID: browser.__tabID,
                                   isRemove: true});

  G_Debug(this, "Sending remove tab item to syncman: " + syncItem);

  CLB_syncMan.update(syncItem);

  // If the closed tab was in the middle (eg, not the last tab), then we need to
  // reset the positions of all the tabs which followed it down one spot, since
  // they fill the closed tab's gap.
  //
  // However, we cannot get the tab's position here since it has already been
  // removed from the tabbrowser, so we just reset all of them.
  //
  // Another option we could consider is to get the position of the toBrowser
  // in onTabSwitch in the unload case and use that at the start index to reset.
  // Not doing that now because that would create coupling between onTabSwitch
  // and onTabUnload which would be hard to remember/maintain.
  G_Debug(this, "Resetting all tab indicies");
  var tabBrowser = win.document.getElementById("content");
  this.resetTabIndicies_(tabBrowser, 0, tabBrowser.browsers.length - 1);
}

/**
 * Called by browseroverlay when url is shown in a tab. We record the new URL
 * and title.
 */
CLB_TabSyncer.prototype.onPageShow = function(win, ev) {
  G_Debug(this, "pageshow for tab {%s}".subs(ev.browser.__tabID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  if (!ev.isTop) {
    G_Debug(this, "Skipping pageshow for non-top content window.");
    return;
  }

  var browser = ev.browser;

  if (!isDef(browser.__tabID)) {
    G_Debug(this, "ERROR: Could not find tabID for pageshow in tab.");
    return;
  }

  var syncItem = new CLB_SyncItem({componentID: this.componentID,
                                   typeID: "tab",
                                   itemID: browser.__tabID});

  syncItem.setProperty("url", browser.contentWindow.location.href);
  syncItem.setProperty("title", browser.contentWindow.document.title);

  G_Debug(this, "Sending pageshow item to syncman: " + syncItem);
  CLB_syncMan.update(syncItem);
}

/**
 * Called by browseroverlay when we switch tabs. We record the change in 
 * activeTab for the old and new tab. When tabswitch is occuring because a tab
 * was closed, we don't record the change for the old tab, since that would 
 * recreate it. When tabswitch is called because a new tab was opened, we don't
 * record the change for the new tab since that was already done in the tabload
 * event.
 */
CLB_TabSyncer.prototype.onTabSwitch = function(win, ev) {
  G_Debug(this, "tabswitch from tab {%s} to tab {%s}"
                .subs(ev.fromBrowser.__tabID, ev.toBrowser.__tabID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  // When you create a new tab in the browser, tabswitch gets called before
  // tabload. So we make sure that it is created here.
  var toTabIsNew = this.ensureTabCreated_(win, 
                                          ev.toBrowser, 
                                          true /* is selected */);

  if (!isDef(ev.fromBrowser.__tabID)) {
    G_Debug(this, "Could not get tabID from fromBrowser. Ignoring.");
    return;
  }

  if (!isDef(ev.toBrowser.__tabID)) {
    G_Debug(this, "Could not get tabID from toBrowser. Ignoring.");
    return;
  }

  // If this tab wasn't just unloaded, record that it was switched away from.
  // See onTabUnload, above.
  if (!ev.fromBrowser.__isUnloading) {
    var syncItem1 = new CLB_SyncItem({componentID: this.componentID,
                                      typeID: "tab",
                                      itemID: ev.fromBrowser.__tabID});
    syncItem1.setProperty("activeTab", false);
    G_Debug(this, "Sending tabswitch item for fromBrowser: " + syncItem1);
    CLB_syncMan.update(syncItem1);
  }

  // If this tab wasn't just created, record that it was switched into.
  if (!toTabIsNew) {
    var syncItem2 = new CLB_SyncItem({componentID: this.componentID,
                                      typeID: "tab",
                                      itemID: ev.toBrowser.__tabID});
    syncItem2.setProperty("activeTab", true);
    G_Debug(this, "Sending tabswitch item for toBrowser: " + syncItem2);
    CLB_syncMan.update(syncItem2);
  }
}

/**
 * Called by browseroverlay when a tab is moved. We only get one such 
 * notification, even though really all the tabs between the old position and
 * the new position changed as well. We record tab index changes for all 
 * affected tabs.
 */
CLB_TabSyncer.prototype.onTabMove = function(win, ev) {
  G_Debug(this, "tabmove from index {%s} to index {%s}"
                .subs(ev.fromIndex, ev.toIndex));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  var tabBrowser = win.document.getElementById("content");
  var min = Math.min(ev.fromIndex, ev.toIndex);
  var max = Math.max(ev.fromIndex, ev.toIndex);

  this.resetTabIndicies_(tabBrowser, min, max);
}

/**
 * Sends sync items resetting the tabIndex properties of all tabs in the
 * specified range, inclusive. Used by onTabMove and onTabUnload.
 */
CLB_TabSyncer.prototype.resetTabIndicies_ = function(tabBrowser,
                                                     fromIndex, toIndex) {
  var syncItem, browser;

  for (var i = fromIndex; i <= toIndex; i++) {
    syncItem = new CLB_SyncItem({componentID: this.componentID,
                                 typeID: "tab"});

    browser = tabBrowser.browsers[i];

    if (!browser) {
      G_DebugL(this, "ERROR: Could not find browser at position {%s}"
                     .subs(i));
      continue;
    }

    if (!isDef(browser.__tabID)) {
      G_DebugL(this, "ERROR: Could not get tabID from browser at position {%s}"
                     .subs(i));
      continue;
    }

    syncItem.itemID = browser.__tabID;
    syncItem.setProperty("tabIndex", i);

    G_Debug(this, "Sending tabIndex update syncitem: " + syncItem);
    CLB_syncMan.update(syncItem);
  }
  
}

/**
 * Called by browseroverlay when a browser window unloads. We record remove
 * changes for the window and all tabs.
 */
CLB_TabSyncer.prototype.onUnload = function(win) {
  G_Debug(this, "Received onunload event for win {%s}".subs(win.__winID));

  if (!this.shouldProcessEvents_()) {
    return;
  }

  // If an existing update is already queued, rescue it.
  if (this.unloadQueueAlarm_) {
    G_Debug(this, ("Found existing unload timer with {%s} queued items. " + 
                   "Rescuing them.").subs(this.queuedUnload_.length));
    this.unloadQueueAlarm_.cancel();
  } else {
    // otherwise, make a new one
    this.queuedUnload_ = [];
  }

  if (!isDef(win.__winID)) {
    G_DebugL(this, 
             "ERROR: Could not find winID for unloaded window. Ignoring.");
  } else {
    var winSyncItem = new CLB_SyncItem({componentID: this.componentID,
                                        typeID: "window",
                                        itemID: win.__winID,
                                        isRemove: true});

    G_Debug(this, "Queuing win remove syncitem: " + winSyncItem);
    this.queuedUnload_.push(winSyncItem);
  }

  var tabBrowser = win.document.getElementById("content");

  if (!tabBrowser) {
    G_DebugL(this, "ERROR: Could not get tabBrowser from unloading window. " +
                   "Skipping window's tabs.");
  }

  for (var i = 0, browser; browser = tabBrowser.browsers[i]; i++) {
    if (!isDef(browser.__tabID)) {
      G_DebugL(this, "ERROR: Could not find tabID for tab in unloading " + 
                     "window at position {%s}. Ignoring tab.".subs(i));
      continue;
    }

    var tabSyncItem = new CLB_SyncItem({componentID: this.componentID,
                                        typeID: "tab",
                                        itemID: browser.__tabID,
                                        isRemove: true});

    G_Debug(this, "Queuing tab remove syncitem: " + tabSyncItem);
    this.queuedUnload_.push(tabSyncItem);
  }

  // reset the timer
  this.unloadQueueAlarm_ = 
    new G_Alarm(this.handleUnloadTimerElapsed_, 
                CLB_TabSyncer.UNLOAD_QUEUE_SECONDS * 1000);
}

/**
 * Called when the time limit between closing a window and the change taking
 * effect elapses. Send the queued unload to the server.
 */
CLB_TabSyncer.prototype.handleUnloadTimerElapsed_ = function() {
  G_Debug(this, ("Unload timer elapsed. Sending {%s} queued unloads to the " +
                 "server.").subs(this.queuedUnload_.length));
  this.unloadQueueAlarm_ = null;

  // send the queued unload items to the server
  this.queuedUnload_.forEach(function(item) {
    CLB_syncMan.update(item);
  });

  this.queuedUnload_ = null;
}

/**
 * Helper to determine whether the on* methods should do anything. We only 
 * process tabbrowser events when the tabsyncer is enabled and when Clobber is
 * online.
 */
CLB_TabSyncer.prototype.shouldProcessEvents_ = function() {
  return this.started_ && !this.syncing_ &&
    CLB_app.getStatus() == CLB_Application.STATUS_ONLINE;
}

/**
 * Helper to find the position of a single browser inside a tabbrowser. Tabs
 * which are collapsed are considered closed since restoretabsui does this 
 * sometimes to prevent jiggling when restoring tabs.
 */
CLB_TabSyncer.findBrowserPosition = function(win, target) {
  var tabBrowser = win.document.getElementById("content");

  // Collapsed tabs don't count. We collapse tabs while restoring to make things
  // look nicer, but they are removed moments later.
  var numCollapsedTabs = 0;

  for (var i = 0, cand; cand = tabBrowser.browsers[i]; i++) {
    if (tabBrowser.tabContainer.childNodes[i].collapsed) {
      G_Debug(CLB_TabSyncer.prototype, 
              "Skipping collapsed tab at pos {%s}".subs(i));
      numCollapsedTabs++;
      continue;
    }

    if (cand == target) {
      G_Debug(CLB_TabSyncer.prototype, 
              "Found tab at pos {%s}. Adjusting for collapsed tabs to {%s}."
              .subs(i, i - numCollapsedTabs));

      return i - numCollapsedTabs;
    }
  }

  return -1;
}

/**
 * Called by syncman before an update with the server is about to happen. 
 */
CLB_TabSyncer.prototype.beforeUpdate = function() {
  // nop
}

/**
 * Update the itemID counter based on the specified downloaded ID. We keep the
 * next ID one larger than the largest downloaded ID so that we don't overlap.
 */
CLB_TabSyncer.prototype.updateID_ = function(downloadedID) {
  downloadedID = parseInt(downloadedID);

  if (isNaN(downloadedID)) {
    G_DebugL(this, "ERROR: Unexpected format for downloadedID: {%s}"
                   .subs(downloadedID));
    return;
  }

  if (downloadedID >= this.nextID_) {
    this.nextID_ = downloadedID + 1;
    G_Debug(this, "Received ID {%s} and updated to {%s}"
                  .subs(downloadedID, this.nextID_));
  }
}

/**
 * Get a new ID for use in a tab or window itemID.
 */
CLB_TabSyncer.prototype.getNextID_ = function() {
  return String(this.nextID_++);
}

CLB_TabSyncer.prototype.debugZone = "CLB_TabSyncer";
G_debugService.loggifier.loggify(CLB_TabSyncer.prototype);


if (CLB_DEBUG) {
  function TEST_CLB_TabSyncer() {
    var tabSyncer = new CLB_TabSyncer();
    var valid = new CLB_SyncItem({componentID: "testcomponent",
                                  typeID: "tab",
                                  itemID: "12",
                                  properties: {tabIndex: "0",
                                               url: "testurl",
                                               windowID: "2" }});

    var invalid;
    var undef;
    var zone = "TEST_CLB_TabSyncer";

    try {
      // test invalid items
      invalid = valid.clone();
      delete invalid.itemID;
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      delete invalid.typeID;
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      delete invalid.componentID;
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      invalid.deleteProperty("tabIndex");
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      invalid.deleteProperty("url");
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      invalid.deleteProperty("windowID");
      tabSyncer.onItemAvailable(invalid);

      invalid = valid.clone();
      invalid.setProperty("tabIndex", "monkey");
      tabSyncer.onItemAvailable(invalid);

      G_AssertEqual(zone,
                    0,
                    getObjectProps(CLB_RestoreTabsUI.tabsToOpen_).length,
                    "Expected no tabsToOpen since all items were invalid");
    } finally {
      CLB_RestoreTabsUI.resetItems();
    }

    // test getNextID and friends
    tabSyncer = new CLB_TabSyncer();
    tabSyncer.updateID_("5");
    tabSyncer.updateID_("3");
    tabSyncer.updateID_("7");
    G_AssertEqual(zone, "8", tabSyncer.getNextID_(),
                  "Unexpected value from getNextID_()");

    tabSyncer.updateID_("foobar");
    tabSyncer.updateID_(undef);
    tabSyncer.updateID_(null);
    G_AssertEqual(zone, "9", tabSyncer.getNextID_(),
                  "Invalid id formats should not update ID.");
  }
}
