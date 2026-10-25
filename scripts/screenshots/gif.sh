#!/bin/bash
# usage.gif from capture.mjs's frames: halved from 2x to 1280 by 800 by an
# exact 2:1 box filter (Lanczos rings around glyphs), a palette per frame (one
# for the whole GIF had no room for the T's cyan), each frame held as gif.txt
# says, the last one as gif-final-delay.txt does (in hundredths of a second).
#
#   bash gif.sh <out dir>
set -euo pipefail
cd "$1"
ffmpeg -v error -y -f concat -safe 0 -i gif.txt \
    -vf "scale=1280:800:flags=area,split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a" \
    -fps_mode vfr -final_delay "$(cat gif-final-delay.txt)" -loop 0 usage.gif
