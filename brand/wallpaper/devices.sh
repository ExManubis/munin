#!/bin/zsh
# Render one variant for each Apple screen: ./devices.sh nordlys
# Cell sizes keep the lockup about two-thirds of the way across. They aren't multiples of 16, which suits
# the rune variants (stroked glyphs); Munin Block glyphs want 16, 32 or 48. On the tall screens the stacked
# lockup sits a little high, so it stays inside Nordlys's curtains rather than in the dark below them.
cd "${0:A:h}"
V=${1:-nordlys}
render() { QUERY=$4 TAG=$1 ./render.sh $2 $3 $V; }
render studio-display     5120 2880 'cell=28'
render macbook-pro-16     3456 2234 'cell=19'
render ipad               2752 2752 'cell=19&logo=stacked&y=0.42' # square: fills the 13" iPad Pro either way round
render iphone             1320 2868 'cell=14&logo=stacked&y=0.45' # 17 Pro Max; the Pro and Air are the same shape
render iphone-duo-inner   1878 2670 'cell=17&logo=stacked&y=0.42'
render iphone-duo-outer   1398 2034 'cell=14&logo=stacked&y=0.42'
