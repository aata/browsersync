// Copyright (C) 2005 and onwards Google, Inc.
//
// This file implements a Dictionary data structure using a list
// (array). We could instead use an object, but using a list enables
// us to have ordering guarantees for iterators. The interface it exposes 
// is:
// 
// addMember(item)
// removeMember(item)
// isMember(item)
// forEach(func)

/**
 * Create a new Dictionary data structure.
 *
 * @constructor
 * @param name A string used to name the dictionary
 */
function ListDictionary(name) {
  this.name_ = name;
  this.members_ = [];
}

/**
 * Look an item up.
 *
 * @param item An item to look up in the dictionary
 * @returns Boolean indicating if the parameter is a member of the dictionary
 */
ListDictionary.prototype.isMember = function(item) {
  for (var i=0; i < this.members_.length; i++)
    if (this.members_[i] == item)
      return true;
  return false;
}

/**
 * Add an item
 *
 * @param item An item to add (does not check for dups)
 */
ListDictionary.prototype.addMember = function(item) {
  this.members_.push(item);
}

/**
 * Remove an item
 *
 * @param item The item to remove (doesn't check for dups)
 * @returns Boolean indicating if the item was removed
 */
ListDictionary.prototype.removeMember = function(item) {
  for (var i=0; i < this.members_.length; i++) {
    if (this.members_[i] == item) {
      for (var j=i; j < this.members_.length; j++)
        this.members_[j] = this.members_[j+1];

      this.members_.length--;
      return true;
    }
  }
  return false;
}

/**
 * Apply a function to each of the members. Does NOT replace the members
 * in the dictionary with results -- it just calls the function on each one.
 *
 * @param func Function to apply to the dictionary's members
 */
ListDictionary.prototype.forEach = function(func) {
  if (typeof func != "function")
    throw new Error("argument to forEach is not a function, it's a(n) " + 
                    typeof func);

  for (var i=0; i < this.members_.length; i++)
    func(this.members_[i]);
}
