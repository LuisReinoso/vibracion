# Bundled music

Both tracks are in the public domain, marked with the Public Domain Mark 1.0. They can be redistributed, remixed and used commercially with no permission and no attribution required. The credits below are here because it is the decent thing to do, not because the licence demands it.

## sun-is-setting-fast.mp3

"The Sun is Setting Fast", by Worm's Eye View (2001). Released on the Maravines netlabel.

- Source: https://archive.org/details/MARAV984C
- Licence: https://creativecommons.org/publicdomain/mark/1.0/

A slow track with a very steady pitch: the dominant frequency stays inside a band about 75 Hz wide for the whole piece. Good for watching a Chladni figure hold still long enough to look at it.

## organic-dissonance.mp3

"Organic Dissonance", by Thomas Park (2019). Released on the Treetrunk netlabel as treetrunk 441.

- Source: https://archive.org/details/Organic_Dissonance
- Licence: https://creativecommons.org/publicdomain/mark/1.0/

Far more mobile, with a range of about 385 Hz. Good for watching the pattern morph.

## What was done to them

Converted to mono at 96 kbps to keep the repository small. Nothing was trimmed or edited otherwise. Mono at 96 kbps is more than enough for what the program does, which is look at the spectrum below 6 kHz.

```
ffmpeg -i original.mp3 -ac 1 -b:a 96k -ar 44100 out.mp3
```

## Swapping the tracks

The buttons come from `index.html`, via `data-track` and `data-label`. Any file the browser can decode will work. Afterwards check that panel B reads more than 2x threshold, or the water will not move.
