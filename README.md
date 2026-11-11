# YouTube Quiet

YouTube ad blocker for Chrome, Opera and Opera GX. Simple on/off switch. Runs in your browser, no proxy or accounts.

## install

1. Download the ZIP from [releases](https://github.com/dmonskull/youtube-quiet/releases/latest) and extract it.
2. Open `chrome://extensions` in Chrome or `opera://extensions` in Opera / Opera GX. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `youtube-quiet` folder.
4. Reload YouTube. That's it.

If playback gets stuck, turn it off and reload the tab. Changes to the toggle need a reload to take effect. Don't run it alongside another YouTube ad blocker.

## what to expect

No pre-rolls, no mid-rolls, no ad slots in the feed. When you open a video the player sometimes restarts once, about a second in. That's the extension swapping out a stream YouTube was holding back for an ad.

Still experimental. YouTube changes its ad delivery a lot and this can break. Tested logged out on Chrome 157, Opera 139 and Opera GX 138. Not tested yet: logged-in accounts, YouTube Music, Shorts ads, live streams.

## how it works

- Removes the ad lists from the player data before the player reads them.
- Sends player requests marked as an idle session. Without this YouTube's servers hold the video back for the length of the ad, even though no ad plays.
- If an ad starts anyway, reloads the video at the same spot.
- Blocks ad tracking requests and hides ad slots on the page.

YouTube plants fake requests and fake ad data to catch blockers. The filter checks real URLs and only touches real player responses, so it leaves those alone. Details are in the comments in `engine.js`.

## tests

Needs Node 22+ and Chrome for Testing, Opera or Opera GX.

```sh
export BROWSER_BIN="/path/to/browser binary"
HEADLESS=1 test/launch.sh /tmp/ytq-profile &
node test/fixture.mjs                      # offline, fake YouTube page
node test/live.mjs --journey 0e3GPea1Tyg   # real YouTube
node test/quit.mjs
```

Use a new profile folder each time you test pre-rolls. A fresh profile gets one on its first video, a used one often doesn't.

The techniques come from what the [uBlock Origin filter lists](https://github.com/uBlockOrigin/uAssets) document about YouTube. No code from them is included. Not affiliated with YouTube or Google.
