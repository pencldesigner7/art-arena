#!/usr/bin/env python3
"""Remove the flat navy sky background from the Community hero Colosseum artwork.

Produces a clean RGBA cutout:
  1. Classify sky pixels (blue-dominant, matching the uniform navy sky).
  2. Remove all sky-classified pixels (verified safe: every building pixel is
     warm and never matches; enclosed sky through the arches is removed too).
  3. De-fringe the JPEG blue halo on the building edge, feather the alpha.
"""
import numpy as np
from PIL import Image, ImageFilter

SRC = '/home/user/art-arena/hero-source.jpeg'
OUT = '/home/user/art-arena/server/public/community-hero-colosseum.png'

im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(np.int16)
h, w, _ = a.shape
R, G, B = a[..., 0], a[..., 1], a[..., 2]

# --- 1. sky classification: navy sky has B >> R, building is warm R >= B ------
sky = (B - R > 35) & (B > 70)

# --- 2. remove ALL sky-classified pixels ------------------------------------
# Verified by sampling: no building pixel (warm ochre / deep arch shadows) ever
# matches the sky criterion, and the ONE enclosed sky patch seen through the
# upper arch (20,59,90) is pure sky — so a global key is safe and also clears
# sky visible through arch openings that flood-fill from the border would miss.

alpha = (~sky).astype(np.float32)  # building = 1, sky = 0

# --- 3. de-fringe: kill the JPEG blue halo on the silhouette edge ------------
al = Image.fromarray((alpha * 255).astype(np.uint8), 'L')
al = al.filter(ImageFilter.MinFilter(3))          # slight erosion eats the halo
al = al.filter(ImageFilter.GaussianBlur(0.9))      # feather the jaggies
aln = np.asarray(al).astype(np.float32) / 255.0
# remap so the feather is soft but the silhouette stays crisp
aln = np.clip((aln - 0.18) / 0.72, 0, 1)

# where a semi-transparent pixel is still blue-tinted, fade it further (deblue)
blueish = (B - R) > 20
halo = blueish & (aln > 0.05) & (aln < 0.97)
aln[halo] *= 0.35

rgba = np.dstack([a.astype(np.uint8), (aln * 255).astype(np.uint8)])
out = Image.fromarray(rgba, 'RGBA')
out.save(OUT)

coverage = (aln > 0.5).mean()
print(f'saved {OUT}  size={out.size}  opaque coverage={coverage:.1%}')
