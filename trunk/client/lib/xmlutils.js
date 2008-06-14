// Copyright (C) 2005 and onwards Google, Inc.
//
// xmlutils.js - Clobber-specific xml utilities

var CLB_XMLUtils = {};

CLB_XMLUtils.debugZone = "CLB_XMLUtils";

/**
 * Gets the string value of an xpath. Follows the clobber semantics for 
 * null/undefined. If the element is not found, returns undefined. If it is 
 * found but has xsi:nil="true", returns null. Otherwise, returns the text 
 * contents of the element which is found.
 */ 
CLB_XMLUtils.selectText = function(context, xpath) {
  var node = G_FirefoxXMLUtils.selectSingleNode(context, xpath, 
                                                this.gNamespaceResolver);

  if (!node) {
    return;
  } else if (G_FirefoxXMLUtils.isNil(node)) {
    return null;
  } else {
    return node.textContent;
  }
}

/**
 * Adds an xml element to a tree, optionally with the specified text. Follows
 * clobber semantics for null/undefined. If opt_text is null, then the element
 * will be added with xsi:nil="true" and no text. If opt_text is undefined, then
 * the element is not added.
 */
CLB_XMLUtils.addElm = function(parent, elmName, opt_text, opt_elmNS) {
  var doc = parent.ownerDocument;
  
  if (isDef(opt_text)) {
    if (opt_elmNS) {
      var elm = doc.createElementNS(opt_elmNS, elmName);
    } else {
      var elm = doc.createElement(elmName);
    }

    parent.appendChild(elm);

    if (opt_text == null) {
      G_FirefoxXMLUtils.setNil(elm);
    } else {
      elm.appendChild(doc.createTextNode(opt_text));
    }
  }

  return elm;
}

/**
 * The xml namespace that we use for clobber
 */
CLB_XMLUtils.gNamespace = "http://google.com/browserstate";

/**
 * For use with xpath
 */
CLB_XMLUtils.gNamespaceResolver = function(prefix) {
  if (prefix == "g") {
    return CLB_XMLUtils.gNamespace;
  } else {
    return null;
  }
}

/**
 * Gets the XML namespace for a componentID. 
 */
CLB_XMLUtils.getComponentNamespace = function(compID) {
  return "moz://" + compID;
}

/**
 * Get a clobber xml doc with the auth block filled in based on with the
 * element and values specified in the authElements hash.
 */
CLB_XMLUtils.getDoc = function(topElmName, authBlock) {
  var doc = G_FirefoxXMLUtils.newXML(topElmName,
                                     "http://google.com/browserstate",
                                     {"xsi": G_FirefoxXMLUtils.XSI_NAMESPACE});

  if (!authBlock || isEmptyObject(authBlock)) {
    return doc;
  }

  var authElm = doc.createElement("auth");
  doc.documentElement.appendChild(authElm);

  for (var fieldName in authBlock) {
    this.addElm(authElm, fieldName, authBlock[fieldName]);
  }

  return doc;
}

/**
 * Gets the text of the first timestamp element in the provided document. The
 * clobber server responds with timestamps for /sync and /update operations
 * which the client needs to store.
 */
CLB_XMLUtils.getTimestamp = function(doc) {
  if (!doc) {
    G_DebugL(this, "WARNING: document is null or undefined.");
    return null;
  }
  
  var elm = doc.getElementsByTagName("timestamp")[0];

  if (!elm) {
    G_DebugL(this, "WARNING: Could not find timestamp element in document:\n" +
             G_FirefoxXMLUtils.getXMLString(doc));
    return null;
  }

  return elm.textContent;
}

// crappy unit tests (tm)
if (CLB_DEBUG) {
  function TEST_CLB_XMLUtils() {
    var expected1 = '<monkey xmlns="http://google.com/browserstate" ' +
                    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

    var expected2 = '<monkey xmlns="http://google.com/browserstate" ' +
                    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
                    '<auth><foo>bar</foo><hot>dog</hot></auth></monkey>';

    var zone = "TEST_CLB_XMLUtils";
    var doc = CLB_XMLUtils.getDoc("monkey");
    var result = G_FirefoxXMLUtils.getXMLString(doc);

    G_Assert(zone, result === expected1,
             "Unexpected result {%s} getting empty doc.".subs(result));

    doc = CLB_XMLUtils.getDoc("monkey", {"foo":"bar", "hot":"dog"});
    result = G_FirefoxXMLUtils.getXMLString(doc);

    G_Assert(zone, result === expected2,
             "Unexpected result {%s} getting doc with auth params."
             .subs(result));
  }
}

// G_debugService.loggifier.loggify(CLB_XMLUtils);
