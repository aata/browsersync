// Copyright 2005 and onwards, Google


/**
 * CLB_ComponentSelector
 * Controller for component-selector.xul
 */
function CLB_ComponentSelector(root) {
  this.root_ = root;
  this.doc_ = this.root_.ownerDocument;
  this.win_ = this.doc_.defaultView;
}

/**
 * Setup the control for the first render. Load the current synced and encrypted
 * components out of the preferences system.
 */
CLB_ComponentSelector.prototype.load = function() {
  this.learnMore_ = this.doc_.getElementById("clb-componentselector-learnmore");
  this.learnMore_.onclick = this.showLearnMore.bind(this);
  
  this.list_ = this.doc_.getElementById("clb-settings-list");

  // As load may be called multiple times (due to resync), clear the
  // current items out of the list.
  var items = this.list_.getElementsByTagName("listitem");
  
  while(items.length > 0) {
    this.list_.removeChild(items[0]);
  }

  var componentIterator = CLB_syncMan.getComponents();
  var components = [];
  var component;

  while (component = componentIterator.getNext()) {
    if (component.QueryInterface) {
      component.QueryInterface(Ci.GISyncComponent);
    }

    // We do not allow users to change whether to sync clobber's internal 
    // settings, since that would break clobber.
    if (component.componentID == CLB_SettingsSyncer.CONTRACT_ID) {
      continue;
    }

    components.push(component);
  }

  // sort the components by encryption required-ness (required ones 
  // first), then by name, alphebetically.
  components.sort(CLB_ComponentSelector.componentSort_);

  function lookupify(arr) {
    var dict = {};

    for (var i = 0; i < arr.length; i++) {
      dict[arr[i]] = true;
    }

    return dict;
  }

  var syncedComponents = lookupify(CLB_app.getListPref("syncedComponents"));
  var encryptedComponents =
    lookupify(CLB_app.getListPref("encryptedComponents"));

  for (var i = 0; component = components[i]; i++) {
    this.list_.appendChild(
        this.createSettingsListItem_(
            component,
            syncedComponents[component.componentID],
            encryptedComponents[component.componentID])
            );
  }
  
  // Force callbacks to update parent ok/next buttons with current 
  // state. Note that if a user changes their prefs to not have 
  // any components selected then opens a settings dialog, the OK
  // button will disable itself.
  this.checkCheckboxState();
}

/**
 * Save the current state of the control. Saves the values the user selected
 * into the preferences system.
 */
CLB_ComponentSelector.prototype.save = function() {
  var result = this.getChoices();
  CLB_app.setListPref("syncedComponents", result.syncedComponents);
  CLB_app.setListPref("encryptedComponents", result.encryptedComponents);
}

/**
 * Get the current state of the control.
 */
CLB_ComponentSelector.prototype.getChoices = function() {
  this.list_ = this.doc_.getElementById("clb-settings-list");

  var item;
  var checkbox1;
  var checkbox2;
  var syncedComponents = [];
  var encryptedComponents = [];
  var items = this.list_.getElementsByTagName("listitem");

  for (var i = 0; item = items[i]; i++) {
    checkbox1 = item.getElementsByTagName("checkbox")[0];
    checkbox2 = item.getElementsByTagName("checkbox")[1];

    if (checkbox1.checked) {
      syncedComponents.push(item.__componentID);

      if (checkbox2.checked) {
        encryptedComponents.push(item.__componentID);
      }
    }
  }
  
  return {
    syncedComponents: syncedComponents,
    encryptedComponents: encryptedComponents
  }
}

/**
 * Determines if current selection is valid.
 */
CLB_ComponentSelector.prototype.isValid = function() {
  var items = this.list_.getElementsByTagName("listitem");

  for (var i = 0, item; item = items[i]; i++) {
    var checkbox1 = item.getElementsByTagName("checkbox")[0];
    
    if(checkbox1.checked) {
      G_Debug(this, "A check box was checked");
      return true;
    }
  }
  
  G_Debug(this, "No checkboxes were checked");
  return false;
}

/**
 * Fires callback with state of current selection - this is used
 * to disable the 'next' button in welcomeform when no settings
 * are selected and to disable the 'OK' button in the settings form.
 */
CLB_ComponentSelector.prototype.checkCheckboxState = function() {
  this.settingsChanged(this.isValid());
}

/**
 * Stub function for callback
 */
CLB_ComponentSelector.prototype.settingsChanged = function() {}

/**
 * Private helper to create a list item for the control for a given
 * GISyncComponent instance.
 */
CLB_ComponentSelector.prototype.createSettingsListItem_ = function(component,
                                                                   synced,
                                                                   encrypted) {
  var item = this.doc_.createElement("listitem");

  item.setAttribute("allowevents", "true");
  item.__componentID = component.componentID;

  var nameCell = this.doc_.createElement("listcell");
  nameCell.setAttribute("label", component.componentName);
  item.appendChild(nameCell);

  var enabledCell = this.doc_.createElement("listcell");
  var enabledCheckbox = this.doc_.createElement("checkbox");
  
  if (synced) {
    enabledCheckbox.setAttribute("checked", "true");
  }
 
  enabledCell.appendChild(enabledCheckbox);
  enabledCheckbox.addEventListener("command", 
                                   this.checkCheckboxState.bind(this), false);
  item.appendChild(enabledCell);

  // XXX HACK
  // An unfortunate bug in XUL is making it so that using disabled property
  // programatically makes a checkbox unselectable, but *not* unfocusable. The
  // result is that the UI seems broken because you can click on a disabled
  // checkbox, but it doesn't change state. To work around this, we create two
  // checkboxes for encryption: one stays disabled and one stays enabled, and
  // we toggle them on and off to simulate using the disabled property.
  
  var encryptionCell = this.doc_.createElement("listcell");
  var encryptionCheckbox = this.doc_.createElement("checkbox");
  var disabledEncryptionCheckbox = this.doc_.createElement("checkbox");
  encryptionCheckbox.checked_ = encrypted;
   
  disabledEncryptionCheckbox.setAttribute("disabled", true);
  disabledEncryptionCheckbox.collapsed = true;

  // Setup the encrypt checkbox to be disabled when the component checkbox is
  // not checked. Also, record and store the checked state so that it can be
  // cleared while the checkbox is disabled and restored if it becomes checked
  // again.
  var checkboxStateChangeHandler = function() {
    G_Debug(this, "enabled checkbox changed. checked: {%s}"
                  .subs(enabledCheckbox.getAttribute("checked")));

    if (enabledCheckbox.getAttribute("checked")) {
      if (component.encryptionRequired) {
        encryptionCheckbox.setAttribute("checked", true);
        disabledEncryptionCheckbox.setAttribute("checked", true);
        disabledEncryptionCheckbox.setAttribute("label", "(always)");
        disabledEncryptionCheckbox.setAttribute("class", "labelled");
        disabledEncryptionCheckbox.collapsed = false;
        encryptionCheckbox.collapsed = true;
      } else {
        encryptionCheckbox.setAttribute("checked", 
                                        encryptionCheckbox.checked_);
        encryptionCheckbox.collapsed = false;
        disabledEncryptionCheckbox.collapsed = true;
      }
    } else {
      if (component.encryptionRequired) {
        disabledEncryptionCheckbox.setAttribute("label", "");
        disabledEncryptionCheckbox.setAttribute("class", ""); 
      }
      
      encryptionCheckbox.collapsed = true;
      disabledEncryptionCheckbox.setAttribute("checked", false);
      disabledEncryptionCheckbox.collapsed = false;
      encryptionCheckbox.checked_ = encryptionCheckbox.checked;
      encryptionCheckbox.setAttribute("checked", false);
    }
  }.bind(this);

  enabledCheckbox.addEventListener("CheckboxStateChange",
                                   checkboxStateChangeHandler,
                                   false);
  
  encryptionCell.appendChild(encryptionCheckbox);
  encryptionCell.appendChild(disabledEncryptionCheckbox);
  item.appendChild(encryptionCell);

  // call the handler once to get the initial UI state correct.
  checkboxStateChangeHandler();

  return item;
}

CLB_ComponentSelector.prototype.showLearnMore = function() {
  var width = 300;
  var height = 300;
  var left = this.win_.screenX + (this.win_.outerWidth - width) / 2;
  var top = this.win_.screenY + (this.win_.outerHeight - height) / 2;

  this.win_.open("chrome://browserstate/content/learnmore2.html",
                 "learnmore",
                 "width=%s,height=%s,left=%s,top=%s,scrollbars=yes,chrome,dialog"
                 .subs(width, height, left, top));
}

CLB_ComponentSelector.prototype.debugZone = "CLB_ComponentSelector";
G_debugService.loggifier.loggify(CLB_ComponentSelector.prototype);

CLB_ComponentSelector.componentSort_ = function(a, b) {
  a = Number(!a.encryptionRequired) + a.componentName.toLowerCase();
  b = Number(!b.encryptionRequired) + b.componentName.toLowerCase();

  if (a > b) {
    return 1;
  } else if (a < b) {
    return -1;
  } else {
    return 0;
  }
}
