// Copyright 2006 and onwards, Google

function CLB_LoginUtil() {
}

CLB_LoginUtil.prototype.startRequest = function(username, password, onSuccess, 
                                                onFailure) {
  var req = CLB_RequestFactory.getRequest(
              CLB_RequestFactory.AUTHENTICATE, 
              null /* no querystring */, 
              onSuccess,
              onFailure);  

  req.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
  req.send(this.encodeParams_({ Email: username,
                                Passwd: password,
                                PersistentCookie: true,
                                source: "browserstate" }));

  return req;
}

/**
 * Utility to parse responses from GAIA 
 */
CLB_LoginUtil.prototype.parseResponse = function(responseString) {
  var lines = responseString.split(/\n/);
  var details = {};
  var line;

  for (var i = 0; line = lines[i]; i++) {
    line = line.split("=");
    details[line.shift()] = line.join("=");
  }

  return details;
}

/**
 * Determine whether an error from GAIA is an authentication problem (it might
 * be solved by typing in credentials again).
 */
CLB_LoginUtil.prototype.isAuthError = function(responseString) {
  return this.parseResponse(responseString)["Error"] == "badauth";
}

/**
 * Shows an error message for the specified GAIA error response string.
 *
 * @returns true if the caller should give the user a chance to try again, false
 * otherwise. Currently, only captcha errors return false. The info bubble knows
 * about this state and shows the user a button they can use to revalidate their
 * account.
 */
CLB_LoginUtil.prototype.showErrorMessage = function(parentWin, responseString) {
  var resp = this.parseResponse(responseString);
  var code = resp["Error"];

  if (code == "cr") {
    parentWin.alert("The specified Google account has been " + 
                    "temporarily locked. Please verify your account and " + 
                    "then reconnect to Google Browser Sync.");

    CLB_app.setStatus(CLB_Application.STATUS_NEEDS_CAPTCHA);
    CLB_app.errorURL = resp["Url"];

    return false;
  }

  var msg = { "badauth" : "Incorrect username or password. Please try again.",
              "adel"    : "The specified Google account has been deleted.",
              "adis"    : "The specified Google account has been disabled.",
              "nv"      : "The specified Google account's email address has " +
                          "not been verified.",
              "tna"     : "The specified Google user has not agreed to the " +
                          "terms of service.",
              "ire"     : "Authentication server temporarily unavailable. " +
                          "Please try again later.",
              "unknown" : "Unknown authentication server error. Please try " + 
                          "again later."
            } [code];

  if (!msg) {
    msg = "Unknown server error. Please try again later.";
  }

  parentWin.alert(msg);
  return true;
}

/**
 * Utility to URL encode a JS object full of name/value pairs.
 */
CLB_LoginUtil.prototype.encodeParams_ = function(params) {
  var s = [];

  for (var p in params) {
    s.push(encodeURIComponent(p));
    s.push("=");
    s.push(encodeURIComponent(params[p]));
    s.push("&");
  }

  return s.join("");
}

CLB_LoginUtil.prototype.debugZone = "CLB_LoginUtil";
G_debugService.loggifier.loggify(CLB_LoginUtil.prototype,
                                 "startRequest");
