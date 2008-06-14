// Copyright 2006 and onwards, Google

/**
 * An enumerator that wraps an enumerator returned by the bookmarks
 * datasource.  The bookmarks datasource enumerator enumerates all rdf
 * resources in the bookmarks datasource.  Then
 * this enumerator checks to see whether the bookmark is attached
 * to the bookmark tree and is the type of bookmark we normally record.
 * Then it forms a SyncItem from the bookmark.  Satisfies nsISimpleEnumerator
 */
function CLB_BookmarkEnumerator(bmEnumerator) {
  // Enumerator returned by bookmarks datasource.  We wrap this enumerator
  // and filter out unwanted bookmark resources
  this.bmEnumerator_ = bmEnumerator;

  // This is the GISyncItem returned by getNext.  If null, there are no
  // more bookmarks in the enumerator.
  this.nextBookmarkItem_ = null;

  // Advance the bookmarks datasource enumerator to the first bookmark
  // that we would like to actually record.
  this.advanceToValidBookmark();
}

CLB_BookmarkEnumerator.prototype.debugZone = "CLB_BookmarkEnumerator";

CLB_BookmarkEnumerator.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) ||
      iid.equals(Ci.nsISimpleEnumerator)) {
    return this;
  } else {
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
}

CLB_BookmarkEnumerator.prototype.hasMoreElements = function() {
  return this.nextBookmarkItem_ != null;
}

CLB_BookmarkEnumerator.prototype.getNext = function() {
  var next = this.nextBookmarkItem_;
  this.advanceToValidBookmark();
  return next;
}

CLB_BookmarkEnumerator.prototype.advanceToValidBookmark = function() {
  // Initialize to null - if we never find a valid bookmark, this
  // will stay null, indicating there are no more bookmarks to enumerate
  this.nextBookmarkItem_= null;  

  while (this.bmEnumerator_.hasMoreElements()) {

    // Check that the bookmark is actually attached to the bookmark tree
    var candidate = this.bmEnumerator_.getNext();
    if (!CLB_app.bmSyncer.shouldUpdateGivenTarget(candidate)) {
      continue;
    }

    // Create a GISyncItem from the bookmark and store for the next call
    // to getNext
    var item = CLB_app.bmSyncer.fillBookmarkItem(candidate);
    this.nextBookmarkItem_ = item;
    break;
  }
}

G_debugService.loggifier.loggify(CLB_BookmarkEnumerator.prototype);

if (CLB_DEBUG) {
  // TODO: put this somewhere more general?
  function TEST_CLB_CheckArray(expectedContents, arr) {
    if (expectedContents.length != arr.length) {
      G_Debug(this, "******Length of expected array: " +
              expectedContents.length +
              " does not match actual length: " + arr.length);
      return;
    }

    var idx;
    var item;
    var expected = [].concat(expectedContents);

    for (var i = 0; i < arr.length; i++) {
      item = arr[i];
      idx = expected.indexOf(item);
      if (idx < 0) {
        G_Debug(this, "******UNITTEST ERROR: Could not find item {" + item +
                "} in expected values.");
        return;
      }
      expected.splice(idx, 1);
    }
  }
  
  function TEST_CLB_BookmarkEnumerator() {
    var zone = "TEST_CLB_BookmarkEnumerator";
    G_Debug(zone, "Starting CLB_BookmarkEnumerator unit tests");
    
    var bmDS = CLB_app.bmSyncer.bmDS;
    var bmEnum = new CLB_BookmarkEnumerator(bmDS.GetAllResources());
    var titles = [];
    while (bmEnum.hasMoreElements()) {
      var item = bmEnum.getNext();

      // skip separators
      var nameProp = CLB_app.bmSyncer.propertiesToCollect_.getKey(
          CLB_BookmarkSyncer.nameRdfStr);
      if (!item.hasProperty(nameProp)) {
        continue;
      }
      titles[titles.length] = item.getProperty(nameProp);
    }
    
    var expectedTitles = ["Bookmarks Toolbar Folder", "Getting Started",
                          "Latest Headlines", "Quick Searches",
                          "Google Quicksearch",
                          "Answers.com Dictionary Quicksearch",
                          "Stock Symbol Quicksearch",
                          "Wikipedia Quicksearch",
                          "Firefox and Mozilla Links", "Firefox Start Page",
                          "Firefox Central", "Themes and Extensions",
                          "Mozilla.com", "Mozilla Developer Center",
                          "MozillaZine", "Mozilla Store",
                          "Get Involved - Help spread Firefox!"];
    TEST_CLB_CheckArray(expectedTitles, titles);

    G_Debug(zone, "All CLB_BookmarkEnumerator unit tests passed!");
  }
}
