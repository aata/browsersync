// Copyright 2006 and onwards, Google

/**
 * An enumerator that wraps an enumerator returned by the history
 * datasource.  The history datasource enumerator enumerates all rdf
 * resources in the history datasource.  Then it forms a SyncItem from
 * the history item.  Satisfies nsISimpleEnumerator
 */
function CLB_HistoryEnumerator(histEnumerator) {
  // Enumerator returned by history datasource.  We wrap this enumerator
  // and turn the history items into GISyncItems
  this.histEnumerator_ = histEnumerator;

  // This is the GISyncItem returned by getNext.  If null, there are no
  // more history items in the enumerator.
  this.nextHistoryItem_ = null;

  // Advance the history datasource enumerator to the first item
  // that we would like to actually record.
  this.advanceHistoryItem_();
}

CLB_HistoryEnumerator.prototype.debugZone = "CLB_HistoryEnumerator";

CLB_HistoryEnumerator.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsISimpleEnumerator)) {
    return this;
  } else {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
}

CLB_HistoryEnumerator.prototype.hasMoreElements = function() {
  return this.nextHistoryItem_ != null;
}

CLB_HistoryEnumerator.prototype.getNext = function() {
  var next = this.nextHistoryItem_;
  this.advanceHistoryItem_();
  return next;
}

/**
 * Advance to the next history item that creates a valid GISyncItem.
 * If nextHistoryItem_ is null after calling this function, it means
 * there are no more history items to get.
 */
CLB_HistoryEnumerator.prototype.advanceHistoryItem_ = function() {
  // Initialize to null - if we never find a history item, this
  // will stay null, indicating there are no more history items
  this.nextHistoryItem_ = null;  

  while (this.nextHistoryItem_ == null &&
         this.histEnumerator_.hasMoreElements()) {

    var candidate = this.histEnumerator_.getNext();
    if (!(candidate instanceof Ci.nsIRDFResource)) {
      G_Debug(this, "Failed to cast a resource to nsIRDFResource");
      continue;
    }

    // All history items have the same parent and arc
    var root = CLB_app.historySyncer.histRdfServ_.GetResource(
        CLB_HistorySyncer.rootRdfStr);
    var childArc = CLB_app.historySyncer.histRdfServ_.GetResource(
        CLB_HistorySyncer.childRdfStr);
    var candidateValue = CLB_rdf.getValueFromNode(candidate);

    // Create a GISyncItem from the history item and store for the next call
    // to getNext - note that this could return null, but in that case we'll
    // just continue looking for another history item
    var item = CLB_app.historySyncer.getUpdateItem_(root, childArc,
                                                    candidateValue);
    this.nextHistoryItem_ = item;
  }
}

G_debugService.loggifier.loggify(CLB_HistoryEnumerator.prototype);
