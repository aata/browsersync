// Copyright (C) 2005 and onwards Google, Inc.

/**
 * CLB_StartupSequence - This class executes Clobber's startup sequence, a 
 * series of non-modal dialogs and calls back to CLB_application when complete.
 *
 * - show the login dialog
 * - if this is a new clobber user, show the import signup wizard
 * - if existing user, but new computer, show the unlock wizard
 * - if existing user and unlocked computer, perform a sync with the server
 * - finally, call back to CLB_Application to let it know that we're done
 */

function CLB_StartupSequence() {
  var winWat_ = Cc["@mozilla.org/embedcomp/window-watcher;1"]
                  .getService(Ci.nsIWindowWatcher);

  var currentDialog_ = null;
  var currentResult_ = null;
  var sequenceSuccessHandler_ = null;
  var sequenceFailureHandler_ = null;
  var dialogClosedHandler_ = null;

  this.debugZone = "CLB_Startup";


  // nsIObserver
  this.observe = function(aSubject, aTopic, aData) {
    if (aTopic == "domwindowclosed") {
      this.handleWindowClosed(aSubject.QueryInterface(Ci.nsIDOMWindow));
    } else if (aTopic == "domwindowopened") {
      G_Debug(this, "ignoring domwindowopened topic");
    } else {
      throw new Error("Caught unexpected topic {" + aTopic + "}.");
    }
  }


  /**
   * Entry point from CLB_application
   */
  this.start = function(sequenceSuccessHandler, sequenceFailureHandler) {
    sequenceSuccessHandler_ = sequenceSuccessHandler;
    sequenceFailureHandler_ = sequenceFailureHandler;

    winWat_.registerNotification(this);
    
    this.startLogin();
  }
  
  this.handleWindowClosed = function(win) {
    if (win == currentDialog_) {
      currentDialog_ = null;
      dialogClosedHandler_();
    } else {
      G_Debug(this, 
              "WARNING: received domwindowclosed event, but not from the " +
              "current window.");
    }
  }

  /**
   * Put up the dialog for the user to login to GAIA and Clobber.
   */
  this.startLogin = function() {
    this.showDialog("welcome", this.handleLoginComplete.bind(this));
  }

  this.handleLoginComplete = function() {
    if (currentResult_.getProperty("success")) {
      sequenceSuccessHandler_();
    } else {
      sequenceFailureHandler_();
    }
  }

  /**
   * Helper to show one of the modal dialogs in chrome/chromeFiles/content. The 
   * dialog is passed an nsIWritablePropertyBag in its window.arguments 
   * property.
   */
  this.showDialog = function(xulFileName, closedHandler) {
    currentResult_ = Cc["@mozilla.org/hash-property-bag;1"]
                       .createInstance(Ci.nsIWritablePropertyBag);

    currentDialog_ = winWat_.openWindow(
                      null,
                      "chrome://browserstate/content/" + xulFileName + ".xul",
                      "browserstate" + xulFileName, "centerscreen,chrome",
                      currentResult_);

    dialogClosedHandler_ = closedHandler;
  }

  G_debugService.loggifier.loggify(this);
}
