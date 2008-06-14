// Copyright 2006, Google, Inc
//
// G_SetXOR()
// G_SetMerge()
// G_SetIntersection()
//
// These functions only work with arrays containing values that
// stringify nicely, so you probably don't want to use arrays of
// your own objects.

/**
 * Spits out two lists, the first containing the the values
 * in list1 but not list2, the second containing the values
 * in list2 but not list1. 
 */
function G_SetXOR(list1, list2) {
  var list1Map = {};
  var list2Map = {};
  var output1 = [];
  var output2 = [];

  for (var i = 0; i < list1.length; i++) {
    list1Map[list1[i]] = true;
  }

  for (var i = 0; i < list2.length; i++) {
    list2Map[list2[i]] = true;
  }

  for (var key in list1Map) {
    if (!(list2Map[key])) {
      output1.push(key);
    }
  }

  for (var key in list2Map) {
    if (!(list1Map[key])) {
      output2.push(key);
    }
  }

  return {
    xor: Array.concat(output1, output2),
    left: output1, 
    right: output2
  };
}

/**
 * Merges multiple arrays into one, removing duplicates.
 *
 * We can move this out into a helper later
 */
function G_SetMerge(opt_arg1, opt_arg2, opt_arg3, opt_arg4, opt_arg5,
	            opt_arg6, opt_arg7, opt_arg8, opt_arg9) {
  var resultMap = {};

  for (var i = 0; i < arguments.length; i++) {
    var arr = arguments[i];

    for (var j = 0; j < arr.length; j++) {
      resultMap[arr[j]] = true;
    }
  }

  var result = [];

  for (var key in resultMap) {
    result.push(key);
  }

  return result;
}

/**
 * Returns an array containing all the elements that are common
 * to all arrays
 */
function G_SetIntersection(opt_arg1, opt_arg2, opt_arg3, opt_arg4, opt_arg5, 
                           opt_arg6, opt_arg7, opt_arg8, opt_arg9) {
  var map = {};
  var result = [];
  
  for (var i = 0; i < arguments.length; i++) {
    var arr = arguments[i];

    for (var j = 0; j < arr.length; j++) {
      var value = arr[j];

      if (!isDef(map[value]) ) {
        map[value] = 0;
      }

      map[value]++;
      
      if (map[value] == arguments.length) {
        result.push(value);
      }
    }
  }

  return result;
}
