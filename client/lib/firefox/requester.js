// Copyright 2005 and onwards, Google

/**
 * This is a generic request system used to overcome the HTTP Basic
 * Authentication prompt when using XMLHTTPRequest (said prompt is not
 * accessible, interceptable, or amusing). SSL dialogs will also be
 * hidden.
 *
 * Example Usage:
 *
 * this.req_ = new G_Requester(30000);
 * this.req_.OnSuccess = this.SomeFunction.bind(this);
 * this.req_.OnFailure = this.SomeOtherFunction.bind(this);
 * this.req_.Open("https://www.blogger.com/atom", null, username, password);
 *
 * @constructor
 */
function G_Requester(opt_timeoutMillis) {
  this.status = "";
  this.responseText = "";

  // Default timeout in millis
  this.timeout_ = (opt_timeoutMillis) ? opt_timeoutMillis : 10000;
  this.timeoutExpired_ = false;
}

/**
 * Open URL asyncronously
 *
 * @param {String} url URL
 * @param {Object} options Options, format:
 *                  {
 *                    postData : "text to post",
 *                    username : "httpbasicauthusername",
 *                    password : "httpbasicauthpassword",
 *                    headers  : {
 *                      cookie : "name=value,name2=value2"
 *                      user-agent : "cheeselogs"
 *                    }
 *                  }
 *
 * TODO: If postData is a keyed array, use keys as POST variable names
 */
G_Requester.prototype.Open = function(url, options) {
  G_Debug(this, "Sending Async Req To: %s".subs(url));

  var channel = Cc["@mozilla.org/network/io-service;1"]
                .getService(Ci.nsIIOService)
                .newChannel(url,
                            null /* no charset */,
                            null /* no baseuri */);

  channel.QueryInterface(Ci.nsIHttpChannel);

  if (options.postData) {
    // Fix up Unicode strings
    var newData = new Array();

    for (var i = 0; i < options.postData.length; i++) {
      if (options.postData.charCodeAt(i) > 128) {
        G_Debug(this, "Fixing %s".subs(options.postData.charCodeAt(i)));
        newData.push("&#" + options.postData.charCodeAt(i) + ";");
      } else {
        newData.push(options.postData.charAt(i));
      }
    }

    newData = newData.join("");

    var uploadCh = channel.QueryInterface(Ci.nsIUploadChannel);
    var sis = Cc['@mozilla.org/io/string-input-stream;1']
               .createInstance(Ci.nsIStringInputStream);
    sis.setData(newData, -1);

    uploadCh.setUploadStream(sis, "application/xml", -1);
    channel.requestMethod = "POST";
  }

  if (isDef(options.username) || isDef(options.password)) {
    // Calculate the base64 encoded auth header (if we use
    // username:password@domain.com, and the user has a different
    // 'saved' password for that domain, moz will request the
    // u:p@ URL, but will still send the old auth basic header.

    var encoder = new G_Base64();
    var as = encoder.arrayifyString(options.username + ":" + options.password)
    var enc = encoder.encodeByteArray(as);

    channel.setRequestHeader(
      "Authorization",
      "BASIC " + enc,
      false);
  }

  channel.setRequestHeader("Content-Type", "application/xml",
                           false /* do not merge */);

  channel.setRequestHeader("Accept-Encoding", "compress, gzip",
                           false /* do not merge */);

  channel.setRequestHeader("Connection", "close", false /* do not merge */);

  if(options.headers) {
    for(var headerName in options.headers) {
      channel.setRequestHeader(headerName, options.headers[headerName],
                               false /* do not merge */);
    }
  }

  channel.asyncOpen(this, null /* no context */);

  this.timer_ = new G_Alarm(this.Timeout.bind(this), this.timeout_);
}

/**
 * Callback for timer_.
 */
G_Requester.prototype.Timeout = function() {
  // Set timeout to true so that if anything comes in afterwards, it
  // will be ignored.
  G_Debug(this, "Timeout Fired");

  this.timeoutExpired_ = true;
  this.OnFailure();
}

/**
 * Listener function for asyncopen.
 */
G_Requester.prototype.onStartRequest = function(request, context) {
  if (this.timeoutExpired_) {
    return false;
  }

  this.status = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
}

/**
 * Listener function for asyncopen. Adds incoming data to data buffer.
 */
G_Requester.prototype.onDataAvailable =
  function(request, context, inputStream, offset, count) {

  if (this.timeoutExpired_) {
    return false;
  }

  var sis = Cc["@mozilla.org/scriptableinputstream;1"]
             .createInstance(Ci.nsIScriptableInputStream);

  sis.init(inputStream);
  var text = sis.read(count);
  this.responseText += text;

  G_Debug(this, "Streaming: %s".subs(text));
}

/**
 * Listener function for asyncopen
 */
G_Requester.prototype.onStopRequest = function(request, context, status) {
  G_Debug(this, "On Stop Request");

  if (this.timeoutExpired_) {
    return false;
  }

  this.timer_.cancel();

  this.OnSuccess();
}

/**
 * Stub function for hitching by parent
 */
G_Requester.prototype.OnSuccess = function () {}

/**
 * Stub function for hitching by parent
 */
G_Requester.prototype.OnFailure = function () {}

G_Requester.prototype.debugZone = "G_Requester";
if (G_GDEBUG) {
  G_debugService.loggifier.loggify(G_Requester.prototype);
}
