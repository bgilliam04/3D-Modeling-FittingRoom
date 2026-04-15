# Clothing Outline PNGs

Put outline PNG files in subfolders by garment type:

- `clothing-outline-pngs/shirt/*.png`
- `clothing-outline-pngs/dress/*.png`
- `clothing-outline-pngs/pants/*.png`
- `clothing-outline-pngs/shorts/*.png`
- `clothing-outline-pngs/skirt/*.png`
- `clothing-outline-pngs/jacket/*.png`

Expected input image:
- Transparent background with garment silhouette as non-transparent pixels.
- If no alpha channel exists, near-white pixels are treated as background.

Then run:

```bash
npm run generate:clothing-shapes:from-outlines
```

This updates `backend/clothing-shapes.json` by keeping each garment's existing numeric profile and replacing `shapeOutlines` with templates and a width profile generated from these PNG masks.
