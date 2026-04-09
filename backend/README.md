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

## API

POST `/analyze-image`
- Content type: `multipart/form-data`
- Field name: `image`

Returns basic image metadata and dimensions.

## Next steps

- Replace the placeholder analysis logic in `server.js` with real image analysis or machine learning model inference.
- Add authentication, validation, and persistent storage if needed.
