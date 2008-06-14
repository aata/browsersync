// Copyright 2005 and onwards, Google

/**
 * An implementation of GISyncComponent for cookies
 */
function CLB_CookieSyncer() {
  this.observersSetup_ = false;
  this.lastSyncedCookies_ = null;
  this.talkingToServer_ = false;
  this.inOnItemAvailable_ = false;

  this.prefs = new G_Preferences("network.cookie.", false, true);
  this.cookiesEnabled = (this.prefs.getPref("cookieBehaviour", 0) == 0);

  this.cookieSvc_ = Cc["@mozilla.org/cookieService;1"]
                    .getService(Ci.nsICookieService);
  this.cookieMan_ = Cc["@mozilla.org/cookiemanager;1"]
                    .getService(Ci.nsICookieManager);
  this.obsSvc_ = Cc["@mozilla.org/observer-service;1"]
                 .getService(Ci.nsIObserverService);
  this.ioSvc_ = Cc["@mozilla.org/network/io-service;1"]
               .getService(Ci.nsIIOService);
}


CLB_CookieSyncer.prototype.priority = 0;
CLB_CookieSyncer.prototype.componentID =
    "@google.com/browserstate/cookie-syncer;1";


// Required GISyncComponent properties
CLB_CookieSyncer.prototype.syncBehavior =
  Ci.GISyncComponent.SYNC_SINCE_LAST_UPDATE;
CLB_CookieSyncer.prototype.componentName = "Cookies";
CLB_CookieSyncer.prototype.encryptionRequired = true;
CLB_CookieSyncer.prototype.syncOfflineChanges = true;


// GISyncObserver
CLB_CookieSyncer.prototype.updateStart = 
CLB_CookieSyncer.prototype.syncStart = function() {
  this.talkingToServer_ = true;
}

CLB_CookieSyncer.prototype.updateComplete =
CLB_CookieSyncer.prototype.updateFailure =
CLB_CookieSyncer.prototype.syncComplete =
CLB_CookieSyncer.prototype.syncFailure = function() {
  this.talkingToServer_ = false;
}

CLB_CookieSyncer.prototype.syncProgress =
CLB_CookieSyncer.prototype.updateProgress = function() {
  // NOP
}


// GISyncComponent

/**
 * See GISyncComponent.start
 */
CLB_CookieSyncer.prototype.start = function() {
  if (!this.observersSetup_) {
    this.obsSvc_.addObserver(this, "cookie-changed", false);
    CLB_syncMan.addObserver(this);
    this.observersSetup_ = true;
  }

  this.initLastSyncedCookies_();
}

/**
 * Stops the cookie syncer
 *
 * @see GISyncComponent#stop
 */
CLB_CookieSyncer.prototype.stop = function() {
  if (this.observersSetup_) {
    this.obsSvc_.removeObserver(this, "cookie-changed");
    this.observersSetup_ = false;
  }
}

CLB_CookieSyncer.prototype.initLastSyncedCookies_ = function() {
  if (!isNull(this.lastSyncedCookies_)) {
    return;
  }

  G_Debug(this, "Initializing lastSyncedCookies");
  this.lastSyncedCookies_ = {};

  var cookies = new CLB_CookieEnumerator();
  while (cookies.hasMoreElements()) {
    var cookie = cookies.getNext();
    this.lastSyncedCookies_[cookie.itemID] = cookie;
  }
}


/**
 * Gets called by cookie object when one of our prefs changes
 *
 * @param prefName  The preference which changed.
 */
CLB_CookieSyncer.prototype.observe = function (cookie, topic, data) {
  if (topic != "cookie-changed") {
    return;
  }

  if (data == "cleared") {
    G_Debug(this, "Sending removes for {%s} known cookies"
                  .subs(this.lastSyncedCookies_.__count__));
    
    for (var itemID in this.lastSyncedCookies_) {
      CLB_syncMan.update(new CLB_SyncItem({
        itemID: itemID,
        componentID: this.componentID,
        isRemove: true        
      }));
    }

    this.lastSyncedCookies_ = {};
    return;
  }

  if (this.inOnItemAvailable_) {
    return;
  }

  cookie.QueryInterface(Ci.nsICookie);
  var syncItem;

  // Ignore pref cookies from google.com while updating.
  // IMPORTANT: We need to keep this up to date if the server starts returning
  // other cookies. I tried using http-on-examine-response to remove the cookies
  // before they get sent to cookiemanager, but that happens too late in FF 1.5.
  // It is fixed in 2.0.
  if (this.talkingToServer_ &&
      cookie.host == ".google.com" &&
      cookie.name == "PREF") {
    return;
  }

  if (data == "deleted") {
    syncItem = CLB_CookieSyncer.createBlankSyncItem(cookie);

    if (syncItem) {
      syncItem.isRemove = true;
      CLB_syncMan.update(syncItem);
      delete this.lastSyncedCookies_[syncItem.itemID];
    }

    return;
  }

  if (data == "added" || data == "changed") {
    syncItem = CLB_CookieSyncer.createSyncItem(cookie);

    if (syncItem) {
      CLB_syncMan.update(syncItem);
      this.lastSyncedCookies_[syncItem.itemID] = syncItem.clone();;
    }

    return;
  }

  G_DebugL(this, "ERROR: Unexpected value for data parameter {%s}".subs(data));
}

/**
 * See GISyncItem.onItemConflict
 */
CLB_CookieSyncer.prototype.onItemConflict = function(conflict, oldItem,
                                                     newItem) {
}

/**
 * See GISyncComponent.getItemByID
 */
CLB_CookieSyncer.prototype.getItemByID = function(id, typeID) {
  // CookieSyncer does not do partial updates, so we always return null
  return null;
}

/**
 * See GISyncComponent.onItemAvailable and 
 * GISyncComponent.onBeforeResolveConflict
 *
 * We do this doubling up so that the user has cookies available 
 * at the same time their tabs become available - following conflict
 * resolution, we then apply the resolved cookies. There is absolutely
 * nothing that could go wrong with this, especially when the site
 * modifies the cookie.
 */
CLB_CookieSyncer.prototype.onBeforeResolveConflict = 
CLB_CookieSyncer.prototype.onItemAvailable = function(syncItem) {
  this.inOnItemAvailable_ = true;

  try {
    if (syncItem.isRemove) {
      this.removeCookie(syncItem);
    } else {
      this.setCookie(syncItem);
    }
  } finally {
    this.inOnItemAvailable_ = false;
  }
}


/**
 * See GISyncComponent.getCurrentItems
 */
CLB_CookieSyncer.prototype.getCurrentItems = function() {
  return new CLB_CookieEnumerator();
}


/**
 * See GISyncComponent.beforeUpdate
 */
CLB_CookieSyncer.prototype.beforeUpdate = function() {
  // nop
}

CLB_CookieSyncer.prototype.resolveConflict = function(conflict, oldItem,
                                                   newItem) {
}

/**
 * Adds the cookie represented by the specified sync item to the browser's 
 * cookie store.
 *
 * Since nsICookieManager does not expose a method to set cookies, we go 
 * around it by simulating what the browser does when it receives a cookie
 * from a webserver.
 */
CLB_CookieSyncer.prototype.setCookie = function(syncItem) {
  if (!syncItem.hasProperty("host") || !syncItem.hasProperty("isSecure") ||
      !syncItem.hasProperty("name") || !syncItem.hasProperty("isDomain") ||
      !syncItem.hasProperty("path") || !syncItem.hasProperty("value")) {
    G_DebugL(this, "ERROR: Received invalid cookie syncItem {%s}"
                   .subs(syncItem));
    
    return;
  }

  this.initLastSyncedCookies_();

  // Use the isSecure and host properties to build up a fake uri to give to
  // the cookie service. 
  var host = syncItem.getProperty("host").replace(/^\./, "");
  var protocol = syncItem.getProperty("isSecure") == "true" ? "https" : "http";
  var sUri = protocol + "://" + host + "/";
  var uri = this.ioSvc_.newURI(sUri, null, null);

  // Get a string that looks like a cookie http header.
  var cookie = this.getCookieString_(syncItem);

  // Add the cookie to the cookie store.
  this.cookieSvc_.setCookieString(uri, null, cookie, null);
  
  this.lastSyncedCookies_[syncItem.itemID] = syncItem.clone();
};

/**
 * Remove the cookie represented by the specified syncitem from the cookie 
 * store.
 */
CLB_CookieSyncer.prototype.removeCookie = function(syncItem) {
  this.initLastSyncedCookies_();

  var candidate = this.lastSyncedCookies_[syncItem.itemID];

  if (!candidate) {
    G_DebugL(this, "WARNING: Could not find cookie. Ignoring.");
    return;
  }
      
  if (!candidate.hasProperty("host") ||
      !candidate.hasProperty("name") ||
      !candidate.hasProperty("path")) {
    G_Debug(this, "ERROR: Incomplete candidate returned from cookie " + 
                  "enumerator. Ignoring. Item returned: {%s}"
                  .subs(candidate));
        
    return;
  }

  // found the cookie. huzzah!
  this.cookieMan_.remove(candidate.getProperty("host"),
                         candidate.getProperty("name"),
                         candidate.getProperty("path"),
                         false /* don't block further cookies from 
                                  this host */);

  delete this.lastSyncedCookies_[syncItem.itemID];
};

CLB_CookieSyncer.prototype.removeAllCookies = function() {
  this.cookieMan_.removeAll();
};

CLB_CookieSyncer.prototype.getCookieString_ = function (syncItem) {
  var s = syncItem.getProperty("name") + "=" + syncItem.getProperty("value");
  if (syncItem.hasProperty("expires") &&
      syncItem.getProperty("expires") != "0") {
    var expires = Number(syncItem.getProperty("expires"));
    var d = new Date(expires * 1000);
    s += "; expires=" + d.toUTCString();
  }
  if (syncItem.getProperty("isDomain") == "true") {
    // assert that host starts with '.'?
    // when we have a domain it starts with '.'
    s += "; domain=" + syncItem.getProperty("host").substring(1);
  }
  if (syncItem.hasProperty("path")) {
    s += "; path=" + syncItem.getProperty("path");
  }
  if (syncItem.getProperty("isSecure") == "true") {
    s += "; secure";
  }

  return s;
};

CLB_CookieSyncer.createSyncItem = function (cookie) {
  var item = CLB_CookieSyncer.createBlankSyncItem(cookie);

  if (!item) {
    return null;
  }

  // set the cookie's fields
  var fields = ["name", "value", "host",
                "isDomain", "path", "isSecure", "expires"];

  for (var i = 0, field; field = fields[i]; i++) {
    field = fields[i];
    item.setProperty(field, cookie[field]);
  }

  return item;
};

CLB_CookieSyncer.createBlankSyncItem = function(cookie) {
  if (cookie.expires == 0) {
    return null;
  }

  return new CLB_SyncItem({componentID: CLB_CookieSyncer.prototype.componentID,
                           itemID: CLB_CookieSyncer.createItemId_(
                               cookie.name,
                               cookie.host,
                               cookie.path,
                               String(Number(cookie.isSecure)))});
}

CLB_CookieSyncer.updateItemID = function(syncItem) {
  syncItem.itemID = CLB_CookieSyncer.createItemId_(
      syncItem.getProperty("name"),
      syncItem.getProperty("host"),
      syncItem.getProperty("path"),
      String(Number(syncItem.getProperty("isSecure") == "true")));
}

CLB_CookieSyncer.createItemId_ = function (name, host, path, isSecure) {
  if (!this.sha1_) {
    this.sha1_ = new G_CryptoHasher();
  }
  
  this.sha1_.init(G_CryptoHasher.algorithms.SHA1);

  this.sha1_.updateFromString(CLB_app.getKey());
  this.sha1_.updateFromString(name);
  this.sha1_.updateFromString(host);
  this.sha1_.updateFromString(path);
  this.sha1_.updateFromString(isSecure);
  
  return this.sha1_.digestBase64();
};

CLB_CookieSyncer.prototype.debugZone = "CLB_CookieSyncer";
G_debugService.loggifier.loggify(CLB_CookieSyncer.prototype);

if (CLB_DEBUG) {
  function TEST_CLB_CookieSyncer() {
    var zone = "TEST_CLB_CookieSyncer";
    G_Debug(zone, "Starting CLB_CookieSyncer unit tests...");

    var oneYearFromNow = new Date();
    oneYearFromNow.setYear(oneYearFromNow.getFullYear() + 1);
    oneYearFromNow = Math.floor(oneYearFromNow.getTime() / 1000);


    G_Debug(zone, "Testing createItemId_()");

    var key = CLB_app.getKey();
    CLB_app.setKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

    try {
      var testCookie = {name: "testCookie",
                        host: "testHost",
                        path: "testPath",
                        isSecure: false};

      var testCookieID = "aKyYa4ei6lOHs7DgPvVrvv7Yzps=";

      G_AssertEqual(zone, testCookieID,
                    CLB_CookieSyncer.createItemId_(
                        testCookie.name,
                        testCookie.host,
                        testCookie.path,
                        String(Number(testCookie.isSecure))),
                    "Unexpected value for test cookie itemID.");


      G_Debug(zone, "Testing createBlankSyncItem()");
    
      var blankSyncItem = new CLB_SyncItem();
      blankSyncItem.componentID = CLB_CookieSyncer.prototype.componentID;
      blankSyncItem.itemID = testCookieID;

      G_Assert(zone,
               blankSyncItem.equals(
                   CLB_CookieSyncer.createBlankSyncItem(testCookie)),
               "Created blank syncitem did not match.");


      G_Debug(zone,
              "Testing that createSyncItem() returns null for session cookies.");

      var cs = new CLB_CookieSyncer();
    
      if (!cs.cookiesEnabled) {
        G_DebugL(zone, "User has cookies disabled. Ignoring unittests.");
        return;
      }
    
      G_Assert(zone, cs != undefined, "Failed to create cookie syncer");
    
      var makeCookie =
        function(name, value, host, path, expires, isSecure, isDomain) {
          var cookie = {
            name: name,
            value: value,
            host: host,
            path: path,
            expires: expires,
            isSecure: isSecure,
            isDomain: isDomain };

          return CLB_CookieSyncer.createSyncItem(cookie);
        };

      var findCookie = function(cookie) {
        G_Debug(this, "Searching for cookie: " + cookie.itemID);
        var cookieEnum = cs.getCurrentItems();
        
        while (cookieEnum.hasMoreElements()) {
          var candidate = cookieEnum.getNext();
          G_Debug(this, "Considering: " + candidate.itemID);

          if (candidate.itemID == cookie.itemID) {
            return cookie;
          }
        }
        
        return null;
      };
                       
      var sessionCookie = makeCookie("testSessionCookie",
                                     "testSessionCookieValue",
                                     "google.com",
                                     "/",
                                     0 /* epoch */,
                                     false,
                                     false);

      G_Assert(zone, sessionCookie == null,
               "createSyncItem incorrectly created an item for a session " +
               "cookie.");

      if(cs.prefs.getPref("lifetimePolicy", 0) == 0) {
        G_Debug(zone, "Testing creating permanent cookies.");

        var permanentCookie = makeCookie("testPermanentCookie",
                                         "testPermanentCookieValue",
                                         "yahoo.com",
                                         "/foo",
                                         oneYearFromNow,
                                         false,
                                         false);

        G_Debug(zone, "permanentCookie: " + uneval(permanentCookie));

        cs.setCookie(permanentCookie);
        var foundCookie = findCookie(permanentCookie);

        G_Assert(zone, foundCookie != null,
                 "Permanent cookie was not found after setting.");
        G_Assert(zone, foundCookie.equals(permanentCookie),
                 "Found permanent cookie was not equals to original permanent " +
                 "cookie.");


        G_Debug(zone, "Testing removing cookies.");

        var removeCookie = permanentCookie.clone();
        removeCookie.clearProperties();
        removeCookie.isRemove = true;
        cs.removeCookie(removeCookie);

        G_Assert(zone, !findCookie(permanentCookie),
                 "Unexpectedly found permanent cookie after it had been removed.");
      } else {
        G_DebugL(zone, "Browser doesn't allow creation of non-permanent cookies.");
      }
    } finally {
      CLB_app.setKey(key);
    }
    
    G_Debug(zone, "All CLB_CookieSyncer unit tests passed!");
  }
}
