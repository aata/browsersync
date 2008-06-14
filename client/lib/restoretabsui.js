// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Implements the "Restore 10 tabs and 2 windows UI"
 */
function CLB_RestoreTabsUI(win, tabBrowser, bubbleRoot, tabbedBrowserWatcher) {
  bindMethods(this);

  this.win_ = win;
  this.doc_ = win.document;
  this.tabBrowser_ = tabBrowser;

  // Lookup the checkbox for a tab by it's tabitem ID. Used in building the 
  // final list of tabs to open. Populated by populate_().
  this.checkboxLookup_ = {};

  this.winMed_ = Cc["@mozilla.org/appshell/window-mediator;1"]
                   .getService(Ci.nsIWindowMediator);
  this.winWat_ = Cc["@mozilla.org/embedcomp/window-watcher;1"]
                   .getService(Ci.nsIWindowWatcher);

  this.toolbarButton_ = this.doc_.getElementById("clb-toolbarbutton");

  var infoBubbleWidth = CLB_app.isLinux() ?
                        CLB_RestoreTabsUI.INFO_BUBBLE_WIDTH_LINUX :
                        CLB_RestoreTabsUI.INFO_BUBBLE_WIDTH ;

  this.infoBubble_ = new CLB_InfoBubble(bubbleRoot, tabbedBrowserWatcher, 
                                        infoBubbleWidth);

  this.restoreRows_ = bubbleRoot.getElementsByTagName("rows")[0];

  this.restoreAllButton_ = bubbleRoot.getElementsByTagName("button")[0];
  this.restoreAllButton_._command = this.handleRestoreAll_;
  this.restoreAllButton_.setAttribute("oncommand", "this._command()");

  this.obsSvc_ = Cc["@mozilla.org/observer-service;1"]
                 .getService(Ci.nsIObserverService);
  this.obsSvc_.addObserver(this, "clb-show-restore", true);

  if (!CLB_RestoreTabsUI.observingSyncMan_) {
    G_Debug(this, "Adding static interface to syncman observer.");
    CLB_syncMan.addObserver(CLB_RestoreTabsUI);
    CLB_RestoreTabsUI.observingSyncMan_ = true;
  }

  if (CLB_RestoreTabsUI.windowsToOpen_.length &&
      CLB_app.getStatus() == CLB_Application.STATUS_ONLINE &&
      !CLB_InfoBubble.allHidden) {
    this.populate_();
    this.infoBubble_.show(this.toolbarButton_);
  }
}

CLB_RestoreTabsUI.BROWSER_CHROME_URL = "chrome://browser/content/browser.xul";
CLB_RestoreTabsUI.DISABLED_MESSAGE = "No tabs are available to be restored";
CLB_RestoreTabsUI.DISABLED_IMAGE =
  "chrome://browserstate/content/restore-disabled.png";
CLB_RestoreTabsUI.ENABLED_IMAGE = "chrome://browserstate/content/restore.png";
CLB_RestoreTabsUI.MAX_URL_LENGTH = 25;
CLB_RestoreTabsUI.MAX_TITLE_LENGTH = 15;
CLB_RestoreTabsUI.INFO_BUBBLE_WIDTH = 320;
CLB_RestoreTabsUI.INFO_BUBBLE_WIDTH_LINUX = 350;

CLB_RestoreTabsUI.observingSyncMan_ = false;

// Holds the sync items for windows that need to be opened until it is time
// to do so. The last item is the one that should be on top.
CLB_RestoreTabsUI.windowsToOpen_ = [];

// Holds the tab items for tabs that need to be opened until it is time to do
// so. This list is maintained in sorted order by window ID, then tab 
// position.
CLB_RestoreTabsUI.tabsToOpen_ = {};

// Whether to show the restore UI when a syncComplete occurs. The UI sets this
// before starting a sync.
CLB_RestoreTabsUI.enabled = true;

// Whether the tabs bucket in sync man has completed or not. Used to determine
// when to show the restore UI.
CLB_RestoreTabsUI.tabsBucketComplete_ = false;

/**
 * Queue a GISyncItem representing a window that needs to be opened until it
 * is time to open them. We maintain the queue in the order the windows should
 * be opened. We have no good way to track z-index other than "topmost" window
 * so we keep the windows in the order they were received, with the topmost
 * window at the end.
 */
CLB_RestoreTabsUI.addWindowItem = function(item) {
  if (item.getProperty("topWindow") == "true" || 
      this.windowsToOpen_.length == 0) {
    this.windowsToOpen_.push(item);
  } else {
    this.windowsToOpen_.splice(this.windowsToOpen_.length - 2, 0, item);
  }

  G_Debug(this, "windowsToOpen_ is now: " + this.windowsToOpen_);
}

/**
 * Queue a GISyncItem representing a tab that needs to be opened until it is
 * time to open them. We maintain tabs in a table indexed by their window ID.
 * Each value is a list of tabs that in that window. The list is maintained in
 * the order the tabs should show up in the window.
 */
CLB_RestoreTabsUI.addTabItem = function(item) {
  var winID = item.getProperty("windowID");
  var tabPos = parseInt(item.getProperty("tabIndex"));
  var url = item.getProperty("url");

  if (!isDef(winID) || isNaN(tabPos) || !isDef(url)) {
    G_DebugL(this,
             "WARNING: Received invalid tab item. Dropping. " +
             "winID: {%s}, tabPos: {%s}, url: {%s}"
             .subs(winID, tabPos, url));
    return;
  }

  var tabList = this.tabsToOpen_[winID];
  if (!tabList) {
    this.tabsToOpen_[winID] = tabList = [];
  }

  // Make sure there isn't something already there.
  if (tabList[tabPos]) {
    G_DebugL(this,
             ("WARNING: Received tab item {%s} at position {%s} would " +
              "collide with existing tab item {%s} at that position.")
             .subs(item.itemID, tabPos, tabList[tabPos].itemID));
    return;
  }

  tabList[tabPos] = item;
  G_Debug(this, "tabsToOpen_ is now: " + this.tabsToOpen_);
}

CLB_RestoreTabsUI.resetItems = function() {
  this.windowsToOpen_ = [];
  this.tabsToOpen_ = {};
  this.tabsBucketComplete_ = false;
}


// GISyncObserver

CLB_RestoreTabsUI.updateStart =
CLB_RestoreTabsUI.updateProgress =
CLB_RestoreTabsUI.updateFailure =
CLB_RestoreTabsUI.updateComplete =
CLB_RestoreTabsUI.syncProgress = function() {
  // NOP
}

CLB_RestoreTabsUI.syncComplete = 
CLB_RestoreTabsUI.syncFailure = function() {
  this.enabled = false;
}

/**
 * Called when a sync starts. We use this time to clear the list of tabs and
 * windows to be restored.
 */
CLB_RestoreTabsUI.syncStart = function() {
  G_Debug(this, "Received syncStart. Resetting items.");

  this.resetItems();
}

/**
 * Called when syncman finishes parsing a bucket. If we have any items, then
 * that must have been our bucket, so we show the UI. Either way we mark down
 * that this has happened so that we don't do it for the next bucket.
 */
CLB_RestoreTabsUI.bucketComplete = function() {
  if (!this.tabsBucketComplete_) {
    this.showUI();
  }

  this.tabsBucketComplete_ = true;
}

/**
 * Called when tab items have been received successfully. We show the restore UI in all
 * windows. 
 *
 * @see CLB_Downloader#parseNextBucket
 */
CLB_RestoreTabsUI.showUI = function() {
  G_Debug(this, "Received showUI.");

  if (!this.enabled) {
    G_Debug(this, "Not showing restore UI because it is not enabled.");
    return;
  }

  // Note that because the initial restore tabs UI (the one that shows up when
  // the browser starts) is not caused by this code path, but the one in the
  // constructor, it is not affected by this pref check, which is what we want.
  if (!CLB_app.prefs.getPref("restoreui-on-resync", true)) {
    G_Debug(this,
            "Not showing restore UI because restoreui-on-resync pref " +
            "is set to false.");
    return;
  }

  if (this.checkDupe_()) {
    G_Debug(this, "Not showing restore UI because this is a dupe.");
    return;
  }

  if (!this.windowsToOpen_.length) {
    G_Debug(this,
            "Not showing restore UI because there are no windows to restore.");
    return;
  }

  G_Debug(this, "Telling instances to restore...");
  
  Cc["@mozilla.org/observer-service;1"]
    .getService(Ci.nsIObserverService)
    .notifyObservers(this, "clb-show-restore", null);
}

/**
 * Check to see whether the synced state is "the same" as the current state.
 * For simplicity we consider the synced state different than the current state
 * if it contains any different URLs. Duplicates, reorders, and extra tabs
 * in the local state that aren't in the synced state don't count toward
 * making a difference.
 */
CLB_RestoreTabsUI.checkDupe_ = function() {
  var winMed = Cc["@mozilla.org/appshell/window-mediator;1"]
               .getService(Ci.nsIWindowMediator);

  var currentWindows = winMed.getEnumerator("navigator:browser");
  var syncedTabsLookup = {};
  var currentTabsLookup = {};
  var tabBrowser;
  var item;
  var win;

  while (currentWindows.hasMoreElements()) {
    win = currentWindows.getNext();
    tabBrowser = win.document.getElementById("content");

    for (var i = 0, browser; browser = tabBrowser.browsers[i]; i++) {
      currentTabsLookup[browser.contentWindow.location.href] = true;
    }
  }

  for (var winID in this.tabsToOpen_) {
    for (var i = 0, tab; tab = this.tabsToOpen_[winID][i]; i++) {
      syncedTabsLookup[tab.getProperty("url")] = true;
    }
  }

  var syncedTabsList = getObjectProps(syncedTabsLookup);
  var currentTabsList = getObjectProps(currentTabsLookup);

  G_Debug(this, "synced tabs are: " + syncedTabsList);
  G_Debug(this, "current tabs are: " + currentTabsList);

  var xor = G_SetXOR(syncedTabsList, currentTabsList);

  if (xor.left.length) {
    return false;
  } else {
    return true;
  }
}


// nsISupports
CLB_RestoreTabsUI.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsIObserver) ||
      iid.equals(Ci.nsISupportsWeakReference)) {
    return this;
  } else {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
}


// nsIObserver
CLB_RestoreTabsUI.prototype.observe = function(subject, topic, data) {
  if (topic != "clb-show-restore") {
    G_DebugL(this, "ERROR: Unexpected topic {%s} received".subs(topic));
    return;
  }

  G_Debug(this, "Received clb-show-restore. Showing restore UI.");
  
  this.populate_();
  this.infoBubble_.show(this.toolbarButton_);
}


// private

/**
 * Removes empty windows from the list of windows to open, so that populate_ 
 * can be a simple nested loop.
 */
CLB_RestoreTabsUI.cleanUpItemsToOpen_ = function(windowsToOpen, tabsToOpen) {
  var winItem;

  G_Debug(this, "Cleaning up items to open");

  // First look for undefined tab positions and remove them.
  for (var winID in tabsToOpen) {
    for (var i = tabsToOpen[winID].length - 1; i >= 0; i--) {
      if (!isDef(tabsToOpen[winID][i])) {
        G_Debug(this, ("Removing undefined tab position at index " +
                       "{%s} for window {%s}".subs(i, winID)));
        tabsToOpen[winID].splice(i, 1);
      }
    }
  }

  // Now look for windows which have no tabs and remove them.
  for (var i = windowsToOpen.length - 1; i >= 0; i--) {
    winItem = windowsToOpen[i];

    // If there are no associated tabs, remove the window item from the list.
    if (!isDef(tabsToOpen[winItem.itemID]) || 
        tabsToOpen[winItem.itemID].length == 0) {
      G_Debug(this, ("Removing window {%s} from list of windows to open " + 
                     "because there are no associated tabs")
                    .subs(winItem.itemID));
      windowsToOpen.splice(i, 1);
    }
  }
}

/**
 * Populate the info bubble with windows and associated tabs that got synced.
 */
CLB_RestoreTabsUI.prototype.populate_ = function() {
  var windowsToOpen = [].concat(CLB_RestoreTabsUI.windowsToOpen_);
  var tabsToOpen = {};
  
  for (var winID in CLB_RestoreTabsUI.tabsToOpen_) {
    tabsToOpen[winID] = [].concat(CLB_RestoreTabsUI.tabsToOpen_[winID]);
  }

  CLB_RestoreTabsUI.cleanUpItemsToOpen_(windowsToOpen, tabsToOpen);

  G_Debug(this, "Populating windowsToOpen_: " +
                windowsToOpen);

  var winItem, tabItem;

  // First remove all existing UI for items
  while (this.restoreRows_.firstChild) {
    this.restoreRows_.removeChild(this.restoreRows_.firstChild);
  }

  // Now build the new items' UI
  for (var i = 0; i < windowsToOpen.length; i++) {
    winItem = windowsToOpen[i];
    G_Debug(this, "winItem is: " + winItem);

    for (var j = 0; j < tabsToOpen[winItem.itemID].length; j++) { 
      tabItem = tabsToOpen[winItem.itemID][j];
      G_Debug(this, "tabItem is: " + tabItem);

      // tabItems are indexed by their position, and there can sometimes be
      // missing positions due to corrupt data, etc. If there's nothing at this
      // position, continue to next slot.
      if (!isDef(tabItem)) {
        G_Debug(this, "Skipping undefined tabItem");
        continue;
      }

      var row = this.doc_.createElement("row");

      var checkbox = this.doc_.createElement("checkbox");
      checkbox.setAttribute("class", "clb-restore-checkbox");
      checkbox.setAttribute("checked", true);
      checkbox.setAttribute("label", 
                            this.ellipsize_(tabItem.getProperty("url"), 
                                            CLB_RestoreTabsUI.MAX_URL_LENGTH));
      checkbox.addEventListener("CheckboxStateChange", 
                                this.updateRestoreAllEnabled_,
                                false);

      // Store the checkbox so we can quickly determine if it's checked later.
      this.checkboxLookup_[tabItem.itemID] = checkbox;

      var spacer = this.doc_.createElement("spacer");
      spacer.className = "clb-restore-spacer";

      var hbox = this.doc_.createElement("hbox");
      var title = this.doc_.createElement("label");
      title.setAttribute("class", "clb-restore-title");
      title.setAttribute("value",
                         this.ellipsize_(tabItem.getProperty("title"),
                                         CLB_RestoreTabsUI.MAX_TITLE_LENGTH));
      hbox.setAttribute("align", "center");
      hbox.appendChild(title);

      row.appendChild(checkbox);
      row.appendChild(spacer);
      row.appendChild(hbox);

      this.restoreRows_.appendChild(row);
    }

    if (i < windowsToOpen.length - 1) {
      var rule = this.doc_.createElement("box");
      rule.className = "clb-restore-rule";
      this.restoreRows_.appendChild(rule);
    }
  }

  this.restoreAllButton_.disabled = false;
}

CLB_RestoreTabsUI.prototype.hide = function() {
  this.infoBubble_.hide();
}

CLB_RestoreTabsUI.prototype.handleRestoreAll_ = function() {
  G_Debug(this, "Restoring all checked windows.");

  var tabsToOpen = CLB_RestoreTabsUI.tabsToOpen_;

  CLB_InfoBubble.hideAll();

  // Remove all the unchecked tabs from the tabsToOpen lists
  for (var winID in tabsToOpen) {
    // Loop in reverse because we are removing things
    for (var i = tabsToOpen[winID].length - 1; i >= 0; i--) {
      var tabItem = tabsToOpen[winID][i];

      // There can sometimes not be a tabItem at this point because we are
      // still syncing and so the array is still sparse. Since in that case
      // the user couldn't possible have unchecked the row yet, just skip
      // those items.
      if (!tabItem) {
        G_Debug(this,
                "Could not find tab #{%s} for window id {%s}. Skipping..."
                .subs(i, winID));
        continue;
      }
      
      var checkbox = this.checkboxLookup_[tabItem.itemID];

      // Same thing with the checkbox (we don't always show checkboxes right
      // when we get the tabItem because we might not have the window yet).
      // So ignore if we don't find a corresponding checkbox.
      if (!checkbox) {
        G_Debug(this,
                "Could not find checkbox for tab id {%s}. Skipping..."
                .subs(tabItem.itemID));
        continue;
      }

      if (!checkbox.checked) {
        G_Debug(this, "Removing item for unchecked tab {%s}"
                      .subs(tabItem.itemID));

        tabsToOpen[winID].splice(i, 1);
      }
    }
  }

  // Remove windows which might now have no tabs in them
  CLB_RestoreTabsUI.cleanUpItemsToOpen_(CLB_RestoreTabsUI.windowsToOpen_, 
                                        CLB_RestoreTabsUI.tabsToOpen_);
  this.restoreWindows_(this.win_);
}

/**
 * Restore all windows and tabs currently in CLB_RestoreTabsUI.windowsToOpen.
 */
CLB_RestoreTabsUI.prototype.restoreWindows_ = function(firstWin) {
  G_Debug(this, "Restoring all. firstWin: " + firstWin.__winID);

  var existingWindows = this.winMed_.getEnumerator("navigator:browser");
  var win;

  // clobber other windows
  while (existingWindows.hasMoreElements()) {
    win = existingWindows.getNext().QueryInterface(Ci.nsIDOMWindowInternal);

    if (win != firstWin) {
      G_Debug(this, "Closing existing win with id: " + win.__winID);
      win.close();
    }
  }
  
  // open all new tabs and windows, reusing the first window
  CLB_RestoreTabsUI.windowsToOpen_.forEach(function(winItem) {
    var winID = winItem.itemID;

    this.restoreWindow_(winID,
                        CLB_RestoreTabsUI.tabsToOpen_[winID],
                        firstWin);

    // we only use the first window, uh, the first time.
    firstWin = null;
  }, this);
}

/**
 * Helper to restore a window with it's tabsList.
 */
CLB_RestoreTabsUI.prototype.restoreWindow_ =
function(winID, tabs, opt_reuseWindow) {
  G_Debug(this, "Restoring window. winID: {%s}, reuseWindow: {%s}, tabs: {%s}"
                .subs(winID, opt_reuseWindow, tabs));

  var win = opt_reuseWindow || 
            this.winWat_.openWindow(null /* no parent */,
                                    CLB_RestoreTabsUI.BROWSER_CHROME_URL,
                                    "_blank",
                                    "chrome,all,dialog=no,resizable",
                                    null);

  var tabsOpener = this.restoreTabs_.bind(this,
                                          win,
                                          CLB_RestoreTabsUI.tabsToOpen_[winID]);

  if (opt_reuseWindow) {
    tabsOpener();
  } else {
    win.QueryInterface(Ci.nsIDOMWindowInternal)
       .addEventListener("load", tabsOpener, false);
  }

  return win;
}

/**
 * Helper. Restores all the tabs in the given tabsList (from tabsToOpen index)
 * in the given window.
 */
CLB_RestoreTabsUI.prototype.restoreTabs_ = function(win, tabsList) {
  G_Debug(this, "Restoring tabs. win: {%s}, tabsList: {%s}"
                .subs(win.__winID, tabsList));

  var tabbrowser = win.document.getElementById("content");
  var numTabsToKill = tabbrowser.tabContainer.childNodes.length;

  G_Debug(this, "numTabsToKill: {%s}".subs(numTabsToKill));

  for (var i = 0; i < numTabsToKill; i++) {
    tabbrowser.tabContainer.childNodes[i].collapsed = true;
    G_Debug(this, "collapsed previous tab num {%s}".subs(i));
  }

  tabsList.forEach(function(tabItem) {
    try {
      G_Debug(this, "Opening tab {%s}".subs(tabItem.getProperty("url")));
      tabbrowser.addTab(tabItem.getProperty("url"));
    } catch (e) {
      // Swallow. An error can happen here for a variety of reasons.
      // One example is that if url is file:// protocol and cannot be loaded
      // because it does not exist on this machine. Another is if any other
      // listener on this event throws an error. For example Greasemonkey
      // sometimes throws errors in it's tabshow listeners.
      G_Debug(this,
              "WARNING: Opening tab caused error: {%s}. Ignoring.".subs(e));
    }

    // Even though an error might have been thrown above, the tab is still
    // created and accessible through it's index.
    var tab = tabbrowser.tabContainer.lastChild;

    if (tabItem.getProperty("activeTab") == "true") {
      G_Debug(this, "Selecting tab");
      try {
        tabbrowser.selectedTab = tab;
      } catch (e) {
        // Same thing here. Selecting a tab can throws errors because of other
        // extensions which we should ignore.
        G_Debug(this,
                "WARNING: Selecting tab caused error: {%s}. Ignoring.".subs(e));
      }
    }
  }, this);

  for (var j = 0; j < numTabsToKill; j++) {
    tabbrowser.removeTab(tabbrowser.tabContainer.firstChild);
    G_Debug(this, "Killed previous tab num: {%s}".subs(j));
  }
}

CLB_RestoreTabsUI.prototype.ellipsize_ = function(val, len) {
  if (!val) {
    return "";
  } else if (val.length > len) {
    return val.substring(0, len) + "...";
  } else { 
    return val;
  }
}

/**
 * Set the Restore button to disabled if there are no items checked. Otherwise
 * enabled.
 */
CLB_RestoreTabsUI.prototype.updateRestoreAllEnabled_ = function() {
  G_Debug(this, "Updating restore button disabledness");

  for (var i = 0, row; row = this.restoreRows_.childNodes[i]; i++) {
    if (row.firstChild && row.firstChild.checked) {
      G_Debug(this, "Item at index {%s} is checked. Setting button enabled."
                    .subs(i));
      this.restoreAllButton_.disabled = false;
      return;
    }
  }

  G_Debug(this, 
          "Checked {%s} items. None were checked. Setting button disabled."
          .subs(i));

  this.restoreAllButton_.disabled = true;
}

CLB_RestoreTabsUI.debugZone = "CLB_RestoreTabsUI";
CLB_RestoreTabsUI.prototype.debugZone = "CLB_RestoreTabsUI";
G_debugService.loggifier.loggify(CLB_RestoreTabsUI);
G_debugService.loggifier.loggify(CLB_RestoreTabsUI.prototype);

if (CLB_DEBUG) {
  function TEST_CLB_RestoreTabsUI() {
    var zone = "TEST_CLB_RestoreTabsUI";
    var valid = new CLB_SyncItem({componentID: "testcomponent",
                                  typeID: "tab",
                                  itemID: "12",
                                  properties: {tabIndex: "0",
                                               url: "testurl",
                                               windowID: "2" }});

    try {
      G_Debug(zone, "Starting CLB_RestoreUI tests...");

      // test valid item
      CLB_RestoreTabsUI.addTabItem(valid);
      G_AssertEqual(zone,
                    1,
                    getObjectProps(CLB_RestoreTabsUI.tabsToOpen_).length,
                    "Expected 1 tabsToOpen key since we added one valid item.");
      G_Assert(zone,
               CLB_RestoreTabsUI.tabsToOpen_[valid.getProperty("windowID")][0]
               .equals(valid),
               "Testing adding valid item. Expected {%s},  got {%s}."
               .subs(uneval(valid),
                     uneval(CLB_RestoreTabsUI.tabsToOpen_[
                                valid.getProperty("windowID")][0])));

      // test duplicate position
      var valid2 = valid.clone();
      valid2.itemID = "mon";
      CLB_RestoreTabsUI.addTabItem(valid2);
      G_AssertEqual(zone,
                    1,
                    getObjectProps(CLB_RestoreTabsUI.tabsToOpen_).length,
                    "Expected 1 tabsToOpen key since the tab we just added " +
                    "was a duplicate");

      // test non-duplicate position (because in another window)
      valid2 = valid.clone();
      valid2.itemID = "key";
      valid2.setProperty("windowID", "bar");
      CLB_RestoreTabsUI.addTabItem(valid2);
      G_AssertEqual(zone,
                    2,
                    getObjectProps(CLB_RestoreTabsUI.tabsToOpen_).length,
                    "Expected 2 tabsToOpen keys since we just added another " +
                    "tab which was not a duplicate.");
    } finally {
      CLB_RestoreTabsUI.resetItems();
    }

    G_Debug(zone, "Completed all CLB_RestoreUI tests successfully");
  }
}
