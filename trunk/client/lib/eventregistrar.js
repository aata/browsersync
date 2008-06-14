// Copyright (C) 2005 and onwards Google, Inc.
// 
// This file implements an event registrar, an object with which you
// can register handlers for arbitrary user-defined events. Events are
// arbitrary strings and listeners are functions taking an object
// (stuffed with arguments) as a parameter. When the thingy using the
// event registrar fires an event, all listeners are invoked in an
// unspecified order. The firing function takes an object to be passed
// into each handler (it is _not_ copied, so be careful). We chose
// this calling convention so we don't have to change handler
// signatures when adding new information.
//
// Why not just use notifier/observers? Because passing data around
// with them requires either serialization or a new xpcom interface,
// both of which are a pain in the ass.
//
// Example:
//
// this.handleTabload = function(e) {
//   foo(e.url);
//   bar(e.browser);
// };
// var eventTypes = ["tabload", "tabunload", "tabswitch"];
// var registrar = new EventRegistrar(eventTypes);
// var handler = BindToObject(this.handleTabload, this);
// registrar.registerListener("tabload", handler);
// var event = { "url": "http://www", "browser": browser };
// registrar.fire("tabload", event);
// registrar.removeListener("tabload", handler);
//
// TODO: return values

/**
 * EventRegistrars are used to manage user-defined events. 
 *
 * @constructor
 * @param eventTypes {Array or Object} Array holding names of events or
 *                   Object holding properties the values of which are 
 *                   names (strings) for which listeners can register
 */
function EventRegistrar(eventTypes) {
  this.eventTypes = [];
  this.listeners_ = {};          // Listener sets, index by event type

  if (eventTypes instanceof Array) {
    var events = eventTypes;
  } else if (typeof eventTypes == "object") {
    var events = [];
    for (var e in eventTypes)
      events.push(eventTypes[e]);
  } else {
    throw new Error("Unrecognized init parameter to EventRegistrar");
  }

  for (var i = 0; i < events.length; i++) {
    this.eventTypes.push(events[i]);          // Copy in case caller mutates
    this.listeners_[events[i]] = 
      new ListDictionary(events[i] + "Listeners");
  }
}

/**
 * Indicates whether the given event is one the registrar can handle.
 * 
 * @param eventType {String} The name of the event to look up
 * @returns {Boolean} false if the event type is not known; true if it is
 */
EventRegistrar.prototype.isKnownEventType = function(eventType) {
  for (var i=0; i < this.eventTypes.length; i++)
    if (eventType == this.eventTypes[i])
      return true;
  return false;
}

/**
 * Add an event type to listen for.
 * @param eventType {String} The name of the event to add
 */
EventRegistrar.prototype.addEventType = function(eventType) {
  if (this.isKnownEventType(eventType))
    throw new Error("Event type already known: " + eventType);

  this.eventTypes.push(eventType);
  this.listeners_[eventType] = new ListDictionary(eventType + "Listeners");
}

/**
 * Register to receive events of the type passed in. 
 * 
 * @param eventType {String} One of this.eventTypes
 * @param listener {Function} Function to invoke when the event occurs.
 */
EventRegistrar.prototype.registerListener = function(eventType, listener) {
  if (!this.isKnownEventType(eventType))
    throw new Error("Unknown event type: " + eventType);

  this.listeners_[eventType].addMember(listener);
}

/**
 * Unregister a listener.
 * 
 * @param eventType {String} One of EventRegistrar.eventTypes' members
 * @param listener {Function} Function to remove as listener
 */
EventRegistrar.prototype.removeListener = function(eventType, listener) {
  if (!this.isKnownEventType(eventType))
    throw new Error("Unknown event type: " + eventType);

  this.listeners_[eventType].removeMember(listener);
}

/**
 * Invoke the handlers for the given eventType. 
 *
 * @param eventType {String} The event to fire
 * @param e {Object} Object containing the parameters of the event
 */
EventRegistrar.prototype.fire = function(eventType, e) {
  if (!this.isKnownEventType(eventType))
    throw new Error("Unknown event type: " + eventType);

  var invoke = function(listener) {
    listener(e);
  };

  this.listeners_[eventType].forEach(invoke);
}
