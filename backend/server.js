const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sizeOf = require('image-size');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

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

async function removeImageBackground(imageBuffer) {
  try {
    const image = sharp(imageBuffer).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const width = info.width;
    const height = info.height;

    if (channels < 4) {
      return image.png().toBuffer();
    }

    const borderBand = Math.max(4, Math.round(Math.min(width, height) * 0.03));
    const background = [0, 0, 0];
    let sampleCount = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const isBorderPixel =
          x < borderBand ||
          y < borderBand ||
          x >= width - borderBand ||
          y >= height - borderBand;

        if (!isBorderPixel) continue;

        const index = (y * width + x) * channels;
        background[0] += data[index];
        background[1] += data[index + 1];
        background[2] += data[index + 2];
        sampleCount += 1;
      }
    }

    if (sampleCount === 0) {
      return image.png().toBuffer();
    }

    background[0] = background[0] / sampleCount;
    background[1] = background[1] / sampleCount;
    background[2] = background[2] / sampleCount;

    const threshold = 112;
    const thresholdSquared = threshold * threshold;
    const output = Buffer.from(data);
    const visited = new Uint8Array(width * height);
    const stack = [];

    const isBackgroundPixel = (x, y) => {
      const index = (y * width + x) * channels;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];

      const distanceSquared =
        (red - background[0]) * (red - background[0]) +
        (green - background[1]) * (green - background[1]) +
        (blue - background[2]) * (blue - background[2]);

      return distanceSquared <= thresholdSquared;
    };

    const pushIfBackground = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (visited[index]) return;
      if (!isBackgroundPixel(x, y)) return;
      visited[index] = 1;
      stack.push(index);
    };

    const isSkinTonePixel = (red, green, blue) => {
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const chroma = maxChannel - minChannel;

      if (red < 85 || green < 35 || blue < 15) return false;
      if (chroma < 10) return false;
      if (Math.abs(red - green) < 12) return false;
      if (red <= green || red <= blue) return false;

      const saturation = maxChannel === 0 ? 0 : chroma / maxChannel;
      return saturation > 0.08;
    };

    for (let x = 0; x < width; x += 1) {
      pushIfBackground(x, 0);
      pushIfBackground(x, height - 1);
    }

    for (let y = 0; y < height; y += 1) {
      pushIfBackground(0, y);
      pushIfBackground(width - 1, y);
    }

    while (stack.length > 0) {
      const index = stack.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      const offset = index * channels;

      output[offset + 3] = 0;

      pushIfBackground(x + 1, y);
      pushIfBackground(x - 1, y);
      pushIfBackground(x, y + 1);
      pushIfBackground(x, y - 1);
    }

    for (let offset = 0; offset < output.length; offset += channels) {
      const red = output[offset];
      const green = output[offset + 1];
      const blue = output[offset + 2];
      const alpha = output[offset + 3];

      if (alpha === 0) continue;
      if (red > 235 && green > 235 && blue > 235) continue;

      if (isSkinTonePixel(red, green, blue)) {
        output[offset + 3] = 0;
      }
    }

    return sharp(output, {
      raw: {
        width,
        height,
        channels,
      },
    })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('Background removal failed:', error);
    // Return original buffer if processing fails
    return imageBuffer;
  }
}

function convertToDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function parseSizeGuideText(text) {
  const sizes = [];
  const processedLabels = new Set();
  
  // Remove common OCR artifacts and normalize
  let cleanText = text
    .replace(/[•·•◦\[\]]/g, '') // Remove bullet points and brackets
    .replace(/[%]/g, '') // Remove percentage signs
    .replace(/\s+/g, ' ') // Normalize whitespace
    .toUpperCase();
  
  console.log('Cleaned text:', cleanText);
  
  // Strategy: Extract size headers and values systematically
  
  // Step 1: Find all size headers (2T, 3T, etc.) and their positions
  const sizeHeaderPattern = /([0-9]+T)/gi;
  let match;
  const sizeHeaders = [];
  
  while ((match = sizeHeaderPattern.exec(cleanText)) !== null) {
    sizeHeaders.push({
      label: match[1],
      index: match.index
    });
  }
  
  console.log('Found size headers:', sizeHeaders);
  
  // Step 2: Try to fix OCR errors - look for suspicious patterns near size headers
  // For example, if we have 2T, 3T, AR, 5T, 6T - AR is likely 4T
  if (sizeHeaders.length > 1) {
    // Check for gaps in the sequence (e.g., 2T, 3T, 5T -> missing 4T)
    for (let i = 0; i < sizeHeaders.length - 1; i++) {
      const current = parseInt(sizeHeaders[i].label);
      const next = parseInt(sizeHeaders[i + 1].label);
      
      if (next - current > 1) {
        // Gap found - look for OCR artifacts between them
        const gapStart = sizeHeaders[i].index + sizeHeaders[i].label.length;
        const gapEnd = sizeHeaders[i + 1].index;
        const gapText = cleanText.substring(gapStart, gapEnd);
        
        console.log(`Gap found between ${current}T and ${next}T: "${gapText}"`);
        
        // Try to construct missing headers
        for (let j = current + 1; j < next; j++) {
          const missingLabel = `${j}T`;
          if (!sizeHeaders.some(h => h.label === missingLabel)) {
            sizeHeaders.splice(i + 1, 0, {
              label: missingLabel,
              index: -1, // Mark as inserted
              inferred: true
            });
          }
        }
      }
    }
    sizeHeaders.sort((a, b) => parseInt(a.label) - parseInt(b.label));
  }
  
  console.log('Fixed size headers:', sizeHeaders);
  
  // Step 3: Extract all numbers from the text
  const numberPattern = /(\d+(?:\.\d+)?)/g;
  const numbers = [];
  while ((match = numberPattern.exec(cleanText)) !== null) {
    numbers.push({
      value: parseFloat(match[1]),
      index: match.index
    });
  }
  
  console.log('Found numbers:', numbers);
  
  // Step 4: Match size headers with appropriate values
  // Look for the first sequence of body measurements
  if (sizeHeaders.length > 0) {
    // Find consecutive numbers and pair them with size headers
    let bodyMeasurements = [];
    
    // Extract all numbers in order 
    if (numbers.length > 0) {
      // Find the first contiguous sequence of valid measurements
      // that matches or exceeds our size header count
      let currentSequence = [];
      
      for (const num of numbers) {
        if (num.value > 5 && num.value < 100) {
          currentSequence.push(num);
        } else if (currentSequence.length > 0) {
          // Sequence broken, check if we found enough
          if (currentSequence.length >= Math.min(sizeHeaders.length, 4)) {
            bodyMeasurements = currentSequence.slice(0, sizeHeaders.length);
            break;
          }
          currentSequence = [];
        }
      }
      
      // Check final sequence
      if (bodyMeasurements.length === 0 && currentSequence.length >= Math.min(sizeHeaders.length, 4)) {
        bodyMeasurements = currentSequence.slice(0, sizeHeaders.length);
      }
    }
    
    console.log('Body measurements:', bodyMeasurements);
    
    if (bodyMeasurements.length > 0 && bodyMeasurements.length >= Math.min(sizeHeaders.length, 4)) {
      // Match headers with measurements
      // Use only as many headers as we have measurements
      const matchCount = Math.min(sizeHeaders.length, bodyMeasurements.length);
      
      for (let i = 0; i < matchCount; i++) {
        const label = sizeHeaders[i].label;
        const value = bodyMeasurements[i].value;
        
        if (!processedLabels.has(label)) {
          sizes.push({ label, value });
          processedLabels.add(label);
          console.log(`Matched: ${label} = ${value}`);
        }
      }
    }
  }

  if (sizes.length > 0) {
    console.log('Returning parsed sizes:', sizes);
    return sizes;
  }

  console.log('No sizes found, returning defaults');
  // Fallback to default sizes
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
  console.log('Raw OCR text:', ocrText);
  const sizes = parseSizeGuideText(ocrText);
  console.log('Parsed sizes:', sizes);
  return sizes;
}

app.post('/upload-scan', upload.single('model'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No model file uploaded.' });
  }

  const analysis = buildAnalysis(req.file);
  res.json({ success: true, preview: { fileName: analysis.fileName, mimeType: analysis.mimeType }, analysis });
});

app.post('/analyze-image', upload.single('image'), async (req, res) => {
  console.log('=== /analyze-image endpoint hit ===');
  console.log('req.body:', req.body);
  console.log('req.file:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'No file');
  
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    const analysis = buildAnalysis(req.file);
    console.log('Image type:', req.body.type);
    
    let sizes = [];
    let processedImageUrl = null;
    
    if (req.body.type === 'sizeGuide') {
      console.log('Processing as size guide...');
      sizes = await parseSizeGuideImage(req.file);
      console.log('Size guide processing complete. Sizes:', sizes);
    } else if (req.body.type === 'clothing') {
      console.log('Processing as clothing image with background removal...');
      const processedBuffer = await removeImageBackground(req.file.buffer);
      processedImageUrl = convertToDataUrl(processedBuffer);
      console.log('Background removal complete');
    } else {
      console.log('Processing as generic image');
    }
    
    console.log('Sending response:', { success: true, analysis, sizes, processedImageUrl: processedImageUrl ? 'included' : 'none' });
    res.json({ success: true, analysis, sizes, processedImageUrl });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
