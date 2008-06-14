// Copyright 2005 and onwards, Google
//
// An implementation of nsIModule and nsIFactory for javascript objects for use 
// with bootstrap files.
//
// Right now, these only allow you register JavaScript object *instances*, which
// should be used as XPCOM *services*. There is a TODO below to add support for
// constructors/components.
//
// See http://wiki/Main/FirefoxSharedJavaScript for information on how to use
// this.

/**
 * Implements nsIModule for multiple javascript instances and constructors
 *
 * @constructor
 */
function G_JSModule() {
  this.factoryLookup_ = {};
  this.categoriesLookup_ = {};
}

/**
 * Register a javascript object to be an XPCOM component
 *
 * @param   classID   String. A GUID (which could be parsed by Components.ID())
 *                    which uniquely identifies this component. You can
 *                    generate a new GUID on linux by running "uuidgen."
 *
 * @param   contractID   String. A unique mozilla-style contractID. For 
 *                       instance: @google.com/myproject/mycomponent;1
 *
 * @param   className   String. A unique class name to identify this object 
 *                      by. It's use is not generally programmer-visible, 
 *                      but it _must_ be unique.
 *
 * @param   instance  Object. The JavaScript object to register.
 *
 * @param   opt_categories  An optional array of strings for the categories to
 *                          register with this object. Example categories are
 *                          app-startup, xpcom-startup, etc. See Mozilla docs
 *                          for the complete list.
 *
 * NOTE: Choosing non-unique values for the parameters above that must be
 *       unique will break your applications -- or other people's 
 *       applications -- in various ways. Please be careful.
 */
G_JSModule.prototype.registerObject = 
function(classID, contractID, className, instance, opt_categories) {
  this.factoryLookup_[classID] = 
    new G_JSFactory(Components.ID(classID), contractID, className, instance, 
                    opt_categories);

  this.categoriesLookup_[classID] = opt_categories;
}

// TODO: Support registerConstructor, but there's some complexity here since
// XPCOM objects do not have constructors.


// nsIModule

/**
 * The component manager calls this method when a new component is installed so
 * that the component may register itself.
 *
 * See nsIModule.registerSelf.
 */
G_JSModule.prototype.registerSelf = 
function(compMgr, fileSpec, location, type) {
  compMgr = compMgr.QueryInterface(Ci.nsIComponentRegistrar);

  for (var factory in this.factoryLookup_) {
    compMgr.registerFactoryLocation(this.factoryLookup_[factory].classID, 
                                    this.factoryLookup_[factory].className,
                                    this.factoryLookup_[factory].contractID,
                                    fileSpec,
                                    location,
                                    type);

    this.factoryLookup_[factory].registerCategories();
  }
}

/**
 * The component manager calls this methods to respond to 
 * Components.classes[<your contract id>]
 *
 * See nsIModule.getClassObject
 */
G_JSModule.prototype.getClassObject = function(compMgr, classID, interfaceID) {
  var factory = this.factoryLookup_[classID.toString()];

  if (!factory) {
    throw new Error("Invalid classID {%s}".subs(classID));
  }

  return factory;
}

/**
 * The component manager calls this method when the application is shutting
 * down.
 *
 * See nsIModule.canUnload
 */
G_JSModule.prototype.canUnload = function() {
  return true;
}



/**
 * Internal implementation of nsIFactory for use with G_JSModule
 * @constructor
 */
function G_JSFactory(classID, contractID, className, instance, 
                     opt_categories) {
  this.classID = classID;
  this.contractID = contractID;
  this.className = className;
  this.instance_ = instance;
  this.categories_ = opt_categories;
}

/**
 * Called by G_JSModule during component registration to give the opportunity 
 * for the component to register it's categories.
 */
G_JSFactory.prototype.registerCategories = function() {
  if (this.categories_) {
    var catMgr = Cc["@mozilla.org/categorymanager;1"]
                   .getService(Ci.nsICategoryManager);

    for (var i = 0, cat; cat = this.categories_[i]; i++) {
      catMgr.addCategoryEntry(cat,
                              this.className,
                              this.contractID,
                              true /* persist across sessions */,
                              true /* overwrite */);
    }
  }
}

/**
 * Called by the component manager to respond to getService() and 
 * createInstance() calls.
 *
 * See nsIFactory.createInstance.
 */
G_JSFactory.prototype.createInstance = function(outer, iid) {
  return this.instance_;
}
