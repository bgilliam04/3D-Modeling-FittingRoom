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

## xCloth/SHARP-style learned 3D garment inference

`/analyze-image` with `type=clothing` now attempts to call an external learned model service first.

Environment variables:

- `XCLOTH_INFER_URL` (default: `http://127.0.0.1:8008/infer`)
- `XCLOTH_TIMEOUT_MS` (default: `25000`)

Request sent to the service is `multipart/form-data`:

- `image`: PNG cutout bytes
- `garmentType`: normalized garment label (e.g. `shirt`, `pants`)
- `cutoutDataUrl`: optional data URL texture source

Expected service response formats:

1. Tri-mesh JSON:

```json
{
	"garmentModel": {
		"framework": "xcloth",
		"format": "tri-mesh",
		"positions": [0.0, 0.0, 0.0],
		"uvs": [0.0, 0.0],
		"indices": [0, 1, 2],
		"textureDataUrl": "data:image/png;base64,..."
	}
}
```

2. GLB base64:

```json
{
	"garmentModel": {
		"framework": "xcloth",
		"format": "glb-base64",
		"glbBase64": "..."
	}
}
```

If the service is unavailable or returns an invalid payload, backend falls back to a local approximation so the flow remains functional.

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
