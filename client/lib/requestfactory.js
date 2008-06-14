// Copyright 2005 and onwards, Google

/**
 * An simple XMLHttpRequest factory that sets up logging and query parameters.
 * XMLHttpRequests are always POST, though this could be added as a parameter if
 * needed.
 *
 * @param url The url to post to.
 *
 * @param querystring A JS object containing name/value pairs to append to the
 * querystring. Pass null or undefined for no querystring.
 *
 * @param onSuccess(req)  A callback for when the server returns 200. The 
 * callback takes a single argument, the xmlhttprequest object itself.
 *
 * @param onFailure(statusCode, statusText, opt_responseText)  A callback 
 * for when the server either does not respond, or responds with an error. The 
 * callback takes three arguments: the http status code, and the http status 
 * message, and the response text if available.
 *
 * @param onProgress(req) A callback for progress notifications. TODO(aa): 
 * figure out what other params this takes.
 *
 * @returns a new XMLHttpRequest object with open() already called and all 
 * handlers set. Caller should populate with any post data, headers, and call
 * send.
 */
var CLB_RequestFactory = {};

CLB_RequestFactory.debugZone = "CLB_RequestFactory";

CLB_RequestFactory.PING = "";
CLB_RequestFactory.AUTHENTICATE = "https://www.google.com/accounts/ClientAuth";
CLB_RequestFactory.GENERATE_KEY = "https://www.google.com/safebrowsing/getkey";
CLB_RequestFactory.USER_EXISTS = "/verify_user_exists";
CLB_RequestFactory.ADD_CLIENT = "/add_client";
CLB_RequestFactory.CREATE_USER = "/create_user";
CLB_RequestFactory.START_SESSION = "/start_session";
CLB_RequestFactory.UPDATE = "/update";
CLB_RequestFactory.SYNC = "/sync";

CLB_RequestFactory.PROD_DOMAIN = "https://browsersync.google.com/browsersync";

CLB_RequestFactory.getURL = function(urlType) {
  if (urlType == CLB_RequestFactory.AUTHENTICATE ||
      urlType == CLB_RequestFactory.GENERATE_KEY) {
    return urlType;
  }

  var serverOverride = CLB_app.prefs.getPref("server");
  var url;
  
  if (serverOverride) {
    url = serverOverride + urlType;
  } else {
    url = CLB_RequestFactory.PROD_DOMAIN + urlType;
  }
  
  // PING url must be http by design -- the whole point of it is to test
  // for an http redirect. https won't work.
  if (urlType == CLB_RequestFactory.PING) {
    url = url.replace(/^https/, "http");
  }

  return url;
}

CLB_RequestFactory.getRequest = 
function(urlType, querystring, onSuccess, onFailure, opt_onProgress, 
         opt_useGet) {
  var url = this.getURL(urlType);
  var req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
              .createInstance(Ci.nsIXMLHttpRequest);

  var params = [];

  if (!querystring) {
    querystring = {};
  }

  // Send version of Clobber as a querystring argument to help in debugging,
  // but don't send it to other servers which aren't expecting it.
  if (urlType != CLB_RequestFactory.AUTHENTICATE &&
      urlType != CLB_RequestFactory.GENERATE_KEY) {
    querystring["v"] = CLB_app.getVersion();
  }

  if (!isEmptyObject(querystring)) {
    for (var name in querystring) {
      params.push(name + "=" + querystring[name]);
    }

    url += "?" + params.join("&");
  }

  req.async = true;

  G_DebugL(this, "opening %s...".subs(url));
  req.open(opt_useGet ? "GET" : "POST", url);

  req.onload = function() {
    if (req.status == 200) {
      G_DebugL(CLB_RequestFactory, "Received successful response.");
      onSuccess(req);
    } else {
      G_DebugL(CLB_RequestFactory, 
               "Server error for %s. %s %s: %s"
               .subs(url, req.status, req.statusText, req.responseText));
      onFailure(req.status, req.statusText, req.responseText);
    }
  }

  req.onerror = function() {
    G_DebugL(CLB_RequestFactory, "Could not contact server for: %s".subs(url));
    onFailure(CLB_RequestFactory.ERR_COULD_NOT_CONTACT_SERVER, 
              "Could not contact server.");
  }

  if (opt_onProgress) {
    req.onprogress = opt_onProgress;
  }

  req.channel.notificationCallbacks = new CLB_BadCertListener();

  return req;
}

CLB_RequestFactory.ERR_COULD_NOT_CONTACT_SERVER = 50;

G_debugService.loggifier.loggify(CLB_RequestFactory);
