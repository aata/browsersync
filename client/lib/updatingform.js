// Copyright 2005 and onwards, Google

function CLB_UpdatingForm(win) {
  this.win = win;
  this.appStatus = CLB_app.getStatus();
}

CLB_UpdatingForm.prototype.debugZone = "CLB_UpdatingForm";

CLB_UpdatingForm.prototype.handleFormLoad = function() {
  this.doc = this.win.document;
  this.statusElm = this.doc.getElementById("clb-status");
  this.progressElm = this.doc.getElementById("clb-progress");
  
  if (CLB_syncMan.checkPending()) {
    G_Debug(this, "We have some stuff to send to the server.");
    
    G_Debug(this, "Sending final update");
    CLB_syncMan.addObserver(this);
    CLB_syncMan.sendPending(true /* is final send */);
  } else if (CLB_syncMan.checkSending()) {
    CLB_syncMan.addObserver(this);
    G_Debug(this, "Updatingform is modally blocking so that "
                + "another update can finish");
  } else {
    // We shouldn't get into this state, but it's possible
    // that sync manager finished sending its existing update
    // between this dialog opening and this method running
    // (@see CLB_Application#handleApplicationQuit)
    G_Debug(this, "Warning: updatingform didn't need to exist");
    this.win.setTimeout("window.close()", 0);
  }
}

CLB_UpdatingForm.prototype.syncProgress =
CLB_UpdatingForm.prototype.updateProgress = function(percent, status) {
}

CLB_UpdatingForm.prototype.syncComplete =
CLB_UpdatingForm.prototype.updateComplete = function() {
  CLB_syncMan.removeObserver(this);
  this.win.setTimeout("window.close()", 0);
}

CLB_UpdatingForm.prototype.syncFailure = 
CLB_UpdatingForm.prototype.updateFailure =
function(code, status, opt_message) {
  try {
    CLB_syncMan.removeObserver(this);

    // We don't alert any errors here. Just let the app shut down already :).
    // Most server-type errors will be caught next time anyway.
    CLB_app.handleServerError(code, status, opt_message);
  } finally {
    this.win.setTimeout("window.close()", 0);
  }
}

G_debugService.loggifier.loggify(CLB_UpdatingForm.prototype);
