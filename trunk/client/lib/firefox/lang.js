// Copyright (C) 2005 and onwards Google, Inc.
// Author: Aaron Boodman
//
// firefox/lang.js - Firefox-specific additions to google3/javascript/lang.js.


/**
 * The always-useful alert. 
 */
function alert(msg, opt_title) {
  opt_title = opt_title || "message";

  Cc["@mozilla.org/embedcomp/prompt-service;1"]
    .getService(Ci.nsIPromptService)
    .alert(null, opt_title, msg.toString());
}


/**
 * The instanceof operator cannot be used on a pure js object to determine if 
 * it implements a certain xpcom interface. The QueryInterface method can, but
 * it throws an error which makes things more complex.
 */
function jsInstanceOf(obj, iid) {
  try {
    obj.QueryInterface(iid);
    return true;
  } catch (e) {
    if (e == Components.results.NS_ERROR_NO_INTERFACE) {
      return false;
    } else {
      throw e;
    }
  }
}


/**
 * Unbelievably, Function inheritence is broken in chrome in Firefox
 * (still as of FFox 1.5b1). Hence if you're working in an extension
 * and not using the subscriptloader, you can't use the method
 * above. Instead, use this global function that does roughly the same
 * thing.
 *
 ***************************************************************************
 *   NOTE THE REVERSED ORDER OF FUNCTION AND OBJECT REFERENCES AS bind()   *
 ***************************************************************************
 * 
 * // Example to bind foo.bar():
 * var bound = BindToObject(bar, foo, "arg1", "arg2");
 * bound("arg3", "arg4");
 * 
 * @param {Function} func Reference to the function to be bound
 *
 * @param {Object} obj Specifies the object which |this| should point to
 * when the function is run. If the value is null or undefined, it will default
 * to the global object.
 *
 * @param opt_A through F Dummy optional arguments to make jscompiler happy
 *
 * @returns {Function} A partially-applied form of the speficied function.
 */
function BindToObject(func, obj, opt_A, opt_B, opt_C, opt_D, opt_E, opt_F) {
  // This is the sick product of Aaron's mind. Not for the feint of heart.
  var args = Array.prototype.splice.call(arguments, 1, arguments.length);
  return Function.prototype.bind.apply(func, args);
}
