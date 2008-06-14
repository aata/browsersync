// Copyright (C) 2005 and onwards Google, Inc.

/**
 * lang.js - The missing JavaScript language features
 *
 * WARNING: This class adds members to the prototypes of String, Array, and
 * Function for convenience.
 *
 * The tradeoff is that the for/in statement will not work properly for those
 * objects when this library is used.
 *
 * To work around this for Arrays, you may want to use the forEach() method,
 * which is more fun and easier to read.
 */

/**
 * This is a reference to the global object. It is preferred to be used in
 * places where people often use 'window' as the global object. You should of
 * course continue to use 'window' when you are accessing methods and fields of
 * the window object such as 'setTimeout' etc.
 * @type Object
 */
var global = this;

/**
 * Returns true if the specified value is not |undefined|.
 *
 * @deprecated Calling f(undefinedvar) throws warnings in spidermonkey
 * (firefox) if javascript is running in strict mode. We should not write code
 * which throws warnings.
 */
function isDef(val) {
  return typeof val != "undefined";
}

/**
 * Returns true if the specified value is null.
 */
function isNull(val) {
  return val === null;
}

/**
 * Returns true if the specified value is an array.
 */
function isArray(a) {
  // We cannot rely on constructor == Array or instanceof Array because
  // different frames have different Array objects.
  return a instanceof Array || a && typeof a == "object" &&
      typeof a.join == "function" &&
      typeof a.reverse == "function";
}

/**
 * Returns true if the specified value is a string.
 */
function isString(val) {
  return typeof val == "string";
}

/**
 * Returns true if the specified value is a boolean.
 */
function isBoolean(val) {
  return typeof val == "boolean";
}

/**
 * Returns true if the specified value is a number.
 */
function isNumber(val) {
  return typeof val == "number";
}

/**
 * Returns true if the specified value is a function.
 */
function isFunction(val) {
  return typeof val == "function";
}

/**
 * Returns true if the specified value is an object.
 */
function isObject(val) {
  return val && typeof val == "object";
}

/**
 * Returns an array of all the properties defined on an object.
 */
function getObjectProps(obj) {
  var ret = [];

  for (var p in obj) {
    ret.push(p);
  }

  return ret;
}

/**
 * Returns true if the specified value is an object which has no properties
 * defined.
 */
function isEmptyObject(val) {
  if (!isObject(val)) {
    return false;
  }

  for (var p in val) {
    return false;
  }

  return true;
}


var G_HASH_CODE_PROPERTY_ = "lang_hashCode_";
var G_hashCodeCounter_ = 0;

/**
 * Adds a lang_hashCode_ field to an object. The hash code is unique for the
 * given object.
 *
 * Warning! If getHashCode is called on a prototype object then all the
 * instances of the class that extends that will share the hash code.
 *
 * @param obj {Object} The object to get the hash code for
 * @returns {Number} The hash code for the object
 */
function getHashCode(obj) {
  // we are not using hasOwnProperty because it might lead to hard to find
  // bugs in IE 5.0 and other browsers that do not support it.
  if (!obj[G_HASH_CODE_PROPERTY_]) {
    obj[G_HASH_CODE_PROPERTY_] = ++G_hashCodeCounter_;
  }
  return obj[G_HASH_CODE_PROPERTY_];
}

/**
 * Removes the lang_hashCode_ field from an object.
 * @param obj {Object} The object to remove the field from.
 */
function removeHashCode(obj) {
  // In IE, you cannot use delete on DOM nodes so we just set the field
  // to undefined if this one fails
  obj[G_HASH_CODE_PROPERTY_] = undefined;
};


/**
 * Checks if a string starts with another string.
 */
String.prototype.startsWith = function(prefix) {
  return this.indexOf(prefix) == 0;
}


/**
 * Fast suffix-checker.
 * @param {String} suffix String that may appear at end
 * @return {Boolean} True/false
 */
String.prototype.endsWith = function (suffix) {
  var l = this.length - suffix.length;
  return l >= 0 && this.lastIndexOf(suffix, l) == l;
};


/**
 * Removes whitespace from the beginning and end of the string
 */
String.prototype.trim = function() {
  return this.replace(/^\s+|\s+$/g, "");
}

/**
 * Does simple python-style string substitution.
 * "foo%s hot%s".subs("bar", "dog") becomes "foobar hotdot".
 * For more fully-featured templating, see template.js.
 */
String.prototype.subs = function(var_args) {
  var ret = this;

  // this appears to be slow, but testing shows it compares more or less equiv.
  // to the regex.exec method.
  for (var i = 0; i < arguments.length; i++) {
    ret = ret.replace(/\%s/, String(arguments[i]));
  }

  return ret;
}

/**
 * Some old browsers don't have Function.apply. So sad. We emulate it for them.
 */
if (!Function.prototype.apply) {
  Function.prototype.apply = function(oScope, opt_args) {
    var sarg = [];
    var rtrn, call;

    if (!oScope) oScope = global;
    var args = opt_args || [];

    for (var i = 0; i < args.length; i++) {
      sarg[i] = "args[" + i + "]";
    }

    call = "oScope.__applyTemp__.peek()(" + sarg.join(",") + ");";

    if (!oScope.__applyTemp__) {
      oScope.__applyTemp__ = [];
    }

    oScope.__applyTemp__.push(this);
    rtrn = eval(call);
    oScope.__applyTemp__.pop();

    return rtrn;
  }
}

/**
 * Emulate Array.push for browsers which don't have it.
 */
if (!Array.prototype.push) {
  Array.prototype.push = function(var_args) {
    for (var i = 0; i < arguments.length; i++) {
      this[this.length] = arguments[i];
    }

    return this.length;
  }
}

/**
 * Emulate Array.pop for browsers which don't have it.
 */
if (!Array.prototype.pop) {
  Array.prototype.pop = function() {
    if (!this.length) {
      return;
    }

    var val = this[this.length - 1];

    this.length--;

    return val;
  }
}

/**
 * Returns the last element on an array without removing it.
 */
Array.prototype.peek = function() {
  return this[this.length - 1];
}

/**
 * Emulate Array.shift for browsers which don't have it.
 */
if (!Array.prototype.shift) {
  Array.prototype.shift = function() {
    if (this.length == 0) {
      return; // return undefined
    }

    var val = this[0];

    for (var i = 0; i < this.length - 1; i++) {
      this[i] = this[i+1];
    }

    this.length--;

    return val;
  }
}

/**
 * Emulate Array.unshift for browsers which don't have it.
 */
if (!Array.prototype.unshift) {
  Array.prototype.unshift = function(var_args) {
    var numArgs = arguments.length;

    for (var i = this.length - 1; i >= 0; i--) {
      this[i + numArgs] = this[i];
    }

    for (var j = 0; j < numArgs; j++) {
      this[j] = arguments[j];
    }

    return this.length;
  }
}

// TODO(anyone): add splice the first time someone needs it and then implement
// push, pop, shift, unshift in terms of it where possible.

/**
 * Emulate Array.forEach for browsers which don't have it
 */
if (!Array.prototype.forEach) {
  Array.prototype.forEach = function(callback, opt_scope) {
    for (var i = 0; i < this.length; i++) {
      callback.call(opt_scope, this[i], i, this);
    }
  }
}

// TODO(anyone): add the other neat-o functional methods like map(), etc.

/**
 * Partially applies this function to a particular "this object" and zero or
 * more arguments. The result is a new function with some arguments of the first
 * function pre-filled and the value of |this| "pre-specified".
 *
 * Remaining arguments specified at call-time are appended to the pre-
 * specified ones.
 *
 * Also see: partial().
 *
 * Note that bind and partial are optimized such that repeated calls to it do
 * not create more than one function object, so there is no additional cost for
 * something like:
 *
 * var g = bind(f, obj);
 * var h = partial(g, 1, 2, 3);
 * var k = partial(h, a, b, c);
 *
 * Usage:
 * var barMethBound = bind(myFunction, myObj, "arg1", "arg2");
 * barMethBound("arg3", "arg4");
 *
 * @param self {Object} Specifies the object which |this| should point to
 * when the function is run. If the value is null or undefined, it will default
 * to the global object.
 *
 * @returns {Function} A partially-applied form of the function bind() was
 * invoked as a method of.
 */
function bind(fn, self, var_args) {
  var boundargs = fn.boundArgs_ || [];
  boundargs = boundargs.concat(Array.prototype.slice.call(arguments, 2));

  if (typeof fn.boundSelf_ != "undefined") {
    self = fn.boundSelf_;
  }

  if (typeof fn.boundFn_ != "undefined") {
    fn = fn.boundFn_;
  }

  var newfn = function() {
    // Combine the static args and the new args into one big array
    var args = boundargs.concat(Array.prototype.slice.call(arguments));
    return fn.apply(self, args);
  }

  newfn.boundArgs_ = boundargs;
  newfn.boundSelf_ = self;
  newfn.boundFn_ = fn;

  return newfn;
}

/**
 * An alias to the bind() global function.
 *
 * Usage:
 * var g = f.bind(obj, arg1, arg2);
 * g(arg3, arg4);
 */
Function.prototype.bind = function(self, var_args) {
  return bind.apply(
    null, [this, self].concat(Array.prototype.slice.call(arguments, 1)));
}

/**
 * Like bind(), except that a "this object" is not required. Useful when the
 * target function is already bound.
 *
 * Usage:
 * var g = partial(f, arg1, arg2);
 * g(arg3, arg4);
 */
function partial(fn, var_args) {
  return bind.apply(
    null, [fn, null].concat(Array.prototype.slice.call(arguments, 1)));
}

/**
 * An alias to the partial() global function.
 *
 * Usage:
 * var g = f.partial(arg1, arg2);
 * g(arg3, arg4);
 */
Function.prototype.partial = function(var_args) {
  return bind.apply(
    null, [this, null].concat(Array.prototype.slice.call(arguments)));
}

/**
 * Convenience. Binds all the methods of obj to itself. Calling this in the
 * constructor before referencing any methods makes things a little more like
 * Java or Python where methods are intrinsically bound to their instance.
 */
function bindMethods(obj) {
  for (var p in obj) {
    if (isFunction(obj[p])) {
      obj[p] = obj[p].bind(obj);
    }
  }
}

/**
 * Inherit the prototype methods from one constructor into another.
 *
 * Usage:
 * <pre>
 * function ParentClass(a, b) { }
 * ParentClass.prototype.foo = function(a) { }
 *
 * function ChildClass(a, b, c) {
 *   ParentClass.call(this, a, b);
 * }
 *
 * ChildClass.inherits(ParentClass);
 *
 * var child = new ChildClass("a", "b", "see");
 * child.foo(); // works
 * </pre>
 *
 * In addition, a superclass' implementation of a method can be invoked
 * as follows:
 *
 * <pre>
 * ChildClass.prototype.foo = function(a) {
 *   ChildClass.superClass_.foo.call(this, a);
 *   // other code
 * };
 * </pre>
 *
 * @notypecheck
 */
Function.prototype.inherits = function(parentCtor) {
  /** @constructor */
  var tempCtor = function(){};
  tempCtor.prototype = parentCtor.prototype;
  this.superClass_ = parentCtor.prototype;
  this.prototype = new tempCtor();
}


/**
 * Mix-in based inheritance
 *
 * Provides an alternative method for adding properties and methods to a class'
 * prototype. (It is pretty much a direct copy of dojo.lang.mixin())
 *
 * <pre>
 * function X() {}
 * X.mixin({
 *   one: 1,
 *   two: 2,
 *   three: 3,
 *   doit: function() { return this.one + this.two + this.three; }
 * });
 *
 * function Y() { }
 * Y.mixin(X.prototype);
 * Y.prototype.four = 15;
 * Y.prototype.doit2 = function() { return this.doit() + this.four; }
 * });
 *
 * // or
 *
 * function Y() { }
 * Y.inherits(X);
 * Y.mixin({
 *   one: 10,
 *   four: 15,
 *   doit2: function() { return this.doit() + this.four; }
 * });
 * </pre>
 *
 * @param props Object from which to copy properties.
 */
Function.prototype.mixin = function(props) {
  for (var x in props) {
    this.prototype[x] = props[x];
  }

  // Apparently IE doesn't recognise custom toStrings in for...in
  if (isFunction(props['toString']) &&
      props['toString'] != this.prototype['toString']) {
    this.prototype.toString = props.toString
  }
}
