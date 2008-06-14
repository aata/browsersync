// Copyright 2005 and onwards, Google


/**
 * CLB_rdf
 * Utility functions specific to rdf
 */
var CLB_rdf = new Object();

CLB_rdf.debugZone = "CLB_rdf";
CLB_rdf.rdfIFaces = ["nsIRDFLiteral", "nsIRDFResource", "nsIRDFBlob",
                     "nsIRDFInt", "nsIRDFDate", "nsIRDFNode"];

/**
 * Given an rdf node, extract the internal value by attempting to cast it to
 * each possible type.
 */
CLB_rdf.getValueFromNode = function(node) {
  for (var i = 0; i < CLB_rdf.rdfIFaces.length; i++) {
    var iface = CLB_rdf.rdfIFaces[i];
    if (node instanceof Ci[iface]) {
      return node.Value;
    }
  }

  // TODO: make this into an exception after we are sure that it never
  // will happen
  G_DebugL(this, "Warning - node has no type");
  return null;
}

/**
 * Return the contents of the given datastore dumped into a string, useful
 * for debugging.  If limit is positive, then cap the size of the string
 * at that length
 */
CLB_rdf.getRdfDs = function(datastore, limit) {
  var t = "";
  var all_res = datastore.GetAllResources();
  for(var r=0; all_res.hasMoreElements(); r++) {
    if(limit > 0 && t.length > limit) {
      return t;
    }
    var res = all_res.getNext();
    // res is a resource
    if (!(res instanceof Components.interfaces.nsIRDFResource)) {
      G_DebugL(this, "Failed to cast a resource to nsIRDFResource");
      continue;
    }
    var tr = r + " R: " + res.Value + G_File.LINE_END_CHAR;
    var ps = datastore.ArcLabelsOut(res);
    while (ps.hasMoreElements()) {
      var predicate = ps.getNext();
      // predicate is a resource
      if (!(predicate instanceof Components.interfaces.nsIRDFResource)) {
        G_DebugL(this, "Failed to cast a predicate to nsIRDFResource");
        continue;
      }
      try {
        tr += "  -R:  " + predicate.Value + G_File.LINE_END_CHAR;
        var ts = datastore.GetTargets(res, predicate, true);
        while (ts.hasMoreElements()) {
          var target = ts.getNext();
          var tmp = "";
          for (var i = 0; i < CLB_rdf.rdfIFaces.length; i++) {
            var iface = CLB_rdf.rdfIFaces[i];
            if (target instanceof Ci[iface]) {
              tmp = "   " + iface + ": " + target.Value + G_File.LINE_END_CHAR;
              break;
            }
          }

          if (tmp == "") {
            tr += "   UNKNOWN NODE TYPE" + G_File.LINE_END_CHAR;
          } else {
            tr += tmp;
          }
        }
      } catch (e) {
        // The history implementation of GetTargets can call GetResource
        // on an empty string, which leads to an NS_ERROR_ILLEGAL_VALUE
        // exception.
        tr += "    >R: EMPTY VALUE";
      }
    } // end ps
    t += tr + G_File.LINE_END_CHAR;
  }
  return t;
}

/**
 * Write the contents of the given datastore to a file in the current profile
 * with the given filename.  If limit is positive, then limit the length of
 * the output to that value.
 *
 * @returns An nsIFile pointing to the created file
 */
CLB_rdf.writeRdfToFile = function(datastore, limit, filename) {
  var file = G_File.getProfileFile(filename);
  
  file.createUnique(file.NORMAL_FILE_TYPE, 0644);
  var data = CLB_rdf.getRdfDs(datastore, limit);
  G_FileWriter.writeAll(file, data);

  return file;
}

/**
 * Given a datastore and a resource, get an rdfcontainer and initialize
 * it with the given datastore and resource.
 * Note that this function assumes that the given resource exists and is
 * a container.
 */
CLB_rdf.getInitializedContainer = function(datastore, containerResource) {
  var container = Cc["@mozilla.org/rdf/container;1"]
                  .getService(Ci.nsIRDFContainer);
  container.Init(datastore, containerResource);
  return container;
}

/**
 * Given a container resource, return how many items are in the container.
 * Note that this function assumes that the given resource exists and is
 * a container.
 */
CLB_rdf.getContainerCount = function(datastore, containerResource) {
  var container = CLB_rdf.getInitializedContainer(datastore,
                                                  containerResource);
  return container.GetCount();
}

G_debugService.loggifier.loggify(CLB_rdf);
