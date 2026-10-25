# VIT Vellore reference map

`vit-vellore-campus.jpg` is the campus map supplied by the user. The picker preserves that artwork and overlays traced SVG polygons; it does not infer navigation or precise geographic boundaries from the image.

`data/campus-map.json` at the repository root is the shared location catalog and region geometry. Points use the image's original 850 × 638 pixel coordinates. Each selectable location belongs to exactly one region. Where the reference labels multiple services together, a shared region opens a location menu instead of assigning invented individual footprints.

The report menu, map picker, API validation, and dashboard use the same IDs. `backend/tests/test_fixtures.py` checks coverage and bounds; the frontend tests cover selection, synchronization, shared choices, keyboard input, disabled states, zoom, and report submission.
