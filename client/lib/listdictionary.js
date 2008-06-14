// Copyright (C) 2005 and onwards Google, Inc.

/**
 * A simple listdictionary implementation. Items added to the dictionary can be
 * indexed by key, but are also retrievable in the order they were added.
 *
 * Depends on:
 * google3/lang.js
 */
function CLB_ListDictionary() {
  this.index_ = {};
  this.items_ = [];
}

CLB_ListDictionary.ITEM_EXISTS_ERROR 
  = new Error("The specified key already exists.");

CLB_ListDictionary.prototype.debugZone = "CLB_ListDictionary";

CLB_ListDictionary.prototype.addItem = function(key, val) {
  if (isDef(this.index_[key])) {
    throw CLB_ListDictionary.ITEM_EXISTS_ERROR;
  }

  this.index_[key] = this.items_.push({key:key, val:val}) - 1;
}

CLB_ListDictionary.prototype.addOrReplaceItem = function(key, val) {
  var idx = this.index_[key];

  if (!isDef(idx)) {
    this.addItem(key, val);
  } else {
    this.items_[idx] = {key:key, val:val};
  }
}

CLB_ListDictionary.prototype.getItem = function(key) {
  if (isDef(this.index_[key])) {
    return this.items_[this.index_[key]].val;
  }
}

CLB_ListDictionary.prototype.getList = function() {
  return this.items_;
}

CLB_ListDictionary.prototype.deleteItem = function(key) {
  var idx = this.index_[key];

  if (isDef(idx)) {
    delete this.index_[key];
    this.items_.splice(idx, 1);
    for (var i = idx; i < this.items_.length; i++) {
      this.index_[this.items_[i].key]--;
    }
  }
}

//G_debugService.loggifier.loggify(CLB_ListDictionary.prototype);
