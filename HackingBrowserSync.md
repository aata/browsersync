Setting up BrowserSync for development is pretty easy.

# Check out the code #

To check out the code, you'll need an svn client. Download one here: http://subversion.tigris.org/.

Once you have one, go to the [source tab](http://code.google.com/p/browsersync/source/checkout) to see the commands to issue to check out.

# Set up a development profile #

Life will be easier with a special Firefox profile for BrowserSync development. Here's how to set one up:

**Mac/Linux**:
```
mkdir -p p1/extensions
echo "path/to/browsersync/checkout/client/" > "p1/extensions/browserstate@google.com"
```

**Windows**:
```
mkdir p1
mkdir p1\extensions
echo "c:\path\to\browsersync\checkout\client\" > "p1\extensions\browserstate@google.com"
```

For example, if you checked out BrowserSync to `c:\browsersync`, the path to put in this file would be `c:\browsersync\client`.

Next, create a file called `user.js` in the profile folder, and copy the following lines into it:

```
user_pref("nglayout.debug.disable_xul_cache",true);
user_pref("browser.dom.window.dump.enabled",true);
user_pref("javascript.options.showInConsole",true);
user_pref("extensions.logging.enabled",true);
```

# Development Extensions (Optional) #

There are some extensions that are useful for extension developers:

  * [Extension Developer's Extension](http://ted.mielczarek.org/code/mozilla/extensiondev/)
  * [ChromeBug](http://www.getfirebug.com/releases/)

# Running it #

To run Firefox with your development BrowserSync, start Firefox like this from the command line:

**Windows**
```
c:\program files\mozilla firefox\firefox.exe -profile p1 -no-remote -console
```

**Mac/Linux**
```
/path/to/firefox -profile p1 -no-remote -console
```

Firefox will load the extension directly from your extension directory. This means that there is no build phase to hacking on BrowserSync. Just make your changes and restart the browser.