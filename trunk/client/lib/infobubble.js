// Copyright 2005 and onwards, Google

/**
 * The InfoBubble is like a really big tooltip with rich content. It can have
 * buttons, text, links, etc. It has a little arrow that points to an item on
 * the toolbar and it knows how to position itself so that the arrow points 
 * correctly.
 * 
 * It also knows how to repaint itself on tab switches, which is necessary to 
 * keep it on top because of various bugs in Firefox.
 */
function CLB_InfoBubble(root, tabbedBrowserWatcher, width) {
  bindMethods(this);

  this.hidden = true;

  this.root_ = root;
  this.inner_ = root.firstChild;
  this.head_ = root.previousSibling;
  this.tail_ = root.nextSibling;
  this.parts_ = [this.head_, this.root_, this.tail_];
  this.repaintAlarm_ = null;
  this.width_ = width;
  this.root_.style.width = width + "px";
  this.inner_.style.width = 
    (width - CLB_InfoBubble.INNER_BUBBLE_DIFFERENCE) + "px";

  this.doc_ = this.root_.ownerDocument;
  this.win_ = this.doc_.defaultView;
  this.tabbedBrowserWatcher_ = tabbedBrowserWatcher;

  var elms = this.root_.getElementsByTagName("*");

  for (var i = 0, elm = null; elm = elms[i]; i++) {
    switch (elm.className) {
      case "clb-infobubble-desc":
        this.desc_ = elm;
        break;
      case "clb-infobubble-buttons":
        this.buttonsContainer_ = elm;
        break;
      case "clb-infobubble-close":
        this.closeButton_ = elm;
        break;
    }
  }

  this.tabbedBrowserWatcher_.registerListener("tabswitch", 
                                              this.handleTabSwitch_);
  this.win_.addEventListener("unload", this.handleUnload_, false);
  this.win_.addEventListener("resize", this.handleResize_, false);

  // register myself in the list of all instances
  CLB_InfoBubble.nextInstanceId_++;
  this.instanceId_ = CLB_InfoBubble.nextInstanceId_;
  CLB_InfoBubble.instances_[this.instanceId_] = this;
}

CLB_InfoBubble.ARROW_WIDTH = 20;
CLB_InfoBubble.ARROW_HEIGHT = 20;
CLB_InfoBubble.ROOT_OFFSET = 50;
CLB_InfoBubble.ARROW_OFFSET = 16;
CLB_InfoBubble.ROOT_MIN_RIGHT = 25;
CLB_InfoBubble.ROOT_MIN_LEFT = 4;
CLB_InfoBubble.INNER_BUBBLE_DIFFERENCE = 16;
CLB_InfoBubble.HIDE_DELAY_MILLISECONDS = 10000;

CLB_InfoBubble.instances_ = {};
CLB_InfoBubble.nextInstanceId_ = 1;
CLB_InfoBubble.allHidden = false;

/**
 * Hide all info bubbles in all windows.
 */
CLB_InfoBubble.hideAll = function() {
  G_Debug("CLB_InfoBubble", "hiding all");
  for (var bubble in this.instances_) {
    G_Debug("CLB_InfoBubble", bubble);
    this.instances_[bubble].hide();
  }
  G_Debug("CLB_InfoBubble", "done");

  this.allHidden = true;
}

/**
 * Reposition all infobubbles.
 */
CLB_InfoBubble.repositionAll = function(anchor) {
  G_Debug("CLB_InfoBubble", "reshowing all");
  for (var bubble in this.instances_) {
    G_Debug("CLB_InfoBubble", bubble);
    if (!this.instances_[bubble].hidden) {
      this.instances_[bubble].show(anchor);
    }
  }
  G_Debug("CLB_InfoBubble", "done");
}

/**
 * Reposition each bubble at the correct place. This happens on a timer to catch 
 * changes in screen layout that are hard to detect, such as toolbar 
 * customization. We use one static timer for all windows to conserve timers, 
 * which can be expensive. If no visible bubbles are found, cancel the timer.
 * It will be restarted in show() the next time one is opened.
 */
CLB_InfoBubble.repaintAll_ = function() {
  var anyVisible = false;

  for (var id in this.instances_) {
    if (!this.instances_[id].hidden) {
      anyVisible = true;
      this.instances_[id].repaint_();
    }
  }

  if (!anyVisible) {
    if (this.repaintAlarm_) {
      this.repaintAlarm_.cancel();
      this.repaintAlarm_ = null;
    }
  }
}

/**
 * Show the info bubble with the current buttons and message at the right place
 * relative to the toolbarItem. It will have either a left arrow or right arrow
 * depending on whether the toolbarItem is on the left or right of the screen.
 * Restart the repaint timer if it isn't running.
 */
CLB_InfoBubble.prototype.show = function(toolbarItem) {
  G_Debug(this, "Showing info bubble");
  
  this.toolbarItem_ = toolbarItem;
  this.repaint_();

  this.hidden = false;
  CLB_InfoBubble.allHidden = false;

  if (!CLB_InfoBubble.repaintAlarm_) {
    CLB_InfoBubble.repaintAlarm_ = 
      new G_Alarm(CLB_InfoBubble.repaintAll_.bind(CLB_InfoBubble), 2000, true);
  }

  this.startTimer_();
}

/**
 * Begin the timer to hide the bubble after HIDE_DELAY_SECONDS
 */
CLB_InfoBubble.prototype.startTimer_ = function() {
  G_Debug(this, "Starting timer to wait before hooking up onLocationChange");
  
  if (this.hideAlarm_) {
    G_Debug(this, "cancelling existing hide alarm...");
    this.hideAlarm_.cancel();
  }

  this.hideAlarm_ = new G_Alarm(this.waitForLocationChange_, 
                                CLB_InfoBubble.HIDE_DELAY_MILLISECONDS);
}

/**
 * Start waiting for onLocationChange. When it occurs, hide the bubble.
 */
CLB_InfoBubble.prototype.waitForLocationChange_ = function() {
  G_Debug(this, "Timer elapsed. Waiting for location change.");
  
  this.hideAlarm_ = null;
  this.tabbedBrowserWatcher_.registerListener("locationchange",
                                              this.handleLocationChange_);
}

/**
 * Handles onLocationChange from the tabbedbrowserwatcher. When it occurs, hide
 * the bubble.
 */
CLB_InfoBubble.prototype.handleLocationChange_ = function() {
  G_Debug(this, "Got location change. Hiding all info bubbles.");

  this.tabbedBrowserWatcher_.removeListener("locationchange",
                                            this.handleLocationChange_);
  CLB_InfoBubble.hideAll();
}

/**
 * Hide the bubble.
 */
CLB_InfoBubble.prototype.hide = function() {
  G_Debug(this, "numparts: %s".subs(this.parts_.length));
  this.parts_.forEach(function(part) {
    part.hidden = true;
    part.style.top = "";
    part.style.bottom = "";
    part.style.left = "";
    part.style.right = "";
  });

  this.hidden = true;
}

/**
 * Reposition the bubble in the correct place based on the current window 
 * layout.
 */
CLB_InfoBubble.prototype.repaint_ = function() {
  // Make sure that the target exists (if the user opens the customize dialog
  // and drags the item off the toolbar, it will still technically exist, but
  // any attempts to access its properties will result in an exception being
  // thrown. Look for this, and if there's an error, assume that the 
  // toolbaritem has been removed. Note that repositionAll will still take
  // care of this when the customize dialog is closed (and will take care of
  // the case where the user creates the toolbaritem).
  try {
    var x = this.toolbarItem_.boxObject;
  } catch(e) {
    this.toolbarItem_ = null;
    return;
  }
  
  if (this.toolbarItem_.ownerDocument == this.root_.ownerDocument) {
    if (x < (this.win_.innerWidth  / 2)) {
      this.paintLeft_();
    } else {
      this.paintRight_();
    }
  } else {
    this.paintAlone_();
  }
}

/**
 * Helper to show the bubble on the left of the screen.
 */
CLB_InfoBubble.prototype.paintLeft_ = function() {
  var arrowTop = this.toolbarItem_.boxObject.y + 
                 Math.round(this.toolbarItem_.boxObject.height * 0.75);

  var rootTop = arrowTop + CLB_InfoBubble.ARROW_HEIGHT;
  
  var arrowLeft = this.toolbarItem_.boxObject.x +
                  CLB_InfoBubble.ARROW_OFFSET;

  var rootLeft = arrowLeft -
                 CLB_InfoBubble.ROOT_OFFSET;

  if (rootLeft < CLB_InfoBubble.ROOT_MIN_LEFT) {
    rootLeft = CLB_InfoBubble.ROOT_MIN_LEFT;
  }

  this.head_.style.top = arrowTop + "px";
  this.head_.style.bottom = "";
  this.root_.style.top = rootTop + "px";
  this.root_.style.bottom = "";
  this.root_.style.left = rootLeft + "px";
  this.root_.style.right = "";
  this.head_.style.left = arrowLeft + "px";
  this.head_.style.right = "";

  this.head_.firstChild.src = "chrome://browserstate/content/head-left.png";
  this.head_.hidden = false;
  this.root_.hidden = false;
}

/**
 * Helper to show the bubble on the right of the screen.
 */
CLB_InfoBubble.prototype.paintRight_ = function() {
  var arrowTop = this.toolbarItem_.boxObject.y + 
                 Math.round(this.toolbarItem_.boxObject.height * 0.50);

  var rootTop = arrowTop + CLB_InfoBubble.ARROW_HEIGHT;

  var arrowRight = this.win_.innerWidth -
                   this.toolbarItem_.boxObject.x -
                   CLB_InfoBubble.ARROW_OFFSET;

  var rootRight = arrowRight -
                  this.width_ +
                  CLB_InfoBubble.ROOT_OFFSET;

  if (rootRight < CLB_InfoBubble.ROOT_MIN_RIGHT) {
    rootRight = CLB_InfoBubble.ROOT_MIN_RIGHT;
  }

  this.head_.style.top = arrowTop + "px";
  this.head_.style.bottom = "";
  this.root_.style.top = rootTop + "px";
  this.root_.style.bottom = "";
  this.root_.style.right = rootRight + "px";
  this.root_.style.left = "";
  this.head_.style.right = arrowRight + "px";
  this.head_.style.left = "";

  this.head_.firstChild.src = "chrome://browserstate/content/head-right.png";
  this.head_.hidden = false;
  this.root_.hidden = false;
}

/**
 * Helper to show the bubble when no anchor is available.
 */
CLB_InfoBubble.prototype.paintAlone_ = function() {
  this.root_.style.top = 
    this.doc_.getElementById("content").boxObject.y + 8 + "px";
  this.root_.style.bottom = "";
  this.root_.style.right = "8px";
  this.root_.style.left = "";
  this.root_.hidden = false;
  this.head_.hidden = true;
}

/**
 * Clear the message and all buttons.
 */
CLB_InfoBubble.prototype.clear = function() {
  if (this.desc_.firstChild) {
    this.desc_.removeChild(this.desc_.firstChild);
  }

  while (this.buttonsContainer_.firstChild) {
    this.buttonsContainer_.removeChild(this.buttonsContainer_.firstChild);
  }
}

/**
 * Change the currently displayed message.
 */
CLB_InfoBubble.prototype.setMessage = function(txt) {
  this.desc_.appendChild(this.doc_.createTextNode(txt));
}

/**
 * Add a button/text/callback combination to the bubble. The callback is saved
 * in an expando property of the button because we need to sometimes remove the
 * bubble from the DOM and doing so clears the events as well. Later when we
 * re-add the bubble to the DOM, we'll have lost the events.
 */
CLB_InfoBubble.prototype.addButton = function(text, callback) {
  var button = this.doc_.createElement("button");

  button.setAttribute("label", text);

  // XXX total hack, but addEventListener gets lost when the dom tree gets 
  // removed and re-added, which happens frequently with info bubble.
  button._command = callback;
  button.setAttribute("oncommand", "this._command()");

  this.buttonsContainer_.appendChild(button);
}

/**
 * Because of XUL quirks, we need to reparent the infobubble on tabswitch or it
 * will show up underneath the tab content.
 */
CLB_InfoBubble.prototype.handleTabSwitch_ = function() {
  G_Debug(this, "Heard tabswitch. Reparenting {%s} parts."
                .subs(this.parts_.length));

  for (var i = 0; i < this.parts_.length; i++) {
    this.reparent_(this.parts_[i]);
  }
}

/**
 * Helper to reparent a node. This works differently on windows vs. linux. On
 * Windows, I need to remove the element from it's parent, then re-add it, and
 * this makes it paint on top again. On Linux, I need to increment it's zIndex.
 */
CLB_InfoBubble.prototype.reparent_ = function(elm) {
  var z = this.win_.document.defaultView.getComputedStyle(elm, "")
          .getPropertyValue("z-index");
  var marker = elm.nextSibling;
  var parent = elm.parentNode;

  // windows
  parent.removeChild(elm);
  parent.insertBefore(elm, marker);

  // linux
  elm.style.zIndex = parseInt(z) + 1;
}

/**
 * Delete the info bubble's instance from the registry to clear it's memory.
 */
CLB_InfoBubble.prototype.handleUnload_ = function() {
  delete CLB_InfoBubble.instances_[this.instanceId_];
}

/**
 * Reposition the button if it is visible.
 */
CLB_InfoBubble.prototype.handleResize_ = function() {
  if (!this.hidden) {
    this.repaint_();
  }
}

CLB_InfoBubble.prototype.debugZone = "CLB_InfoBubble";
G_debugService.loggifier.loggify(CLB_InfoBubble.prototype);
