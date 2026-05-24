# Asset licenses

All assets bundled here are released under **CC0 1.0 Universal** (public domain).
Sources are reproduced verbatim; if you redistribute, keep this file.

## HDRI

- **industrial_workshop_foundry_2k.hdr** — Polyhaven
  Author: Sergej Majboroda
  Source: https://polyhaven.com/a/industrial_workshop_foundry
  License: CC0 1.0
  File: `hdri/industrial_workshop_foundry_2k.hdr` (~6.4 MB)

## Textures

- **concrete_floor_03** (diff, nor_gl, rough, ao @ 1k) — Polyhaven
  Author: Rob Tuytel
  Source: https://polyhaven.com/a/concrete_floor_03
  License: CC0 1.0
  Files under: `textures/concrete_floor/`

- **painted_metal_shutter** (diff, nor_gl, rough @ 1k) — Polyhaven
  Author: Rob Tuytel
  Source: https://polyhaven.com/a/painted_metal_shutter
  License: CC0 1.0
  Files under: `textures/painted_metal/`
  Use: applied to `mBody` (painted machinery panels).

- **metal_plate** (diff, nor_gl, rough @ 1k) — Polyhaven
  Author: Rob Tuytel
  Source: https://polyhaven.com/a/metal_plate
  License: CC0 1.0
  Files under: `textures/brushed_steel/`
  Use: applied to `mSteel` (tubes, hemispheres, carousel).

## Models

No external GLTF models are bundled. The beer-can geometry is constructed
procedurally inside the page script with a per-line `CanvasTexture` brand wrap.
This avoids Sketchfab's sign-in requirement and keeps the bundle smaller.

## Belt texture

The conveyor belt texture is generated procedurally with `CanvasTexture` in
`linewise_tres_lineas_oee_fabrica_3d_sin_paredes.html` (`makeBeltTexture()`).
No external image is used.
