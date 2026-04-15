# FittingRoom Backend

This backend folder contains a simple Express API for analyzing uploaded images.

## Install

```bash
cd backend
npm install
```

## Run

```bash
npm start
```

## Build shape templates from outline PNGs

1. Put PNG outlines into garment subfolders under `clothing-outline-pngs/`.
2. Run:

```bash
npm run generate:clothing-shapes:from-outlines
```

This updates `clothing-shapes.json` by keeping existing garment detection thresholds and replacing each garment's `shapeOutlines` with templates generated from PNG silhouettes.

## API

POST `/analyze-image`
- Content type: `multipart/form-data`
- Field name: `image`

Returns basic image metadata and dimensions.

## Next steps

- Replace the placeholder analysis logic in `server.js` with real image analysis or machine learning model inference.
- Add authentication, validation, and persistent storage if needed.
