// Copyright 2005 and onwards, Google


/**
 * A simple enumerator around a JavaScript array. Satisfies nsISimpleEnumerator
 */
function CLB_ArrayEnumerator(aItems) {
  this._index = 0;
  this._contents = aItems;
}

CLB_ArrayEnumerator.prototype = {
  debugZone: "CLB_ArrayEnumerator",

  QueryInterface: function(iid) {
    if (iid.equals(Ci.nsISupports) ||
        iid.equals(Ci.nsISimpleEnumerator)) {
      return this;
    } else {
      throw Components.results.NS_ERROR_NO_INTERFACE;
    }
  },

  hasMoreElements: function() {
    return this._index < this._contents.length;
  },

  getNext: function() {
    return this._contents[this._index++];
  }
};

CLB_ArrayEnumerator.prototype.__defineGetter__("numItems", function() {
  return this._contents.length;
});

//G_debugService.loggifier.loggify(CLB_ArrayEnumerator.prototype);
