// Copyright (C) 2005 and onwards Google, Inc.

/**
 * Default implementation of GISyncItem. All the fields in opt_fields are also
 * optional. However componentID and itemID must be set before sending a 
 * syncItem to syncMan.update();
 *
 * Example usage:
 * new CLB_SyncItem({ componentID: "@foo/bar/com",
 *                    itemID: "monkey",
 *                    isRemove: false,
 *                    properties: { "foo": "bar",
 *                                  "hol": "iday" } });
 *
 * TODO(aa): Register this so that it can be createInstance()-able
 */
function CLB_SyncItem(opt_fields) {
  if (!opt_fields) {
    opt_fields = {};
  }

  this.componentID = opt_fields.componentID;
  this.itemID = opt_fields.itemID;
  this.typeID = opt_fields.typeID;
  this.isRemove = opt_fields.isRemove ? true : false;
  this.isRemoveAll = opt_fields.isRemoveAll ? true : false;
  this.isEncrypted = opt_fields.isEncrypted ? true : false;
  this.props_ = {};

  // HACK: Currently this is used in the downloader to keep track
  // of which are downloaded items and which are items that include
  // conflict resolution changes.  This doesn't really make
  // sense to be in the SyncItem object, so we should try to move
  // it when refactoring later.
  this.includesConflictResolution = false;
  
  if (opt_fields.properties) {
    for (var name in opt_fields.properties) {
      this.setProperty(name, opt_fields.properties[name]);
    }
  }
}

CLB_SyncItem.prototype.debugZone = "CLB_SyncItem";
CLB_SyncItem.debugZone = "CLB_SyncItem";

CLB_SyncItem.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.GISyncItem)) {
    return this;
  } else {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
}

CLB_SyncItem.prototype.setProperty = function(name, val) {
  this.props_[name] = val;  
}

CLB_SyncItem.prototype.getProperty = function(name) {
  return this.props_[name];
}

CLB_SyncItem.prototype.hasProperty = function(name) {
  return isDef(this.props_[name]);
}

CLB_SyncItem.prototype.deleteProperty = function(name) {
  var val = this.getProperty(name);
  delete this.props_[name];
  return val;
}

CLB_SyncItem.prototype.clearProperties = function() {
  this.props_ = {};
}

CLB_SyncItem.prototype.getPropertyNames = function(opt_count) {
  var names = getObjectProps(this.props_);

  if (opt_count) {
    opt_count.value = names.length;
  }

  return names;
}

CLB_SyncItem.prototype.toString = function() {
  return "{CLB_SyncItem componentID=%s, typeID=%s, itemID=%s, isRemove=%s}"
         .subs(this.componentID, this.typeID, this.itemID, this.isRemove);
}

CLB_SyncItem.prototype.toStringVerbose = function() {
  var itemStr = this.toString();
  itemStr += " properties = {";
  for (var prop in this.props_) {
    itemStr += " %s=%s, ".subs(prop, this.props_[prop]);
  }
  itemStr += "}";
  return itemStr;
}

CLB_SyncItem.prototype.clone = function() {
  var newProps = {};

  for (var propName in this.props_) {
    newProps[propName] = this.props_[propName];
  }
  
  return new CLB_SyncItem({componentID: this.componentID,
                           typeID: this.typeID,
                           itemID: this.itemID,
                           isRemove: this.isRemove,
                           isRemoveAll: this.isRemoveAll,
                           isEncrypted: this.isEncrypted,
                           properties: newProps});
}

CLB_SyncItem.prototype.updateFrom = function(otherItem) {
  if (otherItem.componentID != this.componentID ||
      otherItem.typeID != this.typeID ||
      otherItem.itemID != this.itemID) {
    G_Debug(this, "Error: Cannot update from an item with a different it");
    return;
  }

  this.isRemove = otherItem.isRemove;
  this.isEncrypted = otherItem.isEncrypted;

  this.clearProperties();
  otherItem.getPropertyNames().forEach(function(propName) {
    this.props_[propName] = otherItem.getProperty(propName);
  }, this);
}

CLB_SyncItem.prototype.equals = function(item) {
  if (!(item instanceof CLB_SyncItem)) {
    return false;
  }

  if (this.componentID != item.componentID ||
      this.typeID != item.typeID ||
      this.itemID != item.itemID ||
      this.isEncrypted != item.isEncrypted ||
      this.isRemove != item.isRemove ||
      this.isRemoveAll != item.isRemoveAll) {
    return false;
  }

  if (this.getPropertyNames().length != item.getPropertyNames().length) {
    return false;
  }

  for (var propName in this.props_) {
    if (String(this.props_[propName]) != String(item.props_[propName])) {
      return false;
    }
  }

  return true;
}

CLB_SyncItem.prototype.makeLookupKey = function() {
  var lookupKey = this.componentID + "/" + this.itemID;
  if (isDef(this.typeID)) {
    lookupKey = lookupKey + "/" + this.typeID;
  }
  return lookupKey;
}

/**
 * Encrypt a sync item. 
 */
CLB_SyncItem.prototype.encrypt = function() {
  this.crypt_(true /* encrypt */);
}

/**
 * Decrypt a sync item.
 */
CLB_SyncItem.prototype.decrypt = function() {
  if (CLB_Crypter.canDecrypt(this.itemID)) {
    if (CLB_app.prefs.getPref("debugUnexpectedDecryptVersion", false)) {
      G_Debug(this,
              "ERROR. Unexpected encryption version in itemID: " + this.itemID);
    }
    
    return false;
  }
  
  return this.crypt_(false /* decrypt */);
}

/**
 * Encryption/decryption helper function.
 */
CLB_SyncItem.prototype.crypt_ = function(encrypt) {
  if (this.isEncrypted == encrypt) {
    return true;
  }

  var crypter = CLB_app.getCrypter2();
  var ivData = this.componentID + "|" + this.typeID + "|" + this.itemID + "|";
  var cryptFunc = encrypt ? crypter.encryptString : crypter.decryptString;
  var propVal;

  for (var propName in this.props_) {
    propVal = this.props_[propName];

    if (!isNull(propVal) && typeof propVal != "undefined") {
      propVal = cryptFunc(String(propVal), ivData + propName + "|");

      if (isNull(propVal)) {
        return false;
      }
      
      this.props_[propName] = propVal;

      if (!isDef(propVal)) {
        G_Debug(this, "undefined prop: " + propName + " val: " + propVal);
      }
    }
  }

  // Nasty special case: for history syncer, we need to transmit sensitive data
  // in the itemID due to a broken part of the system design. But we also don't
  // want to disclose this data (obviously), so it needs to be encrypted.
  if (this.componentID == CLB_HistorySyncer.COMPONENT_ID) {
    this.itemID = cryptFunc(this.itemID, "");
  }

  this.isEncrypted = encrypt;
  return true;
}

/**
 * Helper to parse a serialized sync item.
 */
CLB_SyncItem.parseFromXML = function(xmlItem) {
  var syncItem = new CLB_SyncItem();
  var child = null;

  for (var i = 0; child = xmlItem.childNodes[i]; i++) {
    if (child.namespaceURI != CLB_XMLUtils.gNamespace) {
      G_DebugL(this, "ERROR: Unexpected namespace: {%s}"
                     .subs(child.namespaceURI));
      return null;
    }

    if (child.localName == "componentID") {
      syncItem.componentID = child.textContent;
    } else if (child.localName == "itemID") {
      syncItem.itemID = child.textContent;
    } else if (child.localName == "typeID") {
      syncItem.typeID = child.textContent;
    } else if (child.localName == "isRemove") {
      syncItem.isRemove = true;
    } else if (child.localName == "isRemoveAll") {
      syncItem.isRemoveAll = true;
    } else if (child.localName == "isEncrypted") {
      syncItem.isEncrypted = true;
    } else if (child.localName == "prop") {
      if (G_FirefoxXMLUtils.isNil(child)) {
        syncItem.setProperty(child.getAttribute("name"), null);
      } else {
        syncItem.setProperty(child.getAttribute("name"), child.textContent);
      }
    } else {
      G_DebugL(this, "ERROR: Unexpected element {" + child.nodeName + "}");
      return null;
    }
  }

  return syncItem;
}

CLB_SyncItem.parseAndDecryptFromXML = function(xmlItem) {
  var syncItem = CLB_SyncItem.parseFromXML(xmlItem);

  if (!syncItem) {
    return null;
  }

  if (syncItem.isEncrypted) {
    if (!syncItem.decrypt()) {
      return null;
    }

    // We need this piece of state for downloader, so that
    // we know which synced item should win when smooshed.  The item that
    // matches the current encryption state should win.
    syncItem.originallyEncrypted = true;
  } else {
    syncItem.originallyEncrypted = false;
  }

  return syncItem;
}

CLB_SyncItem.prototype.toXML = function(doc, opt_len) {
  // We count up the approximate length of data. The server has a limit after
  // which it will throw an error that we are trying to avoid.
  var itemLength = 0;

  itemLength += this.componentID.length;
  itemLength += this.itemID.length;

  if (isDef(this.typeID)) {
    itemLength += this.typeID.length;
  }

  var item = doc.createElement("item");

  // Add the xml indicating that this item is encrypted
  if (this.isEncrypted) {
    item.appendChild(doc.createElement("isEncrypted"));
  }

  if (this.isRemove) {
    item.appendChild(doc.createElement("isRemove"));
  }

  CLB_XMLUtils.addElm(item, "componentID", this.componentID);
  CLB_XMLUtils.addElm(item, "itemID", this.itemID);
  CLB_XMLUtils.addElm(item, "typeID", this.typeID);

  var propertyNames = this.getPropertyNames({});
  
  propertyNames.forEach(function(propName) {
    var val = this.getProperty(propName);

    if (isDef(val) && !isNull(val)) {
      itemLength += val.toString().length;
    }

    var elm = 
      CLB_XMLUtils.addElm(item, "prop", this.getProperty(propName));

    // elm can be null is val is undefined
    if (elm) {
      elm.setAttribute("name", propName);
    }
  }, this);

  if (opt_len) {
    opt_len.value = itemLength;
  }

  return item;
};

// Don't loggify set/getProperty to avoid tracing sensitive data from components
G_debugService.loggifier.loggify(CLB_SyncItem.prototype,
                                 "setProperty",
                                 "getProperty");
G_debugService.loggifier.loggify(CLB_SyncItem);

if (CLB_DEBUG) {
  function TEST_CLB_SyncItem() {
    // test equals
    var zone = "TEST_CLB_SyncItem";
    var key = CLB_app.getKey();

    try {
      var item1 = new CLB_SyncItem({componentID: "test",
                                    typeID: "type",
                                    itemID: "item",
                                    properties: {
                                      "foo" : "bar",
                                      "hot" : "dog"}});

      var item2 = item1.clone();
      G_Assert(zone, item1.equals(item2), "Expected cloned items to be equals.");

      CLB_app.setKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
      item1.encrypt();

      G_AssertEqual(zone, item1.itemID, item2.itemID,
                    "Item ID should not have changed.");

      G_AssertEqual(zone, item1.typeID, item2.typeID,
                    "typeID should not have changed.");

      G_AssertEqual(zone, 2, item2.getPropertyNames().length,
                    "Should still have two properties after encryption.");

      G_AssertEqual(zone,
                    "nTtXl3oLCTV7HlAZqCvgOQ==|CdwwgfpOjHXeiUHTV+fxnA==*3",
                    item1.getProperty("foo"),
                    "Item property 'foo' did not encrypt properly");

      G_AssertEqual(zone,
                    "JnN4hUlzi04Ubz+PMi1cjw==|xBL6H0o0jx6BjOCjDSyYlQ==*3",
                    item1.getProperty("hot"),
                    "Item property 'hot' did not encrypt properly");

      G_Debug(zone, "Testing sync item new decryption");
      item1.decrypt();

      G_AssertEqual(zone, item1.itemID, item2.itemID,
                    "itemID should not have changed while decryting.");

      G_AssertEqual(zone, item1.typeID, item2.typeID,
                    "typeID should not have changed while decrypting");

      G_AssertEqual(zone, 2, item1.getPropertyNames().length,
                    "Should still have two properties after decryption");

      G_AssertEqual(zone,
                    item2.getProperty("foo"),
                    item1.getProperty("foo"),
                    "Item property 'foo' did not decrypt properly");

      G_AssertEqual(zone,
                    item2.getProperty("hot"),
                    item1.getProperty("hot"),
                    "Item property 'hot' did not decrypt properly");

      CLB_app.setKey(key);
      
      // test not equals
      var item3;

      item3 = item1.clone();
      item3.componentID = "other";
      G_Assert(zone, !item1.equals(item3),
               "Expected item with changed componentID to be different.");

      item3 = item1.clone();
      item3.clearProperties();
      G_Assert(zone, !item1.equals(item3),
               "Expected item with cleared properties to be different.");

      item3 = item1.clone();
      item3.isRemove = true;
      G_Assert(zone, !item1.equals(item3),
               "Expected item with isRemove set to be different.");

      item3 = item1.clone();
      item3.setProperty("mon", "key");
      G_Assert(zone, !item1.equals(item3),
               "Expected item with additional properties to be different.");

      // Test makeLookupKey function
      var item4 = new CLB_SyncItem({componentID: "compID",
                                    itemID: "itemID",
                                    properties: { }});
      var lookupKey = item4.makeLookupKey();
      G_Assert(zone, lookupKey == "compID/itemID",
               "Lookup key with undefined typeID incorrect");

      item4 = item1.clone();


      var lookupKey2 = item1.makeLookupKey();

      G_Assert(zone, lookupKey2 == "test/item/type",
               "Lookup key with valid typeID incorrect");


      CLB_app.setKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

      var item5 = item4.clone();

      var t0 = new Date().getTime();

      for (var i = 0; i < 10; i++) {
        item5.encrypt();
        item5.decrypt();
      }

      var t1 = new Date().getTime();

      G_DebugL(zone, "New encrytion time per sync item: " + ((t1 - t0) / 20));
    } finally {
      CLB_app.setKey(key);
    }
  }
}
