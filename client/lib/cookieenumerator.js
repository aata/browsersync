// Copyright 2005 and onwards, Google

/**
 * A wrapper around the cookie manager enumerator
 */
function CLB_CookieEnumerator() {
  var cm = Cc["@mozilla.org/cookiemanager;1"].getService(Ci.nsICookieManager);
  this.e_ = cm.enumerator;
  this.advanceToNext_();
}

CLB_CookieEnumerator.prototype. QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsISimpleEnumerator)) {
    return this;
  } else {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
}

CLB_CookieEnumerator.prototype.hasMoreElements = function() {
  return this.next_ != null;
}

CLB_CookieEnumerator.prototype.getNext = function() {
  var retVal = this.next_;
  this.advanceToNext_();
  return retVal;
}

CLB_CookieEnumerator.prototype.advanceToNext_ = function() {
  this.next_ = null;

  while (this.next_ == null && this.e_.hasMoreElements()) {
    var cookie = this.e_.getNext();
    cookie.QueryInterface(Ci.nsICookie);

    // This might set next_ to null, because createSyncItem() sometimes returns
    // null for session cookies. That's OK, we keep rolling since the while
    // loop checks for null.
    this.next_ = CLB_CookieSyncer.createSyncItem(cookie);
  }
}

CLB_CookieEnumerator.prototype.debugZone = "CLB_CookieEnumerator";
G_debugService.loggifier.loggify(CLB_CookieEnumerator.prototype);
