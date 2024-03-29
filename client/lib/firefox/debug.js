// Copyright (C) 2005 and onwards Google Inc.
//
// Generic logging/debugging functionality that:
//
// (*) has dynamically configurable/creatable debugging "zones" enabling 
//     selective logging
// 
// (*) hides its plumbing so that all calls in different zones are uniform,
//     so you can drop files using this library into other apps that use it
//     without any configuration 
//
// (*) can be controlled programmatically or via preferences.  The
//     preferences that control the service and its zones are under
//     the preference branch "google-debug-service."
//
// (*) outputs function call traces (including actual parameters and
//     return values) when the "loggifier" zone is enabled
//
// Example:
//
// var G_GDEBUG = true                           // Enable this module
// var G_debugService = new G_DebugService();    // in global context
//
// // You can use it with arbitrary primitive first arguement
// G_Debug("myzone", "Yo yo yo");   // outputs: [myzone] Yo yo yo\n
//
// // But it's nice to use it with an object; it will probe for the zone name
// function Obj() {
//   this.debugZone = "someobj";
// }
// Obj.prototype.foo = function() {
//   G_Debug(this, "foo called");
// }
// (new Obj).foo();                        // outputs: [someobj] foo called\n
//
// G_debugService.loggifier.loggify(Obj.prototype);  // enable call tracing
//
// // En/disable specific zones programmatically (you can also use preferences)
// G_debugService.enableZone("somezone");
// G_debugService.disableZone("someotherzone");
// G_debugService.enableAllZones();
//
// // We also have asserts and errors:
// G_Error(this, "Some error occurred");                    // will throw
// G_Assert(this, (x > 3), "x not greater than three!");    // will throw
//
// See classes below for more methods. 
//
// TODO add abililty to alert() instead of dump()? Should be easy.
// TODO add code to set prefs when not found to the default value of a tristate
// TODO add error level support
// TODO add ability to turn off console output
//
// -------> TO START DEBUGGING: set G_GDEBUG to true


if (!isDef(G_GDEBUG)) {
  throw new Error("G_GDEBUG constant must be set before loading debug.js");
}


/**
 * Write out a debugging message.
 *
 * @param who The thingy to convert into a zone name corresponding to the 
 *            zone to which this message belongs
 * @param msg Message to output
 */
function G_Debug(who, msg) {
  if (G_GDEBUG) {
    G_GetDebugZone(who).debug(msg);
  }
}

/**
 * Debugs loudly
 */
function G_DebugL(who, msg) {
  if (G_GDEBUG) {
    var zone = G_GetDebugZone(who);

    if (zone.zoneIsEnabled()) {
      G_debugService.dump(
        G_File.LINE_END_CHAR +
        "************************************************************" +
        G_File.LINE_END_CHAR);

      G_Debug(who, msg);

      G_debugService.dump(
        "************************************************************" +
        G_File.LINE_END_CHAR +
        G_File.LINE_END_CHAR);
    }
  }
}

/**
 * Write out a call tracing message
 *
 * @param who The thingy to convert into a zone name corresponding to the 
 *            zone to which this message belongs
 * @param msg Message to output
 */
function G_TraceCall(who, msg) {
  if (G_GDEBUG) {
    if (G_debugService.callTracingEnabled()) {
      G_debugService.dump(msg + G_File.LINE_END_CHAR);
    }
  }
}

/**
 * Write out an error (and throw)
 *
 * @param who The thingy to convert into a zone name corresponding to the 
 *            zone to which this message belongs
 * @param msg Message to output
 */
function G_Error(who, msg) {
  if (G_GDEBUG) {
    G_GetDebugZone(who).error(msg);
  }
}

/**
 * Assert something as true and signal an error if it's not
 *
 * @param who The thingy to convert into a zone name corresponding to the 
 *            zone to which this message belongs
 * @param condition Boolean condition to test
 * @param msg Message to output
 */
function G_Assert(who, condition, msg) {
  if (G_GDEBUG) {
    G_GetDebugZone(who).assert(condition, msg);
  }
}

/**
 * Assert two things are equal (as in ==).
 */
function G_AssertEqual(who, expected, actual, msg) {
  if (G_GDEBUG) {
    G_GetDebugZone(who).assert(
        expected == actual,
        msg + " Expected: {%s}, got: {%s}".subs(expected, actual));
  }
}

/**
 * Helper function that takes input and returns the DebugZone
 * corresponding to it.
 *
 * @param who Arbitrary input that will be converted into a zone name. Most
 *            likely an object that has .debugZone property, or a string.
 * @returns {G_DebugZone} The DebugZone object corresponding to the input
 */
function G_GetDebugZone(who) {
  if (G_GDEBUG) {
    var zone = "?";

    if (who && who.debugZone) {
      zone = who.debugZone;
    } else if (isString(who)) {
      zone = who;
    }

    return G_debugService.getZone(zone);
  }
}

// Classes that implement the functionality.

/**
 * A debug "zone" is a string derived from arbitrary types (but
 * typically derived from another string or an object). All debugging
 * messages using a particular zone can be enabled or disabled
 * independent of other zones. This enables you to turn on/off logging
 * of particular objects or modules. This object implements a single
 * zone and the methods required to use it.
 *
 * @constructor
 * @param service Reference to the DebugService object we use for 
 *                registration
 * @param prefix String indicating the unique prefix we should use
 *               when creating preferences to control this zone
 * @param zone String indicating the name of the zone
 */
function G_DebugZone(service, prefix, zone) {
  if (G_GDEBUG) {
    this.debugService_ = service;
    this.prefix_ = prefix;
    this.zone_ = zone;
    this.zoneEnabledPrefName_ = prefix + ".zone." + this.zone_;
    this.settings_ = new G_DebugSettings();
  }
}
  
/**
 * @returns Boolean indicating if this zone is enabled
 */
G_DebugZone.prototype.zoneIsEnabled = function() {
  if (G_GDEBUG) {
    var explicit = this.settings_.getSetting(this.zoneEnabledPrefName_, null);

    if (explicit !== null) {
      return explicit;
    } else {
      return this.debugService_.allZonesEnabled();
    }
  }
}

/**
 * Enable this logging zone
 */
G_DebugZone.prototype.enableZone = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.zoneEnabledPrefName_, true);
  }
}

/**
 * Disable this logging zone
 */
G_DebugZone.prototype.disableZone = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.zoneEnabledPrefName_, false);
  }
}

/**
 * Write a debugging message to this zone
 *
 * @param msg String of message to write
 */
G_DebugZone.prototype.debug = function(msg) {
  if (G_GDEBUG) {
    if (this.zoneIsEnabled()) {
      this.debugService_.dump("[%s] %s%s".subs(this.zone_,
                                               msg,
                                               G_File.LINE_END_CHAR));
    }
  }
}

/**
 * Write an error to this zone and throw
 *
 * @param msg String of error to write
 */
G_DebugZone.prototype.error = function(msg) {
  if (G_GDEBUG) {
    this.debugService_.dump("[%s] %s%s".subs(this.zone_,
                                             msg,
                                             G_File.LINE_END_CHAR));
    throw new Error(msg);
  }
}

/**
 * Assert something as true and error if it is not
 *
 * @param condition Boolean condition to test
 * @param msg String of message to write if is false
 */
G_DebugZone.prototype.assert = function(condition, msg) {
  if (G_GDEBUG) {
    if (condition !== true) {
      G_Error(this.zone_, "ASSERT FAILED: " + msg);
    }
  }
}


/**
 * The debug service handles auto-registration of zones, namespacing
 * the zones preferences, and various global settings such as whether
 * all zones are enabled.
 *
 * @constructor
 * @param opt_prefix Optional string indicating the unique prefix we should 
 *                   use when creating preferences
 */
function G_DebugService(opt_prefix) {
  if (G_GDEBUG) {
    this.prefix_ = opt_prefix ? opt_prefix : "google-debug-service";
    this.shellEnabledPrefName_ = this.prefix_ + ".alsologtoshell";
    this.consoleEnabledPrefName_ = this.prefix_ + ".alsologtoconsole";
    this.allZonesEnabledPrefName_ = this.prefix_ + ".enableallzones";
    this.callTracingEnabledPrefName_ = this.prefix_ + ".trace-function-calls";
    this.logFileEnabledPrefName_ = this.prefix_ + ".logfileenabled";
    this.logFileErrorLevelPrefName_ = this.prefix_ + ".logfile-errorlevel";
    this.zones_ = {};

    this.loggifier = new G_Loggifier();
    this.settings_ = new G_DebugSettings();

    // We can't use our own G_Alarm here because it relies on debugservice 
    // already being setup and everything.
    this.timer_ = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.timer_.initWithCallback(this, 
                                 G_DebugService.TIMESTAMP_INTERVAL, 
                                 Ci.nsITimer.TYPE_REPEATING_SLACK);
      
    this.activeSinceLastTimestamp_ = false;

    // We observe the console service so that we can echo errors that get 
    // reported there to the file log.
    Cc["@mozilla.org/consoleservice;1"]
      .getService(Ci.nsIConsoleService)
      .registerListener(this);
  }
}

// Error levels for reporting console messages to the log.
G_DebugService.ERROR_LEVEL_INFO = "INFO";
G_DebugService.ERROR_LEVEL_WARNING = "WARNING";
G_DebugService.ERROR_LEVEL_EXCEPTION = "EXCEPTION";
G_DebugService.TIMESTAMP_INTERVAL = 1000 * 60 * 5; // 5 minutes

G_DebugService.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsITimerCallback)) {
    return this;
  }

  throw Components.results.NS_ERROR_NO_INTERFACE;
}


/**
 * @returns Boolean indicating if we should send messages to the shell
 */
G_DebugService.prototype.alsoDumpToShell = function() {
  if (G_GDEBUG) {
    return this.settings_.getSetting(this.shellEnabledPrefName_, true);
  }
}

/**
 * @returns Boolean indicating if we should send messages to the jsconsole
 */
G_DebugService.prototype.alsoDumpToConsole = function() {
  if (G_GDEBUG) {
    return this.settings_.getSetting(this.consoleEnabledPrefName_, false);
  }
}

/**
 * @returns {boolean} whether to log output to a file as well as the console.
 */
G_DebugService.prototype.logFileIsEnabled = function() {
  if (G_GDEBUG) {
    return this.settings_.getSetting(this.logFileEnabledPrefName_, false);
  }
}

/**
 * Turns on file logging. dump() output will also go to the file specified by
 * setLogFile()
 */
G_DebugService.prototype.enableLogFile = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.logFileEnabledPrefName_, true);
  }
}

/**
 * Turns off file logging
 */
G_DebugService.prototype.disableLogFile = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.logFileEnabledPrefName_, false);
    this.closeLogFile();
  }
}

/**
 * @returns {nsIFile} nsIFile instance pointing to the current log file location
 */
G_DebugService.prototype.getLogFile = function() {
  if (G_GDEBUG) {
    return this.logFile_;
  }
}

/**
 * Sets a new log file location
 */
G_DebugService.prototype.setLogFile = function(file) {
  if (G_GDEBUG) {
    if (this.logWriter_) {
      this.closeLogFile();
    }
    
    this.logFile_ = file;
  }
}

/**
 * Closes the log file
 */
G_DebugService.prototype.closeLogFile = function() {
  this.logWriter_.close();
  this.logWriter_ = null;
}

/**
 * Enables sending messages to the shell
 */
G_DebugService.prototype.enableDumpToShell = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.shellEnabledPrefName_, true);
  }
}

/**
 * Disables sending messages to the jsconsole
 */
G_DebugService.prototype.disableDumpToShell = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.shellEnabledPrefName_, false);
  }
}

/**
 * Enables sending messages to the jsconsole
 */
G_DebugService.prototype.enableDumpToConsole = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.consoleEnabledPrefName_, true);
  }
}

/**
 * Disables sending messages to the jsconsole
 */
G_DebugService.prototype.disableDumpToConsole = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.consoleEnabledPrefName_, false);
  }
}

/**
 * @param zone Name of the zone to get
 * @return {G_DebugZone} The DebugZone object corresopnding to input. If not
 *                       such zone exists, a new one is created and returned
 */
G_DebugService.prototype.getZone = function(zone) {
  if (G_GDEBUG) {
    if (!this.zones_[zone]) 
      this.zones_[zone] = new G_DebugZone(this, this.prefix_, zone);
    
    return this.zones_[zone];
  }
}

/**
 * @param zone Zone to enable debugging for
 */
G_DebugService.prototype.enableZone = function(zone) {
  if (G_GDEBUG) {
    var toEnable = this.getZone(zone);
    toEnable.enableZone();
  }
}

/**
 * @param zone Zone to disable debugging for
 */
G_DebugService.prototype.disableZone = function(zone) {
  if (G_GDEBUG) {
    var toDisable = this.getZone(zone);
    toDisable.disableZone();
  }
}

/**
 * @returns Boolean indicating whether debugging is enabled for all zones
 */
G_DebugService.prototype.allZonesEnabled = function() {
  if (G_GDEBUG) {
    return this.settings_.getSetting(this.allZonesEnabledPrefName_, false);
  }
}

/**
 * Enables all debugging zones
 */
G_DebugService.prototype.enableAllZones = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.allZonesEnabledPrefName_, true);
  }
}

/**
 * Disables all debugging zones
 */
G_DebugService.prototype.disableAllZones = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.allZonesEnabledPrefName_, false);
  }
}

/**
 * @returns Boolean indicating whether call tracing is enabled
 */
G_DebugService.prototype.callTracingEnabled = function() {
  if (G_GDEBUG) {
    return this.settings_.getSetting(this.callTracingEnabledPrefName_, false);
  }
}

/**
 * Enables call tracing
 */
G_DebugService.prototype.enableCallTracing = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.callTracingEnabledPrefName_, true);
  }
}

/**
 * Disables call tracing
 */
G_DebugService.prototype.disableCallTracing = function() {
  if (G_GDEBUG) {
    this.settings_.setDefault(this.callTracingEnabledPrefName_, false);
  }
}

/**
 * Gets the minimum error that will be reported to the log.
 */
G_DebugService.prototype.getLogFileErrorLevel = function() {
  if (G_GDEBUG) {
    var level = this.settings_.getSetting(this.logFileErrorLevelPrefName_, 
                                          G_DebugService.ERROR_LEVEL_EXCEPTION);

    return level.toUpperCase();
  }
}

/**
 * Sets the minimum error level that will be reported to the log.
 */
G_DebugService.prototype.setLogFileErrorLevel = function(level) {
  if (G_GDEBUG) {
    // normalize case just to make it slightly easier to not screw up.
    level = level.toUpperCase();

    if (level != G_DebugService.ERROR_LEVEL_INFO &&
        level != G_DebugService.ERROR_LEVEL_WARNING &&
        level != G_DebugService.ERROR_LEVEL_EXCEPTION) {
      throw new Error("Invalid error level specified: {" + level + "}");
    }

    this.settings_.setDefault(this.logFileErrorLevelPrefName_, level);
  }
}

/**
 * Periodically called by this.timer_. Dump the current time if anything has
 * been printed since the last time we were called.
 */
G_DebugService.prototype.notify = function(timer) {
  if (!this.activeSinceLastTimestamp_) {
    return;
  }

  this.dump(G_File.LINE_END_CHAR + 
            "=========== Date: " + 
            new Date().toLocaleString() +
            " ============" + 
            G_File.LINE_END_CHAR + 
            G_File.LINE_END_CHAR);

  this.activeSinceLastTimestamp_ = false;
}

/**
 * Internal dump() method
 *
 * @param msg String of message to dump
 */
G_DebugService.prototype.dump = function(msg) {
  if (G_GDEBUG) {
    if (this.alsoDumpToShell()) {
      dump(msg);
    }
    
    if (this.alsoDumpToConsole()) {
      try {
        var console = Components.classes['@mozilla.org/consoleservice;1']
                      .getService(Components.interfaces.nsIConsoleService);
        console.logStringMessage(msg);
      } catch(e) {
        dump("G_DebugZone ERROR: COULD NOT DUMP TO CONSOLE" +
             G_File.LINE_END_CHAR);
      }
    }

    this.maybeDumpToFile(msg);
    this.activeSinceLastTimestamp_ = true;
  }
}

/**
 * Writes the specified message to the log file, if file logging is enabled.
 */
G_DebugService.prototype.maybeDumpToFile = function(msg) {
  if (this.logFileIsEnabled() && this.logFile_) {
    if (!this.logWriter_) {
      this.logWriter_ = new G_FileWriter(this.logFile_, true);
    }

    this.logWriter_.write(msg);
  }
}

/**
 * Implements nsIConsoleListener.observe(). Gets called when an error message
 * gets reported to the console and sends it to the log file as well.
 */
G_DebugService.prototype.observe = function(consoleMessage) {
  if (G_GDEBUG) {
    var errorLevel = this.getLogFileErrorLevel();

    // consoleMessage can be either nsIScriptError or nsIConsoleMessage. The
    // latter does not have things like line number, etc. So we special case 
    // it first. 
    if (!(consoleMessage instanceof Ci.nsIScriptError)) {
      // Only report these messages if the error level is INFO.
      if (errorLevel == G_DebugService.ERROR_LEVEL_INFO) {
        this.maybeDumpToFile(G_DebugService.ERROR_LEVEL_INFO + ": " + 
                             consoleMessage.message + G_File.LINE_END_CHAR);
      }

      return;
    }

    // We make a local copy of these fields because writing to it doesn't seem
    // to work.
    var flags = consoleMessage.flags;
    var sourceName = consoleMessage.sourceName;
    var lineNumber = consoleMessage.lineNumber;

    // TODO(aa): Ignore sourceName's that aren't from us so that we don't get
    // random page validation errors.

    // Sometimes, a scripterror instance won't have any flags set. We 
    // default to exception.
    if (!flags) {
      flags = Ci.nsIScriptError.exceptionFlag;
    }

    // Default the filename and line number if they aren't set.
    if (!sourceName) {
      sourceName = "<unknown>";
    }

    if (!lineNumber) {
      lineNumber = "<unknown>";
    }

    // Report the error in the log file.
    if (flags & Ci.nsIScriptError.warningFlag) {
      // Only report warnings if the error level is warning or better. 
      if (errorLevel == G_DebugService.ERROR_LEVEL_WARNING ||
          errorLevel == G_DebugService.ERROR_LEVEL_INFO) {
        this.reportScriptError_(consoleMessage.message,
                                sourceName,
                                lineNumber,
                                G_DebugService.ERROR_LEVEL_WARNING);
      }
    } else if (flags & Ci.nsIScriptError.exceptionFlag) {
      // Always report exceptions.
      this.reportScriptError_(consoleMessage.message,
                              sourceName,
                              lineNumber,
                              G_DebugService.ERROR_LEVEL_EXCEPTION);
    }
  }
}

/**
 * Private helper to report an nsIScriptError instance to the log/console.
 */
G_DebugService.prototype.reportScriptError_ = function(message, sourceName, 
                                                       lineNumber, label) {
  // We are not interested in errors that occur in content
  if (sourceName.startsWith("http")) {
    return;
  }

  // TODO(aa): Are we also not interested in errors that don't come from the
  // current component? Should we filter those out as well? One would assume
  // they could have useful information (when extensions conflict) but could
  // also flood the log with useless errors.

  var message = ["",
                 "------------------------------------------------------------",
                 label + ": " + message,
                 "location: " + sourceName + ", " + "line: " + lineNumber,
                 "------------------------------------------------------------",
                 "",
                 ""].join(G_File.LINE_END_CHAR);

  if (this.alsoDumpToShell()) {
    dump(message);
  }
  
  this.maybeDumpToFile(message);
}



/**
 * A class that instruments methods so they output a call trace,
 * including the values of their actual parameters and return value.
 *
 * Note that this class uses the "loggifier" debug zone, so you'll see 
 * a complete call trace when that zone is enabled.
 *
 * @constructor
 */
function G_Loggifier() {
  if (G_GDEBUG) {
    // Careful not to loggify ourselves!
    this.mark_(this);  
  }
}

/**
 * Marks an object as having been loggified. Loggification is not 
 * idempotent :)
 *
 * @param obj Object to be marked
 */
G_Loggifier.prototype.mark_ = function(obj) {
  if (G_GDEBUG) {
    obj.__loggified_ = true;
  }
}

/**
 * @param obj Object to be examined
 * @returns Boolean indicating if the object has been loggified
 */
G_Loggifier.prototype.isLoggified = function(obj) {
  if (G_GDEBUG) {
    return !!obj.__loggified_;
  }
}

/**
 * Attempt to extract the class name from the constructor definition.
 * Assumes the object was created using new.
 *
 * @param constructor String containing the definition of a constructor,
 *                    for example what you'd get by examining obj.constructor
 * @returns {string} Name of the constructor/object if it could be found,
 *                   else "???"
 */
G_Loggifier.prototype.getFunctionName_ = function(constructor) {
  if (G_GDEBUG) {
    return constructor.name || "???";
  }
}

/**
 * Wraps all the methods in an object so that call traces are
 * automatically outputted.
 *
 * @param obj Object to loggify. SHOULD BE THE PROTOTYPE OF A USER-DEFINED
 *            object. You can get into trouble if you attempt to 
 *            loggify something that isn't, for example the Window.
 *
 * Any additional parameters are considered method names which should not be
 * loggified.
 *
 * Usage:
 * G_debugService.loggifier.loggify(MyClass.prototype,
 *                                  "firstMethodNotToLog",
 *                                  "secondMethodNotToLog",
 *                                  ... etc ...);
 */
G_Loggifier.prototype.loggify = function(obj) {
  if (G_GDEBUG) {
    if (!G_debugService.callTracingEnabled()) {
      return;
    }

    if (typeof window != "undefined" && obj == window || 
        this.isLoggified(obj))   // Don't go berserk!
      return;

    var zone = G_GetDebugZone(obj);
    if (!zone || !zone.zoneIsEnabled()) {
      return;
    }

    this.mark_(obj);

    // Helper function returns an instrumented version of
    // objName.meth, with "this" bound properly. (BTW, because we're
    // in a conditional here, functions will only be defined as
    // they're encountered during execution, so declare this helper
    // before using it.)

    function wrap(meth, objName, methName) {
      return function() {
        
        // First output the call along with actual parameters
        var args = new Array(arguments.length);
        var argsString = "";
        for (var i = 0; i < args.length; i++) {
          args[i] = arguments[i];
          argsString += (i == 0 ? "" : ", ");
          
          if (isFunction(args[i])) {
            argsString += "[function]";
          } else {
            argsString += args[i];
          }
        }

        G_TraceCall(this, "> " + objName + "." + methName + "(" + 
                    argsString + ")");
        
        // Then run the function, capturing the return value and throws
        try {
          var retVal = meth.apply(this, arguments);
          var reportedRetVal = retVal;

          if (typeof reportedRetVal == "undefined")
            reportedRetVal = "void";
          else if (reportedRetVal === "")
            reportedRetVal = "\"\" (empty string)";
        } catch (e) {
          if (e && !e.__logged) {
            G_TraceCall(this, "Error: " + e.message + ". " + 
                        e.fileName + ": " + e.lineNumber);
            try {
              e.__logged = true;
            } catch (e2) {
              // Sometimes we can't add the __logged flag because it's an
              // XPC wrapper
              throw e;
            }
          }
          
          throw e;      // Re-throw!
        }

        // And spit it out already
        G_TraceCall(
          this, 
          "< " + objName + "." + methName + ": " + reportedRetVal);

        return retVal;
      };
    };

    var ignoreLookup = {};

    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        ignoreLookup[arguments[i]] = true;
      }
    }
    
    // Wrap each method of obj
    for (var p in obj) {
      // Work around bug in Firefox. In ffox typeof RegExp is "function",
      // so make sure this really is a function. Bug as of FFox 1.5b2.
      if (typeof obj[p] == "function" && obj[p].call && !ignoreLookup[p]) {
        var objName = this.getFunctionName_(obj.constructor);
        obj[p] = wrap(obj[p], objName, p);
      }
    }
  }
}


/**
 * Simple abstraction around debug settings. The thing with debug settings is
 * that we want to be able to specify a default in the application's startup,
 * but have that default be overridable by the user via their prefs.
 *
 * To generalize this, we package up a dictionary of defaults with the 
 * preferences tree. If a setting isn't in the preferences tree, then we grab it
 * from the defaults. 
 *
 * @constructor
 */
function G_DebugSettings() {
  this.defaults_ = {};
  this.prefs_ = new G_Preferences();
}

/**
 * Returns the value of a settings, optionally defaulting to a given value if it
 * doesn't exist. If no default is specified, the default is |undefined|.
 */
G_DebugSettings.prototype.getSetting = function(name, opt_default) {
  var override = this.prefs_.getPref(name, null);

  if (override !== null) {
    return override;
  } else if (name in this.defaults_) {
    return this.defaults_[name];
  } else {
    return opt_default;
  }
}

/**
 * Sets the default value for a setting. If the user doesn't override it with a
 * preference, this is the value which will be returned by getSetting().
 */
G_DebugSettings.prototype.setDefault = function(name, val) {
  this.defaults_[name] = val;
}

var G_debugService = new G_DebugService(); // Instantiate us!

if (G_GDEBUG) {
  G_debugService.enableAllZones();
}
