# Clothing Outline Images

Put outline image files (PNG, JPG, JPEG) in subfolders by garment type:

- `clothing-outline-pngs/shirt/*.{png,jpg,jpeg}`
- `clothing-outline-pngs/dress/*.{png,jpg,jpeg}`
- `clothing-outline-pngs/pants/*.{png,jpg,jpeg}`
- `clothing-outline-pngs/shorts/*.{png,jpg,jpeg}`
- `clothing-outline-pngs/skirt/*.{png,jpg,jpeg}`
- `clothing-outline-pngs/jacket/*.{png,jpg,jpeg}`

Expected input images:
- PNG/JPG/JPEG formats supported
- Transparent background with garment silhouette as non-transparent pixels (for PNG with alpha)
- If no alpha channel, near-white pixels are treated as background

Then run:

```bash
npm run generate:clothing-shapes:from-outlines
```

This updates `backend/clothing-shapes.json` by keeping each garment's existing numeric profile and replacing `shapeOutlines` with templates and a width profile generated from these PNG masks.
