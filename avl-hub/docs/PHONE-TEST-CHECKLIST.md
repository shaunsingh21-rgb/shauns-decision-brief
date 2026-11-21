# Real-iPhone test checklist (about 20 minutes)

Every automated phone test so far used a Chromium **emulation** of an iPhone (screen size, touch, user agent). None of it was real Safari. This list covers what only a real phone can show. Tick, and write down what you actually saw.

**Before you start:** the app must be reachable over **HTTPS** from the phone (a tunnel such as Tailscale or Cloudflare Tunnel is fine for a test; plain `http://` cannot install, use the camera or work offline). Use a throwaway admin password and a copy of the data, not real records. Test in **Safari**, not Chrome: only Safari can Add to Home Screen on iPhone.

## 1. Open and sign in (in Safari)
- [ ] The sign-in page fits the screen, no sideways scrolling, the keyboard does not hide the Sign in button.
- [ ] Your password manager offers to fill the password.
- [ ] After sign-in the Equipment screen loads. Note how long it takes.

## 2. Install it
- [ ] Share → **Add to Home Screen**. The icon and the name "AVL Tech Hub" look right.
- [ ] Open it from the Home Screen: it opens full screen with no Safari bar.
- [ ] **You are signed out in the installed app** (iPhone keeps Safari and the installed app separate). Sign in again inside the installed app: this is normal, but tell me if the guides need to say so.

## 3. Everyday use (in the installed app)
- [ ] Every top button and tab can be tapped without a miss. Scroll the tab row: can you reach Skill matrix, Admin, Account? (Known: 4 of 7 tabs are off-screen with no scroll hint.)
- [ ] The notch / Dynamic Island does not cover the header; the home bar does not cover the bottom of a page.
- [ ] Open an item. Is the specs table readable (names not broken letter by letter)?
- [ ] Add an equipment item with the wizard. **Take photo** opens the real camera. The photo uploads. (Check: does the saved photo still contain your location? It should not.)
- [ ] Place a pin on a photo panel using your finger. Then try with the on-screen keyboard.

## 4. Offline (the headline feature)
- [ ] While online, open the library and two items so they are saved.
- [ ] Turn on **Airplane mode**. The header says it is offline. Open the saved items: they load.
- [ ] Log an issue offline. It says it is saved on the device. Turn Airplane mode off: the change syncs (check the Sync page).
- [ ] Close the app completely (swipe it away), re-open it offline: still signed in and the saved items open? (Known risk: iOS can clear saved web data after a period of not using the app. Note how long you waited.)
- [ ] Sign out while offline, then reconnect: you are really signed out on the server (ask an admin to check the audit list).

## 5. Dark room
- [ ] Dark mode follows the phone. Brightness at minimum: is every label still readable?
- [ ] Pinch-zoom or turn up Text Size in iOS settings: does the layout hold up?

## 6. Report back
Send me: your iPhone model and iOS version, the failing step numbers, and a screenshot of each problem. Anything marked "Known" above is already on my list.
