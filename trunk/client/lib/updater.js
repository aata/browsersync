// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Encapsulates the state of an update as it progresses through serializing all
 * pending updates, writing out a temporary file, and sending the file to 
 * storage.
 */
function CLB_Updater() {
  bindMethods(this);
}

/**
 * It's actually 32k, but we err on the side of safety since we don't know 
 * exactly how things are serialized on the server.
 * TODO(aa): remove this when the server gracefully handles overflow.
 */
CLB_Updater.MAX_ITEM_SIZE = 30 * 1024;

/**
 * The maximum size upload.
 */
CLB_Updater.MAX_UPLOAD_SIZE = 4 * 1024 * 1024;

/**
 * We assume that Firefox has forgotten to tell us that an update failed after
 * this amount of time.
 */
CLB_Updater.UPDATE_TIMEOUT = 5 * 60000; // 5 minutes

/**
 * The error code to throw when the update times out.
 */
CLB_Updater.ERROR_UPDATE_TIMEOUT = 51;

/**
 * Error code we throw when the upload size exceeds MAX_UPLOAD_SIZE.
 */
CLB_Updater.ERROR_UPLOAD_TOO_LARGE = 53;

/**
 * Error code we throw when we fail with an unexpected error before writing the
 * offline file.
 */
CLB_Updater.ERROR_APPLICATION_PRE_FILE_WRITE = -1;

/**
 * Error code we throw when we fail with an unexpected error after writing the
 * offline file.
 */
CLB_Updater.ERROR_APPLICATION_POST_FILE_WRITE = -2;

/**
 * Where we store changes made while Clobber is offline so that they can be
 * sent to the server later. Static so that it can be used by other components
 * to know whether this will happen without having to create an Updater instance
 * to figure it out.
 */
CLB_Updater.getOfflineFile = function() {
  return G_File.getProfileFile("browserstate-offline.xml");
}

CLB_Updater.hasOfflineData = function() {
  return (CLB_app.prefs.getPref("hasOfflineData") &&
          this.getOfflineFile().exists());
}

CLB_Updater.saveXML = function(doc, file) {
  var serializer = Cc["@mozilla.org/xmlextras/xmlserializer;1"]
                   .createInstance(Ci.nsIDOMSerializer);

  var contents = serializer.serializeToString(doc);
  
  // Strip invalid XML characters, see 
  // <http://www.w3.org/TR/REC-xml/#charsets> for details.
  var invalidXML = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F"
      + "\\x7F-\\x84\\x86-\\x9F"
      + String.fromCharCode(0xD800) + "-" + String.fromCharCode(0xDFFF) 
      + String.fromCharCode(0xFDD0) + "-" + String.fromCharCode(0xFDDF) 
      + String.fromCharCode(0xFFFE) + String.fromCharCode(0xFFFF)
      + String.fromCharCode(0x1FFFE) + String.fromCharCode(0x1FFFF)
      + String.fromCharCode(0x2FFFE) + String.fromCharCode(0x2FFFF)
      + String.fromCharCode(0x3FFFE) + String.fromCharCode(0x3FFFF)
      + String.fromCharCode(0x4FFFE) + String.fromCharCode(0x4FFFF)
      + String.fromCharCode(0x5FFFE) + String.fromCharCode(0x5FFFF)
      + String.fromCharCode(0x6FFFE) + String.fromCharCode(0x6FFFF)
      + String.fromCharCode(0x7FFFE) + String.fromCharCode(0x7FFFF)
      + String.fromCharCode(0x8FFFE) + String.fromCharCode(0x8FFFF)
      + String.fromCharCode(0x9FFFE) + String.fromCharCode(0x9FFFF)
      + String.fromCharCode(0xAFFFE) + String.fromCharCode(0xAFFFF)
      + String.fromCharCode(0xBFFFE) + String.fromCharCode(0xBFFFF)
      + String.fromCharCode(0xCFFFE) + String.fromCharCode(0xCFFFF)
      + String.fromCharCode(0xDFFFE) + String.fromCharCode(0xDFFFF)
      + String.fromCharCode(0xEFFFE) + String.fromCharCode(0xEFFFF)
      + String.fromCharCode(0xFFFFE) + String.fromCharCode(0xFFFFF)
      + String.fromCharCode(0x10FFFE) + String.fromCharCode(0x10FFFF) 
      + "]"
      , "g");

  contents = contents.replace(invalidXML, "");

  // IMPORTANT: Do not change this to use G_FileWriter, because that class
  // is not unicode-aware.
  var fos = Cc["@mozilla.org/network/file-output-stream;1"]
            .getService(Ci.nsIFileOutputStream);
  var cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
            .getService(Ci.nsIConverterOutputStream);

  var flags = G_File.PR_WRONLY | G_File.PR_CREATE_FILE | G_File.PR_TRUNCATE;

  fos.init(file,
           flags,
           -1 /* default perms */,
           0 /* no special behavior */);

  try {
    cos.init(fos,
             "UTF-8",
             0 /* default buffer size */,
             0x000 /* throw exceptions for invalid chars */);
    try {
      cos.writeString(contents);
    } finally {
      cos.close();
    }
  } finally {
    fos.close();
  }
}

/**
 * Cancels the updater from whatever phase it is in. If it's still building the
 * document via workqueue, cancels that. If the request has been started,
 * aborts it.
 */
CLB_Updater.prototype.cancel = function() {
  if (this.funQueue_) {
    this.funQueue_.cancel();
  }

  if (this.req_) {
    this.req_.abort();
  }
}

/**
 * Start the async process to send the specified data items to the server.
 */
CLB_Updater.prototype.start = function(data, getOfflineData, onSuccess,
                                       onFailure, onProgress,
                                       opt_sendToServer, opt_writeOfflineFile) {
  this.data_ = data || [];
  this.currentDataItem_ = null;
  this.onSuccess_ = onSuccess;
  this.onFailure_ = onFailure;
  this.onProgress_ = onProgress;
  this.wroteOfflineFile_ = false;
  this.writeOfflineFile_ = Boolean(opt_writeOfflineFile);
  this.sendToServer_ = Boolean(opt_sendToServer);

  this.doc_ = CLB_XMLUtils.getDoc("UpdateRequest",
                                  { uid: CLB_app.getSID(),
                                    mid: CLB_app.getMID(),
                                    key: CLB_app.getEncryptedKey() });

  this.items_ = this.doc_.createElement("items");
  this.clearedComponents_ = this.doc_.createElement("clearedComponents");

  this.funQueue_ = new G_WorkQueue();
  this.funQueue_.onError = this.handleWorkQueueError_;

  if (!getOfflineData) {
    G_Debug(this,
            "Skipping prepend offline step since getOfflineData is false.");
    this.funQueue_.addJob(this.buildXML_);
    return;
  }

  if (!CLB_Updater.hasOfflineData()) {
    G_Debug(this,
            "Skipping prepend offline steps because there is no offline data.");
    this.funQueue_.addJob(this.buildXML_);
    return;
  }

  this.funQueue_.addJob(this.prependOfflineData_);
}

/**
 * Reads all the offline items out of the file and into an update queue to
 * flatten duplicate changes.
 */
CLB_Updater.prototype.prependOfflineData_ = function() {
  // First parse all the data out of the offline file into an udpatequeue
  var offlineDoc = G_FirefoxXMLUtils.loadXML(CLB_Updater.getOfflineFile());

  var clearedComponentNodes = G_FirefoxXMLUtils.selectNodes(
      offlineDoc, "/g:UpdateRequest/g:clearedComponents/g:component",
      CLB_XMLUtils.gNamespaceResolver);

  var itemNodes = G_FirefoxXMLUtils.selectNodes(
      offlineDoc, "/g:UpdateRequest/g:items/g:item",
      CLB_XMLUtils.gNamespaceResolver);

  var updateQueue = new CLB_UpdateQueue();
  var syncItem, node;

  // Parse cleared components
  while (node = clearedComponentNodes.iterateNext()) {
    syncItem = new CLB_SyncItem({ componentID: node.textContent,
                                  isRemoveAll: true });

    updateQueue.addItem(syncItem);
  }

  // Parse items. This must be done asynchronously.
  var next = bind(function() {
    node = itemNodes.iterateNext();

    if (!node) {
      this.appendPendingItems_(updateQueue);
      return;
    }

    syncItem = CLB_SyncItem.parseAndDecryptFromXML(node);

    if (syncItem) {
      updateQueue.addItem(syncItem);
    }

    this.funQueue_.addJob(next);
  }, this);

  next();
}

CLB_Updater.prototype.appendPendingItems_ = function(updateQueue) {
  var idx = 0;
  var next = bind(function() {
    if (idx == this.data_.length) {
      this.data_ = updateQueue.getPending();
      this.buildXML_();
      return;
    }

    updateQueue.addItem(this.data_[idx++]);
    this.funQueue_.addJob(next);
  }, this);

  next();
}

/**
 * Asynchronously builds the XML document to send to the server.
 */
CLB_Updater.prototype.buildXML_ = function() {
  var idx = 0;
  var next = bind(function() {
    if (idx == this.data_.length) {
      this.maybeSendDoc_();
      return;
    }

    // The data array contains GISyncItems
    var nextItem = this.data_[idx];

    if (this.onProgress_) {
      this.onProgress_(CLB_Application.PROGRESS_PREPARING,
                       idx / this.data_.length);
    }

    // If the item is from a component that requires encrypted data,
    // we need to encrypt it before sending to the server.  Note
    // that we clone the item before encrypting it to prevent any potential
    // issues with using the item in the client after encryption.
    var itemIsEncrypted =
      CLB_syncMan.isEncryptedComponent(nextItem.componentID);
      
    var dataItem;
    
    if (itemIsEncrypted) {
      dataItem = nextItem.clone();
      dataItem.encrypt();
    } else {
      dataItem = nextItem;
    }
    
    idx++;
    
    if (dataItem.isRemoveAll) {
      CLB_XMLUtils.addElm(this.clearedComponents_, "component",
                          dataItem.componentID);

      this.funQueue_.addJob(next);
      return;
    }

    var itemLength = {};
    var item = dataItem.toXML(this.doc_, itemLength);

    if (itemLength.value > CLB_Updater.MAX_ITEM_SIZE) {
      G_DebugL(this, ("Not sending item {%s} because it's length {%s} " + 
                      "exceeds the maximum item length {%s}.")
                     .subs(dataItem, itemLength.value,
                           CLB_Updater.MAX_ITEM_SIZE));
    } else {
      this.items_.appendChild(item);
    }

    this.funQueue_.addJob(next);
  }, this);

  next();
}

/**
 * Finalize the document built by buildXML and save it in the offline file.
 * Decide whether to try and send it to the server or not.
 */
CLB_Updater.prototype.maybeSendDoc_ = function() {
  if (this.clearedComponents_.childNodes.length > 0) {
    this.doc_.documentElement.appendChild(this.clearedComponents_);
  }

  if (this.items_.childNodes.length > 0) {
    this.doc_.documentElement.appendChild(this.items_);
  }

  var uploadFile = this.writeOfflineFile_ ?
                   CLB_Updater.getOfflineFile() :
                   G_File.getProfileFile("browserstate-temp.xml");

  CLB_Updater.saveXML(this.doc_, uploadFile);

  // Now immediately reset the pref to true (offline data exists) and let the
  // success handler (onSuccess_, in caller) reset it to false when the 
  // request goes through successfully.
  if (this.writeOfflineFile_) {
    CLB_app.prefs.setPref("hasOfflineData", true);
  }
  
  this.wroteOfflineFile_ = true;

  var fileSize = uploadFile.fileSize;
  G_Debug(this, "upload filesize: " + fileSize);

  if (fileSize > CLB_Updater.MAX_UPLOAD_SIZE) {
    this.handleFailure_(CLB_Updater.ERROR_UPLOAD_TOO_LARGE,
                        "Upload too large", "Try disabling some components");
    return;
  }

  // If we're online, send the doc. Otherwise, error.
  if (this.sendToServer_) {
    this.definitelySendDoc_(uploadFile);
  } else {
    // In this case, we go directly to onFailure because we do not want to
    // show the status bubble or write an error to the log. (Technically
    // being offline is not an error, it's just that we can only return one
    // of two things to syncmanager, and it's success handler does totally
    // wrong things for offlineness).
    this.onFailure_(0 /* error code not used */,
                    null /* status not used */,
                    null /* message not used */);
  }
}

/**
 * Sends the updater's document which has been built up to the server.
 */
CLB_Updater.prototype.definitelySendDoc_ = function(uploadFile) {
  if (this.data_.length == 0) {
    G_Debug(this, "Not writing temp file because this is just a ping");

    this.req_ = CLB_RequestFactory.getRequest(CLB_RequestFactory.UPDATE,
                                              null,
                                              this.handleSuccess_,
                                              this.handleFailure_);

    this.req_.send(this.doc_);
    this.startTimer_();

    return;
  }

  G_Debug(this, "Sending %s new items:..."
                .subs(this.data_.length));
  
  if (CLB_app.prefs.getPref("log-xml", false)) {
    var tmpFile = CLB_app.getUniqueTempFile("upload", "xml");
    uploadFile.copyTo(tmpFile.parent, tmpFile.leafName);
    G_Debug(this, "Logging sent data in: %s...".subs(tmpFile.path));
  }
  
  // Uploads the contents of the temporary file
  var uploadInputStream = Cc["@mozilla.org/network/file-input-stream;1"]
                          .createInstance(Ci.nsIFileInputStream);

  uploadInputStream.init(uploadFile,
                         G_File.PR_RDONLY,
                         0444 /* file permissions */,
                         0 /* no special behaviors */);

  // We need to wrap uploadInputStream in nsIBufferedInputStream because
  // nsIFileInputStream does not support readSegments()
  var bufferedInputStream = Cc["@mozilla.org/network/buffered-input-stream;1"]
                            .createInstance(Ci.nsIBufferedInputStream);
  
  bufferedInputStream.init(uploadInputStream, 4096);

  this.onProgress_(CLB_Application.PROGRESS_UPDATING, 1 /* all done */);

  this.req_ = CLB_RequestFactory.getRequest(CLB_RequestFactory.UPDATE,
                                            null,
                                            this.handleSuccess_,
                                            this.handleFailure_);
  this.req_.send(bufferedInputStream);
  this.startTimer_();
}

/**
 * Starts a timeout timer for the update request. We have ocassionally seen
 * Firefox simply never call onerror or onload in an xmlhttprequest. Perhaps it
 * is a memory issue, who knows. This is a sort of last ditch attempt to make
 * sure we do not get left in a strange state waiting for the request to return
 * forever and ever.
 */
CLB_Updater.prototype.startTimer_ = function() {
  this.alarm_ = new G_Alarm(this.timerElapsed_, CLB_Updater.UPDATE_TIMEOUT);
}

/**
 * We did not get a response from the server. Count it as a failure.
 */
CLB_Updater.prototype.timerElapsed_ = function() {
  this.req_.abort();
  this.handleFailure_(CLB_Updater.ERROR_UPDATE_TIMEOUT,
                      "Request timeout",
                      "Gave up waiting for server update to return, sorry.");
}

/**
 * Called when the /update request complete successfully.
 */
CLB_Updater.prototype.handleSuccess_ = function(req) {
  this.req_ = null;

  if (this.alarm_) {
    this.alarm_.cancel();
  }
  
  CLB_app.setStatus(CLB_Application.STATUS_ONLINE);

  if (!req.responseXML) {
    G_DebugL(this,
             "ERROR: The server response was not valid XML: "
             + req.responseText);

    this.onSuccess_();
  } else {
    this.onSuccess_(CLB_XMLUtils.getTimestamp(req.responseXML));
  }
}

/**
 * Called when one of the workqueue jobs fails with a javascript error.
 * Syncman cares whether this happens before or after offline file write because
 * it determines whether it recycles the update. 
 */
CLB_Updater.prototype.handleWorkQueueError_ = function(job, e) {
  if (this.wroteOfflineFile_) {
    this.handleFailure_(CLB_Updater.ERROR_APPLICATION_POST_FILE_WRITE,
                        "Unexpected error", e.toString());
  } else {
    this.handleFailure_(CLB_Updater.ERROR_APPLICATION_PRE_FILE_WRITE,
                        "Unexpected error", e.toString());
  }
}

/**
 * Called when updater fails for whatever reason (except already being offline -
 * see maybeSendDoc_).
 */
CLB_Updater.prototype.handleFailure_ = function(code, status, message) {
  G_DebugL(this, "Updater failed with error: %s, %s, %s"
                 .subs(code, status, message)); 

  this.req_ = null;

  if (this.alarm_) {
    this.alarm_.cancel();
  }
  
  if (CLB_app.isKickError(code, status, message)) {
    CLB_app.setStatus(CLB_Application.STATUS_KICKED);
    CLB_app.lastKickTime = new Date().getTime();
  } else {
    // TODO(aa): Check for cookie expiration and reauth.
    CLB_app.setStatus(CLB_Application.STATUS_UPDATE_ERROR);
  }
  
  this.onFailure_(code, status, message);
}

CLB_Updater.debugZone = "CLB_Updater";
CLB_Updater.prototype.debugZone = "CLB_Updater";
G_debugService.loggifier.loggify(CLB_Updater.prototype);
