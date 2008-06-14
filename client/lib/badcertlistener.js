// Copyright 2006 and onwards, Google

function CLB_BadCertListener() {
}

// nsISupports
CLB_BadCertListener.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsIBadCertListener) ||
      iid.equals(Ci.nsIInterfaceRequestor) ||
      iid.equals(Ci.nsISupports)) {
    return this;
  }

  throw Components.results.NS_ERROR_NO_INTERFACE;
}

// nsIInterfaceRequestor
CLB_BadCertListener.prototype.getInterface = function(iid) {
  if (iid.equals(Ci.nsIBadCertListener)) {
    return this;
  }

  Components.returnCode = Components.results.NS_ERROR_NO_INTERFACE;

  return null;
}

// nsIBadCertListener
CLB_BadCertListener.prototype.confirmUnknownIssuer = function() {
  return false;
}

CLB_BadCertListener.prototype.confirmCertExpired = function() {
  return false;
}

CLB_BadCertListener.prototype.notifyCrlNextupdate = function() {
}

CLB_BadCertListener.prototype.confirmMismatchDomain = function(socketInfo,
                                                               targetURL,
                                                               cert) {
  if (cert.commonName == "www.google.com") {
    return true;
  }

  return false;
}
