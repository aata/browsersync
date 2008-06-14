// Copyright (C) 2005 and onwards Google, Inc.
//
// firefox/xmlutils.js - Utilities for working with XML in Firefox.

var G_FirefoxXMLUtils = {};

/**
 * Standard namespace used for schema instances
 */
G_FirefoxXMLUtils.XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

/**
 * Standard namespace used for xmlns declarations
 */
G_FirefoxXMLUtils.XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/**
 * Standard namespace used for xul
 */
G_FirefoxXMLUtils.XUL_NAMESPACE =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  
/**
 * Create a new XML doc. XPCOM components cannot use XMLDocument because that is
 * a global on [Window].
 * @param {string?} opt_root Root element name
 * @param {string?} opt_namespace Default namespace uri
 * @param {Object?} opt_nsMap Additinal namespaces, map nsPrefix -> nsURI
 */
G_FirefoxXMLUtils.newXML = function(opt_root, opt_namespace, opt_nsMap) {
  // An unfortunate omission in XPCOM is the inability to create nsIDOMDocuments
  // without this hack. We use DOMParser to create a temp doc, then grab it's
  // implementation.
  if (!G_FirefoxXMLUtils.domImpl_) {
    G_FirefoxXMLUtils.domImpl_ = Cc["@mozilla.org/xmlextras/domparser;1"]
                                .createInstance(Ci.nsIDOMParser)
                                .parseFromString("<foo/>", "text/xml")
                                .implementation;
  }

  if (typeof(opt_root) == "undefined") {
    opt_root = null;
  }

  if (typeof(opt_namespace) == "undefined") {
    opt_namespace = null;
  }
  
  var doc = G_FirefoxXMLUtils.domImpl_.createDocument(opt_namespace,
                                                      opt_root, 
                                                      null /* no doctype */);

  if (opt_nsMap) {
    var root = doc.documentElement;

    for (var prefix in opt_nsMap) {
      root.setAttributeNS(this.XMLNS_NAMESPACE, 
                          "xmlns:" + prefix, 
                          opt_nsMap[prefix]);
    }
  }

  return doc;
}

/**
 * Gets the serialized form of an XML document
 */
G_FirefoxXMLUtils.getXMLString = function(node) {
  return Cc["@mozilla.org/xmlextras/xmlserializer;1"]
           .createInstance(Ci.nsIDOMSerializer)
           .serializeToString(node);
}

/**
 * Reads the specified file into an XML DOM
 */
G_FirefoxXMLUtils.loadXML = function(file) {
  var fis = Cc["@mozilla.org/network/file-input-stream;1"]
              .createInstance(Ci.nsIFileInputStream);

  fis.init(file, 
           1 /* io flags */, 
           0 /* perms - meaningless for fileinputstream */, 
           0 /* no special behavior */);

  var doc = Cc["@mozilla.org/xmlextras/domparser;1"]
              .createInstance(Ci.nsIDOMParser)
              .parseFromStream(fis, null, fis.available(), "text/xml");

  fis.close();

  if (doc.documentElement.nodeName == "parsererror") {
    throw new Error(doc.documentElement.firstChild.nodeValue);
  }

  return doc;
};

/**
 * Parse string to XML DOM document.
 *
 * @param {String} str
 * @return {nsIDOMXMLDocument}
 */
G_FirefoxXMLUtils.parseString = function(str) {
  var doc = Cc["@mozilla.org/xmlextras/domparser;1"]
              .createInstance(Ci.nsIDOMParser)
              .parseFromString(str, "text/xml");

  if (G_FirefoxXMLUtils.isParserError(doc)) {
    throw new Error(doc.documentElement.firstChild.nodeValue);
  }

  return doc;
};

/**
 * Checks whether the document looks like xml parser error.
 * @param {nsIDOMDocument} doc
 * @return boolean
 */
G_FirefoxXMLUtils.isParserError = function(doc) {
  var root = doc.documentElement; 
  return root.namespaceURI ==
         "http://www.mozilla.org/newlayout/xml/parsererror.xml"
         && root.nodeName == "parsererror";
};

/** 
 * Saves the xml dom to the specified file.
 */
G_FirefoxXMLUtils.saveXML = function(xml, file) {
  G_FileWriter.writeAll(file, this.getXMLString(xml));
};

/**
 * Returns an ordered node iterator for the specified xpath expression.
 */
G_FirefoxXMLUtils.selectNodes = function(context, xpath, opt_nsResolver,
                                         opt_snapshot) {
  var doc = context.nodeType == context.DOCUMENT_NODE
                              ? context
                              : context.ownerDocument;

  if (!isDef(opt_nsResolver)) {
    opt_nsResolver = null;
  }

  var type = opt_snapshot
             ? Ci.nsIDOMXPathResult.ORDERED_NODE_SNAPSHOT_TYPE
             : Ci.nsIDOMXPathResult.ORDERED_NODE_ITERATOR_TYPE;

  return doc.evaluate(xpath, context, opt_nsResolver, type, null);
}

/**
 * Returns the first ordered node found for the specified xpath expression
 */
G_FirefoxXMLUtils.selectSingleNode = function(context, xpath, opt_nsResolver) {
  var doc = context.nodeType == context.DOCUMENT_NODE
                              ? context
                              : context.ownerDocument;

  if (!isDef(opt_nsResolver)) {
    opt_nsResolver = null;
  }

  return doc.evaluate(xpath, context, opt_nsResolver, 
                      Ci.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE, null)
                     .singleNodeValue;
}

/**
 * Determine whether an element is nil
 */
G_FirefoxXMLUtils.isNil = function(elm) {
  return elm.getAttributeNS(this.XSI_NAMESPACE, "nil") == "true";
}

/**
 * Make an element nill
 */
G_FirefoxXMLUtils.setNil = function(elm) {
  elm.setAttributeNS(this.XSI_NAMESPACE, "xsi:nil", "true");
}
