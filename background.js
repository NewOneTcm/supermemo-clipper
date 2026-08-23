// MV3 service worker. With a default_popup set on the action, clicks open
// popup/popup.html instead of firing chrome.action.onClicked; all extraction
// and clipboard logic lives in popup/popup.js. The worker stays registered
// so the manifest can declare one, but it intentionally does nothing.
"use strict";
