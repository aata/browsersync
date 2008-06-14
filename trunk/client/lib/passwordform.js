// Copyright 2006 and onwards, Google

function CLB_PasswordForm(win) {
  this.win_ = win;
  this.args_ = this.win_.arguments[0].QueryInterface(Ci.nsIWritablePropertyBag);

  this.args_.setProperty("success", false);
  this.args_.setProperty("password", "");
}

CLB_PasswordForm.DIALOG_WIDTH = 350;

// This is just an estimate used for centering. The real value is determined by
// the browser's sizeToContent() function in handleDialogLoad
CLB_PasswordForm.DIALOG_HEIGHT = 130;

CLB_PasswordForm.show = function(parent) {
  var result = Cc["@mozilla.org/hash-property-bag;1"]
               .createInstance(Ci.nsIWritablePropertyBag);

  var left = (parent.outerWidth - this.DIALOG_WIDTH) / 2 + parent.screenX;
  var top = (parent.outerHeight - this.DIALOG_HEIGHT) / 2 + parent.screenY;
  var features = "modal,dialog,left=%s,top=%s".subs(left, top);

  Cc["@mozilla.org/embedcomp/window-watcher;1"]
    .getService(Ci.nsIWindowWatcher)
    .openWindow(null /* No parent! Setting this makes the opened window 
                        initially load the same URL as the parent, then 
                        switch to the specified URL a moment later. So 
                        basically: all hell breaks loose. GOD DAMN YOU 
                        XUL! */, 
                "chrome://browserstate/content/password.xul", 
                "password" /* name */, 
                features, 
                result);

  return result;
}

/**
 * Initializes the dialog. Called by the load handler in password.xul.
 */
CLB_PasswordForm.prototype.handleDialogLoad = function() {
  this.doc_ = this.win_.document;
  this.dialog_ = this.doc_.documentElement;

  this.usernameField_ = this.doc_.getElementById("clb-username");
  this.passwordField_ = this.doc_.getElementById("clb-password");
  this.usernameField_.value = CLB_app.prefs.getPref("username");

  this.dialog_.setAttribute("width", CLB_PasswordForm.DIALOG_WIDTH);
  this.win_.sizeToContent();
}

/**
 * Handles the dialog being accepted. Log the user into GAIA, then check 
 * whether they are an existing Clobber user.
 */
CLB_PasswordForm.prototype.handleDialogAccept = function() {
  this.args_.setProperty("success", true);
  this.args_.setProperty("password", this.passwordField_.value);
}

CLB_PasswordForm.prototype.debugZone = "CLB_PasswordForm";
G_debugService.loggifier.loggify(CLB_PasswordForm.prototype, "CLB_PasswordForm");
