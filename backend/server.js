const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sizeOf = require('image-size');
const Tesseract = require('tesseract.js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FittingRoom backend is running.' });
});

function buildAnalysis(file) {
  const { buffer, originalname, mimetype, size } = file;
  const dimensions = sizeOf(buffer);

  return {
    fileName: originalname,
    mimeType: mimetype,
    fileSize: size,
    width: dimensions.width,
    height: dimensions.height,
    orientation: dimensions.orientation || null,
    colorSpace: dimensions.type || null,
    notes: 'Backend metadata analysis for the uploaded asset.',
  };
}

function parseSizeGuideText(text) {
  const normalized = text.replace(/[_\-.]/g, ' ').toUpperCase();
  const sizePattern = /(XS|S|M|L|XL|XXL|XXXL|[0-9]{1,3}(?:\.[0-9]+)?)[\s:\-=]+([0-9]{1,3}(?:\.[0-9]+)?)/gi;
  const sizes = [];
  let match;

  while ((match = sizePattern.exec(normalized)) !== null) {
    const label = match[1].trim();
    const value = parseFloat(match[2]);
    if (!Number.isNaN(value)) {
      sizes.push({ label, value });
    }
  }

  if (sizes.length > 0) {
    return sizes;
  }

  return [
    { label: 'S', value: 34 },
    { label: 'M', value: 36 },
    { label: 'L', value: 38 },
    { label: 'XL', value: 40 },
  ];
}

async function parseSizeGuideImage(file) {
  const result = await Tesseract.recognize(file.buffer, 'eng', {
    logger: (m) => console.log('OCR:', m),
  });
  const ocrText = result.data?.text || '';
  return parseSizeGuideText(ocrText);
}

app.post('/upload-scan', upload.single('model'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No model file uploaded.' });
  }

  const analysis = buildAnalysis(req.file);
  res.json({ success: true, preview: { fileName: analysis.fileName, mimeType: analysis.mimeType }, analysis });
});

app.post('/analyze-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    const analysis = buildAnalysis(req.file);
    const sizes = req.body.type === 'sizeGuide' ? await parseSizeGuideImage(req.file) : [];
    res.json({ success: true, analysis, sizes });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
