const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sizeOf = require('image-size');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FittingRoom backend is running.' });
});

app.post('/analyze-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    const { buffer, originalname, mimetype, size } = req.file;
    const dimensions = sizeOf(buffer);

    const analysis = {
      fileName: originalname,
      mimeType: mimetype,
      fileSize: size,
      width: dimensions.width,
      height: dimensions.height,
      orientation: dimensions.orientation || null,
      colorSpace: dimensions.type || null,
      notes: 'This is a starter image-analysis endpoint. Replace with model analysis logic as needed.'
    };

    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
