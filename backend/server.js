const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const sizeOf = require('image-size');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

let removeBackgroundFn = null;
let loggedRawImageUnavailable = false;

function getRemoveBackground() {
  if (!removeBackgroundFn) {
    ({ removeBackground: removeBackgroundFn } = require('@imgly/background-removal-node'));
  }

  return removeBackgroundFn;
}

async function removeBackgroundWithSilentWorker(orientedBuffer) {
  const workerPath = path.join(__dirname, 'scripts', 'remove-background-worker.js');

  return new Promise((resolve, reject) => {
    const worker = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.ok && typeof message.outputBase64 === 'string') {
        finish(() => resolve(Buffer.from(message.outputBase64, 'base64')));
        return;
      }

      const errorMessage = typeof message.error === 'string' ? message.error : 'Background removal worker failed.';
      finish(() => reject(new Error(errorMessage)));
    });

    worker.on('error', (error) => {
      finish(() => reject(error));
    });

    worker.on('exit', (code) => {
      if (settled) {
        return;
      }

      const exitCode = Number.isInteger(code) ? code : -1;
      finish(() => reject(new Error(`Background removal worker exited before returning output (code ${exitCode}).`)));
    });

    worker.send({
      imageBase64: orientedBuffer.toString('base64'),
      mimeType: 'image/png',
    });
  });
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 4000;
const XCLOTH_INFER_URL = process.env.XCLOTH_INFER_URL || 'http://127.0.0.1:8008/infer';
const XCLOTH_TIMEOUT_MS = Number.parseInt(process.env.XCLOTH_TIMEOUT_MS || '25000', 10);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FittingRoom backend is running.' });
});

function buildAnalysis(file) {
  if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
    return {
      fileName: file?.originalname || 'unknown',
      mimeType: file?.mimetype || null,
      fileSize: Number(file?.size) || 0,
      width: null,
      height: null,
      orientation: null,
      colorSpace: null,
      notes: 'Backend metadata analysis skipped: invalid or missing image buffer.',
    };
  }

  const { buffer, originalname, mimetype, size } = file;
  let dimensions = {};
  try {
    dimensions = sizeOf(buffer) || {};
  } catch (error) {
    dimensions = {};
  }

  return {
    fileName: originalname,
    mimeType: mimetype,
    fileSize: size,
    width: Number.isFinite(dimensions.width) ? dimensions.width : null,
    height: Number.isFinite(dimensions.height) ? dimensions.height : null,
    orientation: dimensions.orientation || null,
    colorSpace: dimensions.type || null,
    notes: 'Backend metadata analysis for the uploaded asset.',
  };
}

function dedupeSizes(sizes) {
  const uniqueSizes = [];
  const seenKeys = new Set();

  for (const size of sizes || []) {
    if (!size || typeof size.value === 'undefined' || !size.label) {
      continue;
    }

    const labelKey = normalizeSizeLabel(size.label);
    const measurementKey = size.measurementType ? String(size.measurementType).trim().toUpperCase() : '';
    const dedupeKey = measurementKey ? `${labelKey}|${measurementKey}` : labelKey;
    if (!labelKey || seenKeys.has(dedupeKey)) {
      continue;
    }

    seenKeys.add(dedupeKey);
    uniqueSizes.push(size);
  }

  return uniqueSizes;
}

function normalizeSizeLabel(label) {
  return String(label || '')
    .trim()
    .toUpperCase()
    .replace(/[.,:;()\[\]{}]/g, '')
    .replace(/\s+/g, '')
    .replace(/(\d+)X[-_\s]*L/g, '$1XL')
    .replace(/X[-_\s.]*L/g, 'XL')
    .replace(/^(\d+)XL$/, '$1XL')
    .replace(/^(\d+)T$/, '$1T');
}

function parseNumericSizeLabel(label) {
  const normalized = normalizeSizeLabel(label);
  if (!normalized) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function greatestCommonDivisor(first, second) {
  let a = Math.abs(Math.round(first));
  let b = Math.abs(Math.round(second));

  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

function inferNumericSizeSequence(columns) {
  const numericColumns = (columns || [])
    .map((column, index) => ({
      index,
      value: parseNumericSizeLabel(column?.label),
    }))
    .filter((column) => Number.isFinite(column.value));

  if (numericColumns.length < 3) {
    return null;
  }

  const uniqueValues = [...new Set(numericColumns.map((column) => column.value))].sort((a, b) => a - b);
  if (uniqueValues.length < 3) {
    return null;
  }

  let step = 0;
  for (let index = 1; index < uniqueValues.length; index += 1) {
    const difference = uniqueValues[index] - uniqueValues[index - 1];
    if (difference <= 0) {
      continue;
    }
    step = step === 0 ? difference : greatestCommonDivisor(step, difference);
  }

  if (!Number.isFinite(step) || step < 1) {
    return null;
  }

  const firstNumericColumn = numericColumns.slice().sort((a, b) => a.index - b.index)[0];
  const start = firstNumericColumn.value - firstNumericColumn.index * step;

  if (!Number.isFinite(start)) {
    return null;
  }

  return { start, step };
}

function inferSuffixedNumericSizeSequence(columns, suffix) {
  const suffixPattern = new RegExp(`^(\\d+)${suffix}$`);
  const numericColumns = (columns || [])
    .map((column, index) => {
      const match = normalizeSizeLabel(column?.label).match(suffixPattern);
      return {
        index,
        value: match ? Number.parseInt(match[1], 10) : null,
      };
    })
    .filter((column) => Number.isFinite(column.value));

  if (numericColumns.length < 3) {
    return null;
  }

  const uniqueValues = [...new Set(numericColumns.map((column) => column.value))].sort((a, b) => a - b);
  if (uniqueValues.length < 3) {
    return null;
  }

  let step = 0;
  for (let index = 1; index < uniqueValues.length; index += 1) {
    const difference = uniqueValues[index] - uniqueValues[index - 1];
    if (difference <= 0) {
      continue;
    }
    step = step === 0 ? difference : greatestCommonDivisor(step, difference);
  }

  if (!Number.isFinite(step) || step < 1) {
    return null;
  }

  const firstNumericColumn = numericColumns.slice().sort((a, b) => a.index - b.index)[0];
  const start = firstNumericColumn.value - firstNumericColumn.index * step;

  if (!Number.isFinite(start)) {
    return null;
  }

  return { start, step, suffix };
}

function sortSizes(sizes) {
  return [...(sizes || [])].sort((first, second) => {
    const sizeOrder = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL'];
    const getSortRank = (size) => {
      const label = normalizeSizeLabel(size?.label);

      if (/^\d+T$/.test(label)) {
        const value = Number(size?.value);
        return { group: 0, rank: Number.parseInt(label, 10), secondary: Number.isFinite(value) ? value : Number.POSITIVE_INFINITY, label };
      }

      const labelIndex = sizeOrder.indexOf(label);
      if (labelIndex !== -1) {
        const value = Number(size?.value);
        return { group: 1, rank: labelIndex, secondary: Number.isFinite(value) ? value : Number.POSITIVE_INFINITY, label };
      }

      const numericLabel = parseNumericSizeLabel(label);
      if (numericLabel !== null) {
        const value = Number(size?.value);
        return { group: 2, rank: numericLabel, secondary: Number.isFinite(value) ? value : Number.POSITIVE_INFINITY, label };
      }

      const value = Number(size?.value);
      if (Number.isFinite(value)) {
        return { group: 3, rank: value, secondary: label, label };
      }

      return { group: 4, rank: Number.POSITIVE_INFINITY, secondary: label, label };
    };

    const firstRank = getSortRank(first);
    const secondRank = getSortRank(second);

    if (firstRank.group !== secondRank.group) {
      return firstRank.group - secondRank.group;
    }

    if (firstRank.rank !== secondRank.rank) {
      return firstRank.rank - secondRank.rank;
    }

    if (firstRank.secondary < secondRank.secondary) return -1;
    if (firstRank.secondary > secondRank.secondary) return 1;

    return firstRank.label.localeCompare(secondRank.label);
  });
}

const GARMENT_LABELS = {
  shirt: ['shirt', 't-shirt', 'tee', 'top', 'blouse'],
  tshirt: ['t-shirt', 'shirt', 'tee', 'top'],
  dress: ['dress', 'gown', 'frock'],
  pants: ['pants', 'trousers', 'jeans', 'slacks', 'leggings'],
  shorts: ['shorts', 'short pants'],
  skirt: ['skirt', 'long skirt', 'mini skirt', 'maxi skirt', 'pleated skirt', 'a-line skirt'],
  jacket: ['jacket', 'coat', 'blazer', 'hoodie', 'cardigan'],
  hoodie: ['hoodie', 'sweatshirt'],
  sweater: ['sweater', 'jumper', 'pullover', 'cardigan'],
  suit: ['suit', 'blazer'],
  coat: ['coat', 'overcoat', 'trench coat'],
  blouse: ['blouse', 'shirt', 'top'],
  romper: ['romper', 'jumpsuit'],
  jumpsuit: ['jumpsuit', 'romper'],
};

const DEFAULT_CLOTHING_SHAPES = {
  shirt: {
    minAreaRatio: 0.05,
    minHeightRatio: 0.18,
    yRange: [0.25, 0.72],
    aspectRange: [0.45, 2.8],
    maxSkinRatio: 0.65,
    targetY: 0.45,
    targetAreaRatio: 0.2,
    cropPadding: { x: 0.12, top: 0.12, bottom: 0.12 },
  },
  dress: {
    minAreaRatio: 0.08,
    minHeightRatio: 0.25,
    yRange: [0.3, 0.9],
    aspectRange: [0.35, 2.2],
    maxSkinRatio: 0.55,
    targetY: 0.6,
    targetAreaRatio: 0.3,
    cropPadding: { x: 0.2, top: 0.22, bottom: 0.55 },
  },
  pants: {
    minAreaRatio: 0.07,
    minHeightRatio: 0.24,
    yRange: [0.42, 0.95],
    aspectRange: [0.25, 1.8],
    maxSkinRatio: 0.5,
    targetY: 0.72,
    targetAreaRatio: 0.26,
    cropPadding: { x: 0.24, top: 0.28, bottom: 0.8 },
  },
  shorts: {
    minAreaRatio: 0.06,
    minHeightRatio: 0.18,
    yRange: [0.4, 0.85],
    aspectRange: [0.35, 2.2],
    maxSkinRatio: 0.56,
    targetY: 0.65,
    targetAreaRatio: 0.2,
    cropPadding: { x: 0.24, top: 0.28, bottom: 0.58 },
  },
  skirt: {
    minAreaRatio: 0.08,
    minHeightRatio: 0.2,
    yRange: [0.48, 0.97],
    aspectRange: [0.3, 2.8],
    maxSkinRatio: 0.42,
    targetY: 0.74,
    targetAreaRatio: 0.24,
    cropPadding: { x: 0.3, top: 0.36, bottom: 1.05 },
  },
  jacket: {
    minAreaRatio: 0.06,
    minHeightRatio: 0.2,
    yRange: [0.24, 0.8],
    aspectRange: [0.35, 2.5],
    maxSkinRatio: 0.6,
    targetY: 0.48,
    targetAreaRatio: 0.24,
    cropPadding: { x: 0.16, top: 0.16, bottom: 0.2 },
  },
};

const CLOTHING_SHAPES_PATH = path.join(__dirname, 'clothing-shapes.json');

function loadClothingShapes() {
  try {
    if (!fs.existsSync(CLOTHING_SHAPES_PATH)) {
      return DEFAULT_CLOTHING_SHAPES;
    }

    const fileContent = fs.readFileSync(CLOTHING_SHAPES_PATH, 'utf8');
    const parsed = JSON.parse(fileContent);
    return {
      ...DEFAULT_CLOTHING_SHAPES,
      ...parsed,
    };
  } catch (error) {
    console.warn('Failed to load clothing-shapes.json, using defaults:', error.message);
    return DEFAULT_CLOTHING_SHAPES;
  }
}

const CLOTHING_SHAPES = loadClothingShapes();

function getClothingShapeProfile(garmentType) {
  return CLOTHING_SHAPES[garmentType] || CLOTHING_SHAPES.shirt || DEFAULT_CLOTHING_SHAPES.shirt;
}

function getCandidateLabelsForGarment(garmentType) {
  return GARMENT_LABELS[garmentType] || GARMENT_LABELS.shirt;
}

function normalizeGarmentType(garmentType) {
  if (!garmentType || typeof garmentType !== 'string') {
    return 'shirt';
  }

  const normalized = garmentType.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(GARMENT_LABELS, normalized) ? normalized : 'shirt';
}

function isSkinTonePixel(red, green, blue, minVotes = 2) {
  const toHsv = (r, g, b) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === rn) {
        hue = ((gn - bn) / delta) % 6;
      } else if (max === gn) {
        hue = (bn - rn) / delta + 2;
      } else {
        hue = (rn - gn) / delta + 4;
      }
      hue *= 60;
      if (hue < 0) hue += 360;
    }

    const saturation = max === 0 ? 0 : delta / max;
    return { hue, saturation, value: max };
  };

  const toYCbCr = (r, g, b) => {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return { y, cb, cr };
  };

  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  const chroma = maxChannel - minChannel;
  const sum = red + green + blue;

  if (sum <= 0 || chroma < 8) return false;

  const { hue, saturation, value } = toHsv(red, green, blue);
  const { y, cb, cr } = toYCbCr(red, green, blue);

  const normalizedR = red / sum;
  const normalizedG = green / sum;

  // Broad normalized-rgb gate to include diverse tones while excluding obvious non-skin hues.
  const normalizedRule =
    normalizedR >= 0.28 && normalizedR <= 0.58 &&
    normalizedG >= 0.18 && normalizedG <= 0.42 &&
    normalizedR > normalizedG;

  // Wide YCbCr region that captures light to dark skin tones better than fixed RGB limits.
  const ycbcrRule =
    y >= 20 && y <= 245 &&
    cb >= 65 && cb <= 148 &&
    cr >= 115 && cr <= 188;

  // HSV safety net for warm hues at different brightness/saturation levels.
  const warmHue = (hue >= 0 && hue <= 58) || (hue >= 330 && hue <= 360);
  const hsvRule = warmHue && saturation >= 0.08 && saturation <= 0.78 && value >= 0.08 && value <= 0.98;

  let votes = 0;
  if (normalizedRule) votes += 1;
  if (ycbcrRule) votes += 1;
  if (hsvRule) votes += 1;

  if (votes >= minVotes) {
    return true;
  }

  // Fallback legacy rule only applies in strict mode.
  if (minVotes < 2) return false;
  if (red < 65 || green < 25 || blue < 10) return false;
  if (Math.abs(red - green) < 10) return false;
  if (red <= green || red <= blue) return false;
  return (maxChannel === 0 ? 0 : chroma / maxChannel) > 0.06;
}

function estimateSkinRatioInBox(rawData, width, height, channels, box) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(box.xmin)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(box.ymin)));
  const right = Math.max(0, Math.min(width - 1, Math.ceil(box.xmax)));
  const bottom = Math.max(0, Math.min(height - 1, Math.ceil(box.ymax)));

  if (right <= left || bottom <= top) {
    return 1;
  }

  const sampleStep = 3;
  let sampledPixels = 0;
  let skinPixels = 0;

  for (let y = top; y <= bottom; y += sampleStep) {
    for (let x = left; x <= right; x += sampleStep) {
      const offset = (y * width + x) * channels;
      const alpha = channels >= 4 ? rawData[offset + 3] : 255;
      if (alpha < 16) continue;

      sampledPixels += 1;
      if (isSkinTonePixel(rawData[offset], rawData[offset + 1], rawData[offset + 2])) {
        skinPixels += 1;
      }
    }
  }

  if (sampledPixels === 0) {
    return 1;
  }

  return skinPixels / sampledPixels;
}

function selectBestGarmentDetection(detections, garmentType, imageWidth, imageHeight, rawData, channels) {
  const maxDistance = Math.max(1, Math.hypot(imageWidth / 2, imageHeight / 2));
  const profile = getClothingShapeProfile(garmentType);
  const [minYRange, maxYRange] = profile.yRange || [0, 1];
  const [minAspect, maxAspect] = profile.aspectRange || [0.2, 3.5];
  const targetY = typeof profile.targetY === 'number' ? profile.targetY : 0.5;
  const targetAreaRatio = typeof profile.targetAreaRatio === 'number' ? profile.targetAreaRatio : 0.2;

  let bestDetection = null;
  let bestScore = -Infinity;
  const debugMode = garmentType === 'skirt';

  if (debugMode) {
    console.log(`\n[DEBUG SKIRT] Analyzing ${detections.length} detections. Profile constraints:`, {
      areaRatio: `${profile.minAreaRatio}`,
      heightRatio: `${profile.minHeightRatio}`,
      yRange: [minYRange, maxYRange],
      aspectRange: [minAspect, maxAspect],
      maxSkinRatio: profile.maxSkinRatio,
    });
  }

  for (const detection of detections) {
    if (!detection?.box) continue;

    const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(detection.box.xmin)));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(detection.box.ymin)));
    const right = Math.max(0, Math.min(imageWidth - 1, Math.ceil(detection.box.xmax)));
    const bottom = Math.max(0, Math.min(imageHeight - 1, Math.ceil(detection.box.ymax)));

    if (right <= left || bottom <= top) continue;

    const boxWidth = right - left + 1;
    const boxHeight = bottom - top + 1;
    const areaRatio = (boxWidth * boxHeight) / (imageWidth * imageHeight);
    const heightRatio = boxHeight / imageHeight;
    const aspectRatio = boxWidth / Math.max(1, boxHeight);
    const centerX = left + boxWidth / 2;
    const centerY = top + boxHeight / 2;
    const centerDistance = Math.hypot(centerX - imageWidth / 2, centerY - imageHeight / 2) / maxDistance;
    const yNormalized = centerY / imageHeight;
    const skinRatio = estimateSkinRatioInBox(rawData, imageWidth, imageHeight, channels, detection.box);

    const failsArea = areaRatio < (profile.minAreaRatio ?? 0.05);
    const failsHeight = heightRatio < (profile.minHeightRatio ?? 0.16);
    const failsYMin = yNormalized < minYRange;
    const failsYMax = yNormalized > maxYRange;
    const failsAspectMin = aspectRatio < minAspect;
    const failsAspectMax = aspectRatio > maxAspect;
    const failsSkin = skinRatio > (profile.maxSkinRatio ?? 0.65);

    const failsShapeRules = failsArea || failsHeight || failsYMin || failsYMax || failsAspectMin || failsAspectMax || failsSkin;

    if (debugMode) {
      const reasons = [];
      if (failsArea) reasons.push(`area ${areaRatio.toFixed(3)} < ${profile.minAreaRatio}`);
      if (failsHeight) reasons.push(`height ${heightRatio.toFixed(3)} < ${profile.minHeightRatio}`);
      if (failsYMin) reasons.push(`yNorm ${yNormalized.toFixed(3)} < ${minYRange}`);
      if (failsYMax) reasons.push(`yNorm ${yNormalized.toFixed(3)} > ${maxYRange}`);
      if (failsAspectMin) reasons.push(`aspect ${aspectRatio.toFixed(3)} < ${minAspect}`);
      if (failsAspectMax) reasons.push(`aspect ${aspectRatio.toFixed(3)} > ${maxAspect}`);
      if (failsSkin) reasons.push(`skin ${skinRatio.toFixed(3)} > ${profile.maxSkinRatio}`);
      console.log(`  Detection: box [${left},${top}:${right},${bottom}] score=${detection.score.toFixed(3)}`, {
        areaRatio: areaRatio.toFixed(4),
        heightRatio: heightRatio.toFixed(4),
        yNormalized: yNormalized.toFixed(4),
        aspectRatio: aspectRatio.toFixed(4),
        skinRatio: skinRatio.toFixed(4),
        passed: !failsShapeRules,
        failedRules: failsShapeRules ? reasons : 'NONE',
      });
    }

    const baseScore = Math.max(0.01, detection.score);
    const areaDistance = Math.abs(areaRatio - targetAreaRatio) / Math.max(0.02, targetAreaRatio);
    const yDistance = Math.abs(yNormalized - targetY);

    if (failsShapeRules) {
      continue;
    }

    const areaWeight = Math.max(0.25, 1.4 - Math.min(1.1, areaDistance));
    const centerWeight = Math.max(0.2, 1 - centerDistance * 0.8);
    const skinWeight = Math.max(0.05, 1 - skinRatio * 0.9);
    const yWeight = Math.max(0.2, 1.35 - Math.min(1.1, yDistance * 2.2));
    const shapeWeight = Math.max(0.2, 1.2 - Math.min(1, Math.abs(aspectRatio - ((minAspect + maxAspect) / 2))));

    const combinedScore = baseScore * areaWeight * centerWeight * skinWeight * yWeight * shapeWeight;

    if (combinedScore > bestScore) {
      bestScore = combinedScore;
      bestDetection = {
        ...detection,
        box: { xmin: left, ymin: top, xmax: right, ymax: bottom },
      };
    }
  }

  if (debugMode) {
    if (bestDetection) {
      console.log(`[DEBUG SKIRT] BEST DETECTION selected: box=${JSON.stringify(bestDetection.box)}, score=${bestScore.toFixed(3)}`);
    } else {
      console.log(`[DEBUG SKIRT] NO VALID DETECTIONS (all rejected by shape rules)`);
    }
  }

  return bestDetection;
}

let garmentDetectorPromise = null;
let backgroundRemoverPromise = null;

async function getGarmentDetector() {
  if (!garmentDetectorPromise) {
    garmentDetectorPromise = pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32', {
      dtype: 'q8',
    });
  }

  return garmentDetectorPromise;
}

async function getBackgroundRemover() {
  if (!backgroundRemoverPromise) {
    backgroundRemoverPromise = pipeline('background-removal', 'Xenova/modnet', {
      dtype: 'q8',
    });
  }

  return backgroundRemoverPromise;
}

async function rawImageFromBuffer(buffer, mimeType) {
  return RawImage.read(new Blob([buffer], { type: mimeType || 'image/png' }));
}

function rawImageToPngBuffer(rawImage) {
  return sharp(Buffer.from(rawImage.data), {
    raw: {
      width: rawImage.width,
      height: rawImage.height,
      channels: rawImage.channels,
    },
  })
    .png()
    .toBuffer();
}

function findAlphaBounds(rawImage) {
  if (!rawImage || rawImage.channels < 4) {
    return null;
  }

  const { data, width, height, channels } = rawImage;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (data[offset + 3] === 0) continue;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getAlphaOpaqueRatio(rawImage) {
  if (!rawImage || rawImage.channels < 4) {
    return 1;
  }

  const { data, width, height, channels } = rawImage;
  const totalPixels = width * height;
  if (totalPixels <= 0) {
    return 1;
  }

  let opaquePixels = 0;
  for (let index = 0; index < totalPixels; index += 1) {
    const alpha = data[index * channels + 3];
    if (alpha > 0) {
      opaquePixels += 1;
    }
  }

  return opaquePixels / totalPixels;
}

function getAlphaBorderOpaqueRatio(rawImage) {
  if (!rawImage || rawImage.channels < 4) {
    return 1;
  }

  const { data, width, height, channels } = rawImage;
  if (width <= 1 || height <= 1) {
    return 1;
  }

  let borderOpaque = 0;
  let borderTotal = 0;

  const sample = (x, y) => {
    const offset = (y * width + x) * channels + 3;
    borderTotal += 1;
    if (data[offset] > 0) {
      borderOpaque += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }

  if (borderTotal === 0) {
    return 1;
  }

  return borderOpaque / borderTotal;
}

function withCutoutOffset(cutoutResult, offsetX, offsetY) {
  if (!cutoutResult || !cutoutResult.cutout) {
    return cutoutResult;
  }

  return {
    ...cutoutResult,
    cutout: {
      ...cutoutResult.cutout,
      offsetX: (cutoutResult.cutout.offsetX || 0) + offsetX,
      offsetY: (cutoutResult.cutout.offsetY || 0) + offsetY,
    },
  };
}

function refineCutoutMask(rawImage, garmentType = 'shirt') {
  if (!rawImage || rawImage.channels < 4) {
    return { image: rawImage, bounds: findAlphaBounds(rawImage) };
  }

  const width = rawImage.width;
  const height = rawImage.height;
  const channels = rawImage.channels;
  const source = rawImage.data;
  const data = new Uint8ClampedArray(source.length);
  data.set(source);

  // Keep low-confidence interior pixels for darker fabrics while removing haze.
  const alphaThreshold = 40;
  for (let i = 3; i < data.length; i += channels) {
    if (data[i] < alphaThreshold) {
      data[i] = 0;
    }
  }

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      if (data[offset + 3] > 0) {
        mask[index] = 1;
      }
    }
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const selectMainComponent = (sourceMask, focusX, focusY) => {
    const visited = new Uint8Array(width * height);
    const maxDistance = Math.max(1, Math.hypot(width / 2, height / 2));
    const queue = [];
    let queueHead = 0;
    let selectedPixels = null;
    let selectedScore = -Infinity;

    for (let start = 0; start < sourceMask.length; start += 1) {
      if (!sourceMask[start] || visited[start]) continue;

      visited[start] = 1;
      queue.length = 0;
      queueHead = 0;
      queue.push(start);

      const componentPixels = [];
      let area = 0;
      let sumX = 0;
      let sumY = 0;

      while (queueHead < queue.length) {
        const current = queue[queueHead++];
        componentPixels.push(current);
        area += 1;

        const x = current % width;
        const y = Math.floor(current / width);
        sumX += x;
        sumY += y;

        const neighbors = [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIndex = ny * width + nx;
          if (!sourceMask[nIndex] || visited[nIndex]) continue;
          visited[nIndex] = 1;
          queue.push(nIndex);
        }
      }

      const centroidX = sumX / area;
      const centroidY = sumY / area;
      const distance = Math.hypot(centroidX - focusX, centroidY - focusY) / maxDistance;
      const score = area * (1 - Math.min(0.9, distance));

      if (score > selectedScore) {
        selectedScore = score;
        selectedPixels = componentPixels;
      }
    }

    const keepMask = new Uint8Array(width * height);
    if (selectedPixels) {
      for (const pixelIndex of selectedPixels) {
        keepMask[pixelIndex] = 1;
      }
    }

    return keepMask;
  };

  const lowerBodyGarments = new Set(['skirt', 'pants', 'shorts']);
  const preserveBottomEdge = lowerBodyGarments.has(garmentType);
  const skipLowerBand = preserveBottomEdge;

  const countOpaquePixels = () => {
    let count = 0;
    for (let i = 3; i < data.length; i += channels) {
      if (data[i] > 0) {
        count += 1;
      }
    }
    return count;
  };

  let previousOpaquePixels = -1;
  const maxCleanupPasses = 5;

  for (let cleanupPass = 0; cleanupPass < maxCleanupPasses; cleanupPass += 1) {
    const passMask = new Uint8Array(width * height);
    let passOpaquePixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] > 0) {
          passMask[index] = 1;
          passOpaquePixels += 1;
        }
      }
    }

    if (passOpaquePixels === 0) {
      break;
    }

    const keepMask = selectMainComponent(passMask, centerX, centerY);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (keepMask[index]) continue;
        const offset = index * channels;
        data[offset + 3] = 0;
      }
    }

    const skinMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!keepMask[index]) continue;

        const offset = index * channels;
        if (data[offset + 3] === 0) continue;
        const bottomProtectionStart = skipLowerBand ? 0.96 : 1;
        if (skipLowerBand && y > Math.round(height * bottomProtectionStart)) continue;

        if (isSkinTonePixel(data[offset], data[offset + 1], data[offset + 2])) {
          skinMask[index] = 1;
        }
      }
    }

    const expansionPasses = 5;
    for (let pass = 0; pass < expansionPasses; pass += 1) {
      const expanded = new Uint8Array(width * height);

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (!skinMask[index]) continue;

          expanded[index] = 1;
          if (x > 0) expanded[index - 1] = 1;
          if (x < width - 1) expanded[index + 1] = 1;
          if (y > 0) expanded[index - width] = 1;
          if (y < height - 1) expanded[index + width] = 1;
          if (x > 0 && y > 0) expanded[index - width - 1] = 1;
          if (x < width - 1 && y > 0) expanded[index - width + 1] = 1;
          if (x > 0 && y < height - 1) expanded[index + width - 1] = 1;
          if (x < width - 1 && y < height - 1) expanded[index + width + 1] = 1;
        }
      }

      skinMask.set(expanded);
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!skinMask[index]) continue;
        const offset = index * channels;
        data[offset + 3] = 0;
      }
    }

    // Edge-adjacent loose propagation: pixels that touch confirmed-skin-removed areas
    // get a single-vote check so gradients and transition pixels are fully erased.
    const edgeSkinMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] === 0) continue;
        if (skipLowerBand && y > Math.round(height * 0.96)) continue;

        const adjacentToSkin =
          (y > 0 && skinMask[index - width]) ||
          (y < height - 1 && skinMask[index + width]) ||
          (x > 0 && skinMask[index - 1]) ||
          (x < width - 1 && skinMask[index + 1]) ||
          (x > 0 && y > 0 && skinMask[index - width - 1]) ||
          (x < width - 1 && y > 0 && skinMask[index - width + 1]) ||
          (x > 0 && y < height - 1 && skinMask[index + width - 1]) ||
          (x < width - 1 && y < height - 1 && skinMask[index + width + 1]);

        if (!adjacentToSkin) continue;

        if (isSkinTonePixel(data[offset], data[offset + 1], data[offset + 2], 1)) {
          edgeSkinMask[index] = 1;
        }
      }
    }
    for (let ep = 0; ep < 2; ep += 1) {
      const edgeExpanded = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (!edgeSkinMask[index]) continue;
          edgeExpanded[index] = 1;
          if (x > 0) edgeExpanded[index - 1] = 1;
          if (x < width - 1) edgeExpanded[index + 1] = 1;
          if (y > 0) edgeExpanded[index - width] = 1;
          if (y < height - 1) edgeExpanded[index + width] = 1;
        }
      }
      edgeSkinMask.set(edgeExpanded);
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!edgeSkinMask[index]) continue;
        const offset = index * channels;
        data[offset + 3] = 0;
      }
    }

    const secondPassAlphaThreshold = Math.min(120, 64 + cleanupPass * 6);
    const secondSeedMask = new Uint8Array(width * height);
    const secondCandidateMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] > 0) {
          secondCandidateMask[index] = 1;
          if (data[offset + 3] >= secondPassAlphaThreshold) {
            secondSeedMask[index] = 1;
          }
        }
      }
    }

    const secondKeepSeeds = selectMainComponent(secondSeedMask, centerX, centerY);
    const secondKeepMask = new Uint8Array(width * height);
    const secondQueue = [];
    let secondQueueHead = 0;

    const enqueueSecondKeep = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (!secondCandidateMask[index] || secondKeepMask[index]) return;
      secondKeepMask[index] = 1;
      secondQueue.push(index);
    };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!secondKeepSeeds[index]) continue;
        enqueueSecondKeep(x, y);
      }
    }

    while (secondQueueHead < secondQueue.length) {
      const current = secondQueue[secondQueueHead++];
      const x = current % width;
      const y = Math.floor(current / width);

      enqueueSecondKeep(x + 1, y);
      enqueueSecondKeep(x - 1, y);
      enqueueSecondKeep(x, y + 1);
      enqueueSecondKeep(x, y - 1);
    }

    // If no strong seeds are present (common on very dark garments), keep the main
    // component from all nonzero-alpha pixels instead of erasing to an outline.
    if (secondQueue.length === 0) {
      const fallbackKeepMask = selectMainComponent(secondCandidateMask, centerX, centerY);
      secondKeepMask.set(fallbackKeepMask);
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (secondKeepMask[index]) continue;
        const offset = index * channels;
        data[offset + 3] = 0;
      }
    }

    const borderConnected = new Uint8Array(width * height);
    const queue = [];
    let queueHead = 0;

    const enqueueBorderConnected = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (borderConnected[index]) return;
      const offset = index * channels;
      if (data[offset + 3] === 0) return;

      borderConnected[index] = 1;
      queue.push(index);
    };

    for (let x = 0; x < width; x += 1) {
      enqueueBorderConnected(x, 0);
      if (!preserveBottomEdge) {
        enqueueBorderConnected(x, height - 1);
      }
    }
    for (let y = 0; y < height; y += 1) {
      enqueueBorderConnected(0, y);
      enqueueBorderConnected(width - 1, y);
    }

    while (queueHead < queue.length) {
      const current = queue[queueHead++];
      const x = current % width;
      const y = Math.floor(current / width);

      enqueueBorderConnected(x + 1, y);
      enqueueBorderConnected(x - 1, y);
      enqueueBorderConnected(x, y + 1);
      enqueueBorderConnected(x, y - 1);
    }

    let opaqueBeforeBorderClean = 0;
    let borderConnectedCount = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] > 0) {
          opaqueBeforeBorderClean += 1;
          if (borderConnected[index]) {
            borderConnectedCount += 1;
          }
        }
      }
    }

    // If most of the foreground touches borders, this is likely the garment itself.
    // In that case, skip border purging to avoid chopping sleeves/hems.
    const borderConnectedRatio = opaqueBeforeBorderClean > 0
      ? borderConnectedCount / opaqueBeforeBorderClean
      : 0;
    const shouldApplyBorderClean = borderConnectedRatio <= 0.55;

    const borderCleanMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * channels;
        if (data[offset + 3] === 0 || (shouldApplyBorderClean && borderConnected[index])) {
          data[offset + 3] = 0;
          continue;
        }
        borderCleanMask[index] = 1;
      }
    }

    const finalKeepMask = selectMainComponent(borderCleanMask, centerX, centerY);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (finalKeepMask[index]) continue;
        const offset = index * channels;
        data[offset + 3] = 0;
      }
    }

    const opaquePixels = countOpaquePixels();
    if (opaquePixels === 0 || opaquePixels === previousOpaquePixels) {
      break;
    }
    previousOpaquePixels = opaquePixels;
  }

  const finalMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      if (data[offset + 3] > 0) {
        finalMask[index] = 1;
      }
    }
  }

  const finalMainMask = selectMainComponent(finalMask, centerX, centerY);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (finalMainMask[index]) continue;
      const offset = index * channels;
      data[offset + 3] = 0;
    }
  }

  // Remove residual body regions that survive matte cleanup: we remove only
  // skin-dominant components that are mostly in upper regions.
  const remainingMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      if (data[offset + 3] > 0) {
        remainingMask[index] = 1;
      }
    }
  }

  const visitedResidual = new Uint8Array(width * height);
  const queueResidual = [];
  let queueResidualHead = 0;
  const upperRegionMaxY = Math.round(height * 0.8);

  for (let start = 0; start < remainingMask.length; start += 1) {
    if (!remainingMask[start] || visitedResidual[start]) continue;

    visitedResidual[start] = 1;
    queueResidual.length = 0;
    queueResidualHead = 0;
    queueResidual.push(start);

    const componentPixels = [];
    let skinPixels = 0;
    let minY = height;
    let maxY = -1;

    while (queueResidualHead < queueResidual.length) {
      const current = queueResidual[queueResidualHead++];
      const x = current % width;
      const y = Math.floor(current / width);
      const offset = current * channels;

      componentPixels.push(current);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (isSkinTonePixel(data[offset], data[offset + 1], data[offset + 2], 1)) {
        skinPixels += 1;
      }

      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIndex = ny * width + nx;
        if (!remainingMask[nIndex] || visitedResidual[nIndex]) continue;
        visitedResidual[nIndex] = 1;
        queueResidual.push(nIndex);
      }
    }

    const area = componentPixels.length;
    if (area === 0) continue;
    const skinRatio = skinPixels / area;
    const mostlyUpperRegion = maxY <= upperRegionMaxY;
    const smallToMedium = area <= Math.round(width * height * 0.35);

    if (mostlyUpperRegion && smallToMedium && skinRatio >= 0.28) {
      for (const pixelIndex of componentPixels) {
        data[pixelIndex * channels + 3] = 0;
      }
    }
  }

  const refined = new RawImage(data, width, height, 4);
  return {
    image: refined,
    bounds: findAlphaBounds(refined),
  };
}

async function createGarmentCutout(buffer, garmentType = 'shirt', mimeType = '') {
  const normalizedGarmentType = normalizeGarmentType(garmentType);
  const orientedBuffer = await sharp(buffer).rotate().png().toBuffer();
  let cutoutBuffer;

  try {
    cutoutBuffer = await removeBackgroundWithSilentWorker(orientedBuffer);
  } catch (workerError) {
    console.warn('Background removal worker failed, falling back to in-process execution:', workerError.message);

    const orientedPngBlob = new Blob([orientedBuffer], { type: 'image/png' });
    const removeBackground = getRemoveBackground();
    const outputBlob = await removeBackground(orientedPngBlob, {
      model: 'medium',
      output: {
        quality: 0.8,
        format: 'image/png',
        type: 'foreground',
      },
    });

    const outputArrayBuffer = await outputBlob.arrayBuffer();
    cutoutBuffer = Buffer.from(outputArrayBuffer);
  }

  let finalBuffer = cutoutBuffer;
  let cutoutInfo = await sharp(cutoutBuffer).metadata();
  let offsetX = 0;
  let offsetY = 0;

  try {
    const refinedResult = await refineGarmentCutoutWithSharp(cutoutBuffer, normalizedGarmentType);
    if (refinedResult?.buffer) {
      finalBuffer = refinedResult.buffer;
      cutoutInfo = await sharp(finalBuffer).metadata();
      offsetX = refinedResult.offsetX || 0;
      offsetY = refinedResult.offsetY || 0;
    }
  } catch (error) {
    console.warn('Sharp cutout refinement failed, using raw background-removal output:', error.message);

    const canRefineWithRawImage = typeof RawImage !== 'undefined';
    if (canRefineWithRawImage) {
      try {
        const cutoutRawImage = await rawImageFromBuffer(cutoutBuffer, 'image/png');
        const refined = refineCutoutMask(cutoutRawImage, normalizedGarmentType);

        if (refined?.image) {
          finalBuffer = await rawImageToPngBuffer(refined.image);
          cutoutInfo = await sharp(finalBuffer).metadata();
        }
      } catch (rawRefineError) {
        console.warn('RawImage refinement fallback failed:', rawRefineError.message);
      }
    } else if (!loggedRawImageUnavailable) {
      console.warn('RawImage is unavailable; no secondary refinement pass will run.');
      loggedRawImageUnavailable = true;
    }
  }

  return {
    pngDataUrl: `data:image/png;base64,${finalBuffer.toString('base64')}`,
    cutout: {
      width: cutoutInfo.width || 0,
      height: cutoutInfo.height || 0,
      offsetX,
      offsetY,
    },
  };
}

async function refineGarmentCutoutWithSharp(cutoutBuffer, garmentType = 'shirt') {
  const { data, info } = await sharp(cutoutBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width || 0;
  const height = info.height || 0;
  const channels = info.channels || 4;
  if (width < 2 || height < 2 || channels < 4) {
    return {
      buffer: cutoutBuffer,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const mask = new Uint8Array(width * height);
  const alphaThreshold = 20;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      const alpha = data[offset + 3];
      if (alpha <= alphaThreshold) continue;

      mask[index] = 1;
    }
  }

  const visited = new Uint8Array(width * height);
  const queue = [];
  let queueHead = 0;

  const components = [];
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.max(1, Math.hypot(centerX, centerY));
  const profile = getClothingShapeProfile(normalizeGarmentType(garmentType));
  const preferredY = Number.isFinite(profile?.targetY) ? profile.targetY : 0.55;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    queue.length = 0;
    queueHead = 0;
    queue.push(start);
    visited[start] = 1;

    const componentPixels = [];
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let touchesBorder = false;

    while (queueHead < queue.length) {
      const current = queue[queueHead++];
      const x = current % width;
      const y = Math.floor(current / width);

      componentPixels.push(current);
      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }

      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area === 0) {
      continue;
    }

    const centroidX = sumX / area;
    const centroidY = sumY / area;
    components.push({
      pixels: componentPixels,
      area,
      centroidX,
      centroidY,
      minX,
      minY,
      maxX,
      maxY,
      touchesBorder,
    });
  }

  components.sort((first, second) => second.area - first.area);
  let bestPixels = [];

  if (components.length > 0) {
    const largest = components[0];
    const secondLargestArea = components[1]?.area || 0;

    // When one component dominates area, trust it over positional heuristics.
    if (largest.area >= Math.max(1, secondLargestArea * 1.35)) {
      bestPixels = largest.pixels;
    } else {
      let bestScore = -Infinity;
      for (const component of components) {
        const centerDistance = Math.hypot(component.centroidX - centerX, component.centroidY - centerY) / maxDistance;
        const centerFactor = 1 - Math.min(0.7, centerDistance * 0.45);
        const yNorm = component.centroidY / Math.max(1, height - 1);
        const verticalFactor = 1 - Math.min(0.45, Math.abs(yNorm - preferredY));
        const borderFactor = component.touchesBorder ? 0.9 : 1;
        const score = component.area * centerFactor * verticalFactor * borderFactor;
        if (score > bestScore) {
          bestScore = score;
          bestPixels = component.pixels;
        }
      }
    }
  }

  if (!bestPixels.length) {
    return {
      buffer: cutoutBuffer,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const keepMask = new Uint8Array(width * height);
  for (const pixelIndex of bestPixels) {
    keepMask[pixelIndex] = 1;
  }

  // Light morphological close to reduce pinholes and zipper artifacts on silhouettes.
  const closedMask = new Uint8Array(keepMask);
  for (let pass = 0; pass < 1; pass += 1) {
    const dilated = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!closedMask[index]) continue;
        dilated[index] = 1;
        if (x > 0) dilated[index - 1] = 1;
        if (x < width - 1) dilated[index + 1] = 1;
        if (y > 0) dilated[index - width] = 1;
        if (y < height - 1) dilated[index + width] = 1;
      }
    }

    const eroded = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (
          dilated[index] &&
          dilated[index - 1] &&
          dilated[index + 1] &&
          dilated[index - width] &&
          dilated[index + width]
        ) {
          eroded[index] = 1;
        }
      }
    }

    closedMask.set(eroded);
  }

  // Opening removes skinny protrusions that often come from bright backdrop bleed.
  const openedMask = new Uint8Array(closedMask);
  for (let pass = 0; pass < 1; pass += 1) {
    const eroded = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (
          openedMask[index] &&
          openedMask[index - 1] &&
          openedMask[index + 1] &&
          openedMask[index - width] &&
          openedMask[index + width]
        ) {
          eroded[index] = 1;
        }
      }
    }

    const dilated = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!eroded[index]) continue;
        dilated[index] = 1;
        if (x > 0) dilated[index - 1] = 1;
        if (x < width - 1) dilated[index + 1] = 1;
        if (y > 0) dilated[index - width] = 1;
        if (y < height - 1) dilated[index + width] = 1;
      }
    }

    openedMask.set(dilated);
  }

  const outputRaw = Buffer.from(data);
  const trimmedMask = new Uint8Array(openedMask);

  // Trim bright low-saturation spill on the silhouette boundary.
  for (let pass = 0; pass < 2; pass += 1) {
    const nextMask = new Uint8Array(trimmedMask);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (!trimmedMask[index]) continue;

        const neighborLeft = trimmedMask[index - 1];
        const neighborRight = trimmedMask[index + 1];
        const neighborUp = trimmedMask[index - width];
        const neighborDown = trimmedMask[index + width];
        const boundaryLike = !neighborLeft || !neighborRight || !neighborUp || !neighborDown;
        if (!boundaryLike) continue;

        let neighbors = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            if (trimmedMask[(y + oy) * width + (x + ox)]) neighbors += 1;
          }
        }

        const offset = index * channels;
        const red = outputRaw[offset];
        const green = outputRaw[offset + 1];
        const blue = outputRaw[offset + 2];
        const alpha = outputRaw[offset + 3];
        const maxChannel = Math.max(red, green, blue);
        const minChannel = Math.min(red, green, blue);
        const saturation = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
        const brightness = maxChannel / 255;
        const likelyBackgroundSpill = brightness >= 0.9 && saturation <= 0.12;

        if (likelyBackgroundSpill && (alpha < 170 || neighbors <= 4)) {
          nextMask[index] = 0;
        }
      }
    }

    trimmedMask.set(nextMask);
  }

  let openedCount = 0;
  let trimmedCount = 0;
  for (let index = 0; index < openedMask.length; index += 1) {
    if (openedMask[index]) openedCount += 1;
    if (trimmedMask[index]) trimmedCount += 1;
  }

  // Safety fallback: if aggressive spill trimming removes too much cloth, keep opened mask.
  if (trimmedCount < Math.max(64, Math.round(openedCount * 0.52))) {
    trimmedMask.set(openedMask);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;

      if (!trimmedMask[index]) {
        outputRaw[offset + 3] = 0;
        continue;
      }

      outputRaw[offset + 3] = Math.max(outputRaw[offset + 3], 192);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      buffer: cutoutBuffer,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const cropProfile = getClothingShapeProfile(normalizeGarmentType(garmentType));
  const cropPadding = cropProfile?.cropPadding || { x: 0.18, top: 0.2, bottom: 0.24 };
  const boundsWidth = maxX - minX + 1;
  const boundsHeight = maxY - minY + 1;
  const padX = Math.max(4, Math.round(boundsWidth * (cropPadding.x || 0.18)));
  const padTop = Math.max(4, Math.round(boundsHeight * (cropPadding.top || 0.2)));
  const padBottom = Math.max(4, Math.round(boundsHeight * (cropPadding.bottom || 0.24)));

  const safeLeft = Math.max(0, minX - padX);
  const safeTop = Math.max(0, minY - padTop);
  const safeRight = Math.min(width - 1, maxX + padX);
  const safeBottom = Math.min(height - 1, maxY + padBottom);

  const safeWidth = Math.max(1, safeRight - safeLeft + 1);
  const safeHeight = Math.max(1, safeBottom - safeTop + 1);

  const refinedBuffer = await sharp(outputRaw, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .extract({
      left: safeLeft,
      top: safeTop,
      width: safeWidth,
      height: safeHeight,
    })
    .extend({ top: 2, bottom: 2, left: 2, right: 2, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  return {
    buffer: refinedBuffer,
    offsetX: safeLeft,
    offsetY: safeTop,
  };
}

function isValidTriMeshModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (!Array.isArray(model.positions) || model.positions.length < 9 || model.positions.length % 3 !== 0) return false;
  if (!Array.isArray(model.indices) || model.indices.length < 3 || model.indices.length % 3 !== 0) return false;
  if (!Array.isArray(model.uvs) || model.uvs.length < 6 || model.uvs.length % 2 !== 0) return false;
  return true;
}

function normalizeServiceGarmentModel(model, fallbackTextureDataUrl = null) {
  if (!model || typeof model !== 'object') return null;

  if (model.format === 'tri-mesh' && isValidTriMeshModel(model)) {
    return {
      framework: model.framework || 'xcloth',
      format: 'tri-mesh',
      positions: model.positions,
      uvs: model.uvs,
      indices: model.indices,
      textureDataUrl: model.textureDataUrl || fallbackTextureDataUrl || null,
      resolution: model.resolution || null,
    };
  }

  if (typeof model.glbBase64 === 'string' && model.glbBase64.length > 0) {
    return {
      framework: model.framework || 'xcloth',
      format: 'glb-base64',
      glbDataUrl: `data:model/gltf-binary;base64,${model.glbBase64}`,
      textureDataUrl: fallbackTextureDataUrl || null,
    };
  }

  return null;
}

async function inferGarment3DWithXClothService(inputBuffer, garmentType, mimeType, cutoutDataUrl = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, XCLOTH_TIMEOUT_MS));

  try {
    const form = new FormData();
    form.append('image', new Blob([inputBuffer], { type: mimeType || 'image/png' }), 'garment.png');
    form.append('garmentType', normalizeGarmentType(garmentType || 'shirt'));
    if (cutoutDataUrl) {
      form.append('cutoutDataUrl', cutoutDataUrl);
    }

    const response = await fetch(XCLOTH_INFER_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => 'Unknown xCloth service error');
      throw new Error(`xCloth service returned HTTP ${response.status}: ${details.slice(0, 300)}`);
    }

    const payload = await response.json();
    const normalized = normalizeServiceGarmentModel(payload?.garmentModel || payload?.model || payload, cutoutDataUrl);

    if (!normalized) {
      throw new Error('xCloth service response did not include a valid garment model payload.');
    }

    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

async function createApproxGarment3DModelFromCutout(buffer, garmentType = 'shirt', mimeType = '', existingCutoutResult = null) {
  const cutoutResult = existingCutoutResult || await createGarmentCutout(buffer, garmentType, mimeType);
  const cutoutDataUrl = cutoutResult?.pngDataUrl || null;

  if (!cutoutDataUrl || !cutoutDataUrl.startsWith('data:image/png;base64,')) {
    return {
      ...cutoutResult,
      garmentModel: null,
    };
  }

  const cutoutBuffer = Buffer.from(cutoutDataUrl.split(',')[1], 'base64');
  const { data, info } = await sharp(cutoutBuffer)
    // Higher mesh source resolution reduces jagged silhouettes and missing hems.
    .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width || 0;
  const height = info.height || 0;
  const channels = info.channels || 4;
  const pixelCount = width * height;

  if (pixelCount <= 0) {
    return {
      ...cutoutResult,
      garmentModel: null,
    };
  }

  const mask = new Uint8Array(pixelCount);
  const distance = new Float32Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;
  let foregroundCount = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const alpha = data[index * channels + 3];
    const offset = index * channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const saturation = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
    const brightness = maxChannel / 255;
    const lowConfidenceWhiteFringe = alpha < 136 && brightness >= 0.9 && saturation <= 0.11;

    if (alpha > 56 && !lowConfidenceWhiteFringe) {
      mask[index] = 1;
      distance[index] = Number.POSITIVE_INFINITY;
      foregroundCount += 1;
    } else {
      distance[index] = 0;
      queue[queueEnd++] = index;
    }
  }

  if (foregroundCount < 24) {
    return {
      ...cutoutResult,
      garmentModel: null,
    };
  }

  // Multi-source distance transform from background to approximate layered depth.
  while (queueStart < queueEnd) {
    const current = queue[queueStart++];
    const cx = current % width;
    const cy = Math.floor(current / width);
    const nextDistance = distance[current] + 1;

    if (cx > 0) {
      const left = current - 1;
      if (nextDistance < distance[left]) {
        distance[left] = nextDistance;
        queue[queueEnd++] = left;
      }
    }
    if (cx < width - 1) {
      const right = current + 1;
      if (nextDistance < distance[right]) {
        distance[right] = nextDistance;
        queue[queueEnd++] = right;
      }
    }
    if (cy > 0) {
      const up = current - width;
      if (nextDistance < distance[up]) {
        distance[up] = nextDistance;
        queue[queueEnd++] = up;
      }
    }
    if (cy < height - 1) {
      const down = current + width;
      if (nextDistance < distance[down]) {
        distance[down] = nextDistance;
        queue[queueEnd++] = down;
      }
    }
  }

  let maxDistance = 1;
  for (let index = 0; index < pixelCount; index += 1) {
    if (!mask[index]) continue;
    if (Number.isFinite(distance[index]) && distance[index] > maxDistance) {
      maxDistance = distance[index];
    }
  }

  // Denoise sparse alpha fragments to avoid zipper-like mesh artifacts.
  const cleanedMask = new Uint8Array(mask);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;

      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          if (mask[(y + oy) * width + (x + ox)]) neighbors += 1;
        }
      }
      if (neighbors <= 1) {
        cleanedMask[index] = 0;
      }
    }
  }

  const frontVertexMap = new Int32Array(pixelCount).fill(-1);
  const backVertexMap = new Int32Array(pixelCount).fill(-1);
  const boundaryMask = new Uint8Array(pixelCount);
  const positions = [];
  const uvs = [];
  const indices = [];
  const panelIds = [];
  const surfaceSides = [];
  const pinnedVertices = [];
  const stitchPairs = [];
  const selfCollisionPairs = [];
  const stitchPairKeys = new Set();

  const aspect = width / Math.max(1, height);
  const scaleY = 1.35;
  const scaleX = scaleY * aspect;

  const seamBucketCount = 6;
  const seamDepth = 0.007;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!cleanedMask[index]) continue;

      const isBoundary =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !cleanedMask[index - 1] ||
        !cleanedMask[index + 1] ||
        !cleanedMask[index - width] ||
        !cleanedMask[index + width];

      if (isBoundary) {
        boundaryMask[index] = 1;
      }
    }
  }

  const addStitchPair = (first, second) => {
    if (first < 0 || second < 0) return;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    const key = `${min}:${max}`;
    if (stitchPairKeys.has(key)) return;
    stitchPairKeys.add(key);
    stitchPairs.push(first, second);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!cleanedMask[index]) continue;

      const offset = index * channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

      const distanceNorm = Math.min(1, (distance[index] || 0) / Math.max(1, maxDistance));
      const wrinkle = (0.5 - luminance) * 0.02;

      // Seam/panel effect: piecewise panel depth with a soft seam ridge between panels.
      const panelU = x / Math.max(1, width - 1);
      const panelIndex = Math.min(seamBucketCount - 1, Math.floor(panelU * seamBucketCount));
      const panelCenter = (panelIndex + 0.5) / seamBucketCount;
      const seamDistance = Math.abs(panelU - panelCenter) * seamBucketCount;
      const seamRidge = Math.max(0, 1 - seamDistance * 1.8) * seamDepth;

      // Slight drape sag towards the lower body to mimic cloth hanging.
      const v = y / Math.max(1, height - 1);
      const drapeSag = Math.pow(v, 1.8) * 0.018;

      const frontZ = 0.02 + distanceNorm * 0.075 + wrinkle + seamRidge - drapeSag;
      const backZ = -0.02 - distanceNorm * 0.048 + wrinkle * 0.35 + seamRidge * 0.4 - drapeSag * 0.7;

      const xNorm = (x / Math.max(1, width - 1) - 0.5) * 2;
      const yNorm = (0.5 - y / Math.max(1, height - 1)) * 2;
      const px = xNorm * scaleX;
      const py = yNorm * scaleY + 1.1;

      const frontIndex = positions.length / 3;
      positions.push(px, py, frontZ);
      uvs.push(x / Math.max(1, width - 1), 1 - y / Math.max(1, height - 1));
      frontVertexMap[index] = frontIndex;
      panelIds.push(panelIndex);
      surfaceSides.push(0);
      pinnedVertices.push(y <= Math.max(2, Math.round(height * 0.06)) || (boundaryMask[index] && y <= Math.round(height * 0.14)));

      const backIndex = positions.length / 3;
      positions.push(px, py, backZ);
      uvs.push(1 - (x / Math.max(1, width - 1)), 1 - y / Math.max(1, height - 1));
      backVertexMap[index] = backIndex;
      panelIds.push(panelIndex + seamBucketCount);
      surfaceSides.push(1);
      pinnedVertices.push(y <= Math.max(2, Math.round(height * 0.06)) || (boundaryMask[index] && y <= Math.round(height * 0.14)));

      selfCollisionPairs.push(frontIndex, backIndex);

      if (boundaryMask[index]) {
        addStitchPair(frontIndex, backIndex);
      }
    }
  }

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i00 = y * width + x;
      const i10 = i00 + 1;
      const i01 = i00 + width;
      const i11 = i01 + 1;

      const f00 = frontVertexMap[i00];
      const f10 = frontVertexMap[i10];
      const f01 = frontVertexMap[i01];
      const f11 = frontVertexMap[i11];

      if (f00 >= 0 && f10 >= 0 && f01 >= 0) {
        indices.push(f00, f10, f01);
      }
      if (f10 >= 0 && f11 >= 0 && f01 >= 0) {
        indices.push(f10, f11, f01);
      }

      const b00 = backVertexMap[i00];
      const b10 = backVertexMap[i10];
      const b01 = backVertexMap[i01];
      const b11 = backVertexMap[i11];

      if (b00 >= 0 && b01 >= 0 && b10 >= 0) {
        indices.push(b00, b01, b10);
      }
      if (b10 >= 0 && b01 >= 0 && b11 >= 0) {
        indices.push(b10, b01, b11);
      }

      if (cleanedMask[i00] && cleanedMask[i10] && (boundaryMask[i00] || boundaryMask[i10])) {
        const f0 = frontVertexMap[i00];
        const f1 = frontVertexMap[i10];
        const b0 = backVertexMap[i00];
        const b1 = backVertexMap[i10];
        if (f0 >= 0 && f1 >= 0 && b0 >= 0 && b1 >= 0) {
          indices.push(f0, f1, b1);
          indices.push(f0, b1, b0);
          addStitchPair(f0, b0);
          addStitchPair(f1, b1);
        }
      }

      if (cleanedMask[i00] && cleanedMask[i01] && (boundaryMask[i00] || boundaryMask[i01])) {
        const f0 = frontVertexMap[i00];
        const f1 = frontVertexMap[i01];
        const b0 = backVertexMap[i00];
        const b1 = backVertexMap[i01];
        if (f0 >= 0 && f1 >= 0 && b0 >= 0 && b1 >= 0) {
          indices.push(f0, b1, f1);
          indices.push(f0, b0, b1);
          addStitchPair(f0, b0);
          addStitchPair(f1, b1);
        }
      }
    }
  }

  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount > 0 && indices.length >= 3) {
    const adjacency = Array.from({ length: vertexCount }, () => new Set());
    for (let tri = 0; tri < indices.length; tri += 3) {
      const first = indices[tri];
      const second = indices[tri + 1];
      const third = indices[tri + 2];

      adjacency[first].add(second);
      adjacency[first].add(third);
      adjacency[second].add(first);
      adjacency[second].add(third);
      adjacency[third].add(first);
      adjacency[third].add(second);
    }

    const smoothIterations = 2;
    const smoothAlpha = 0.18;
    for (let iteration = 0; iteration < smoothIterations; iteration += 1) {
      const next = positions.slice();
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        if (pinnedVertices[vertex]) continue;

        const neighbors = adjacency[vertex];
        if (!neighbors || neighbors.size === 0) continue;

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const neighbor of neighbors) {
          sumX += positions[neighbor * 3];
          sumY += positions[neighbor * 3 + 1];
          sumZ += positions[neighbor * 3 + 2];
        }

        const base = vertex * 3;
        const invCount = 1 / neighbors.size;
        const avgX = sumX * invCount;
        const avgY = sumY * invCount;
        const avgZ = sumZ * invCount;

        next[base] = positions[base] * (1 - smoothAlpha) + avgX * smoothAlpha;
        next[base + 1] = positions[base + 1] * (1 - smoothAlpha) + avgY * smoothAlpha;
        next[base + 2] = positions[base + 2] * (1 - smoothAlpha) + avgZ * smoothAlpha;
      }

      for (let index = 0; index < positions.length; index += 1) {
        positions[index] = next[index];
      }
    }
  }

  const garmentModel = {
    framework: 'xcloth-fallback',
    format: 'tri-mesh',
    positions,
    uvs,
    indices,
    panelIds,
    surfaceSides,
    pinnedVertices,
    stitchPairs,
    selfCollisionPairs,
    textureDataUrl: cutoutDataUrl,
    seamPanelCount: seamBucketCount,
    frontPanelCount: seamBucketCount,
    backPanelCount: seamBucketCount,
    resolution: {
      width,
      height,
    },
  };

  return {
    ...cutoutResult,
    garmentModel,
  };
}

async function createGarment3DModel(buffer, garmentType = 'shirt', mimeType = '') {
  let cutoutResult;
  try {
    cutoutResult = await createGarmentCutout(buffer, garmentType, mimeType);
  } catch (error) {
    console.warn('Primary background-removal cutout failed, trying heuristic cutout:', error.message);
    try {
      cutoutResult = await createHeuristicGarmentCutout(buffer);
    } catch (heuristicError) {
      console.warn('Heuristic cutout failed, trying color-key cutout:', heuristicError.message);
      cutoutResult = await createColorKeyCutout(buffer);
    }
  }

  try {
    const sourceMeta = await sharp(buffer).rotate().metadata();
    const sourceWidth = Number(sourceMeta?.width) || 0;
    const sourceHeight = Number(sourceMeta?.height) || 0;
    const sourceArea = sourceWidth * sourceHeight;

    if (sourceArea > 0) {
      const profile = getClothingShapeProfile(normalizeGarmentType(garmentType));
      const minExpectedRatio = Math.max(0.02, Math.min(0.18, (profile?.minAreaRatio || 0.06) * 0.55));
      const targetRatio = Math.max(minExpectedRatio, Math.min(0.65, Number(profile?.targetAreaRatio) || 0.24));
      const maxExpectedRatio = 1.2;

      const buildCandidate = (label, result) => {
        const width = Number(result?.cutout?.width) || 0;
        const height = Number(result?.cutout?.height) || 0;
        const area = width * height;
        const ratio = sourceArea > 0 ? area / sourceArea : 0;
        return {
          label,
          result,
          width,
          height,
          area,
          ratio,
        };
      };

      const scoreCandidate = (candidate) => {
        if (!candidate || !candidate.area || candidate.area <= 0) {
          return Number.POSITIVE_INFINITY;
        }

        const ratio = candidate.ratio;
        const safeRatio = Math.max(1e-6, ratio);
        let score = Math.abs(Math.log(safeRatio / Math.max(1e-6, targetRatio)));

        if (ratio < minExpectedRatio) {
          score += (minExpectedRatio - ratio) * 24;
        }

        if (ratio > maxExpectedRatio) {
          score += (ratio - maxExpectedRatio) * 12;
        }

        // Slightly prefer the primary cutout when candidates are similar.
        if (candidate.label === 'primary') {
          score -= 0.08;
        }

        return score;
      };

      const candidates = [buildCandidate('primary', cutoutResult)];
      const primaryRatio = candidates[0].ratio;

      if (primaryRatio < minExpectedRatio || primaryRatio > (maxExpectedRatio + 0.12)) {
        console.warn('Primary cutout ratio is out of expected range; evaluating fallback candidates.', {
          garmentType,
          ratio: Number(primaryRatio.toFixed(5)),
          minExpectedRatio: Number(minExpectedRatio.toFixed(5)),
          maxExpectedRatio,
          cutout: { width: candidates[0].width, height: candidates[0].height },
          source: { width: sourceWidth, height: sourceHeight },
        });

        try {
          const heuristicCutout = await createHeuristicGarmentCutout(buffer);
          candidates.push(buildCandidate('heuristic', heuristicCutout));
        } catch (heuristicError) {
          console.warn('Heuristic cutout candidate failed:', heuristicError.message);
        }

        try {
          const colorKeyCutout = await createColorKeyCutout(buffer);
          candidates.push(buildCandidate('color-key', colorKeyCutout));
        } catch (colorKeyError) {
          console.warn('Color-key cutout candidate failed:', colorKeyError.message);
        }

        const ranked = candidates
          .map((candidate) => ({
            ...candidate,
            score: scoreCandidate(candidate),
          }))
          .sort((first, second) => first.score - second.score);

        if (ranked.length > 0 && Number.isFinite(ranked[0].score)) {
          cutoutResult = ranked[0].result;
          console.warn('Selected cutout candidate after quality scoring.', {
            garmentType,
            selected: ranked[0].label,
            selectedRatio: Number(ranked[0].ratio.toFixed(5)),
            alternatives: ranked.map((entry) => ({
              label: entry.label,
              ratio: Number(entry.ratio.toFixed(5)),
              score: Number(entry.score.toFixed(4)),
            })),
          });
        }
      }
    }
  } catch (qualityError) {
    console.warn('Cutout quality validation failed:', qualityError.message);
  }

  const cutoutDataUrl = cutoutResult?.pngDataUrl || null;

  if (cutoutDataUrl && cutoutDataUrl.startsWith('data:image/png;base64,')) {
    try {
      const cutoutBuffer = Buffer.from(cutoutDataUrl.split(',')[1], 'base64');
      const serviceModel = await inferGarment3DWithXClothService(cutoutBuffer, garmentType, 'image/png', cutoutDataUrl);
      return {
        ...cutoutResult,
        garmentModel: serviceModel,
      };
    } catch (error) {
      console.warn('xCloth inference service unavailable, falling back to local approximation:', error.message);
    }
  }

  const fallbackResult = await createApproxGarment3DModelFromCutout(buffer, garmentType, mimeType, cutoutResult);
  return fallbackResult;
}

async function createColorKeyCutout(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width < 2 || height < 2 || channels < 4) {
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  const outputRaw = Buffer.from(data);
  const borderBand = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let samples = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorder =
        x < borderBand ||
        y < borderBand ||
        x >= width - borderBand ||
        y >= height - borderBand;
      if (!isBorder) continue;

      const offset = (y * width + x) * channels;
      sumR += outputRaw[offset];
      sumG += outputRaw[offset + 1];
      sumB += outputRaw[offset + 2];
      samples += 1;
    }
  }

  const background = samples > 0
    ? [sumR / samples, sumG / samples, sumB / samples]
    : [255, 255, 255];

  const distanceThreshold = 38;
  const distanceThresholdSquared = distanceThreshold * distanceThreshold;
  const nearWhiteThreshold = 244;
  const candidateMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      const red = outputRaw[offset];
      const green = outputRaw[offset + 1];
      const blue = outputRaw[offset + 2];

      const distanceSquared =
        (red - background[0]) * (red - background[0]) +
        (green - background[1]) * (green - background[1]) +
        (blue - background[2]) * (blue - background[2]);

      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (distanceSquared > distanceThresholdSquared || luminance < nearWhiteThreshold) {
        candidateMask[index] = 1;
      }
    }
  }

  const visited = new Uint8Array(width * height);
  const queue = [];
  let queueHead = 0;
  let bestPixels = [];
  let bestScore = -Infinity;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = Math.max(1, Math.hypot(centerX, centerY));

  for (let start = 0; start < candidateMask.length; start += 1) {
    if (!candidateMask[start] || visited[start]) continue;

    queue.length = 0;
    queueHead = 0;
    queue.push(start);
    visited[start] = 1;

    let area = 0;
    let sumXComponent = 0;
    let sumYComponent = 0;
    const pixels = [];

    while (queueHead < queue.length) {
      const current = queue[queueHead++];
      const x = current % width;
      const y = Math.floor(current / width);

      area += 1;
      sumXComponent += x;
      sumYComponent += y;
      pixels.push(current);

      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIndex = ny * width + nx;
        if (!candidateMask[nIndex] || visited[nIndex]) continue;
        visited[nIndex] = 1;
        queue.push(nIndex);
      }
    }

    const centroidX = sumXComponent / area;
    const centroidY = sumYComponent / area;
    const centerDistance = Math.hypot(centroidX - centerX, centroidY - centerY) / maxDistance;
    const score = area * (1 - Math.min(0.92, centerDistance));

    if (score > bestScore) {
      bestScore = score;
      bestPixels = pixels;
    }
  }

  if (!bestPixels.length) {
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  const keepMask = new Uint8Array(width * height);
  for (const pixelIndex of bestPixels) {
    keepMask[pixelIndex] = 1;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;

      if (!keepMask[index]) {
        outputRaw[offset + 3] = 0;
        continue;
      }

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const croppedPngBuffer = await sharp(outputRaw, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();

  return {
    pngDataUrl: `data:image/png;base64,${croppedPngBuffer.toString('base64')}`,
    cutout: {
      width: cropWidth,
      height: cropHeight,
      offsetX: minX,
      offsetY: minY,
    },
  };
}

async function createHeuristicGarmentCutout(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const channels = info.channels;

  if (channels < 4 || width < 2 || height < 2) {
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  const borderBand = Math.max(8, Math.round(Math.min(width, height) * 0.08));
  const quantizationSize = 16;
  const colorBuckets = new Map();
  const borderDistances = [];

  const quantizeChannel = (value) => Math.floor(value / quantizationSize) * quantizationSize;
  const makeBucketKey = (red, green, blue) => `${quantizeChannel(red)}|${quantizeChannel(green)}|${quantizeChannel(blue)}`;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorderPixel =
        x < borderBand ||
        y < borderBand ||
        x >= width - borderBand ||
        y >= height - borderBand;

      if (!isBorderPixel) continue;

      const index = (y * width + x) * channels;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const key = makeBucketKey(red, green, blue);
      const bucket = colorBuckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };

      bucket.count += 1;
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
      colorBuckets.set(key, bucket);
    }
  }

  let background = [255, 255, 255];
  if (colorBuckets.size > 0) {
    let dominantBucket = null;

    for (const bucket of colorBuckets.values()) {
      if (!dominantBucket || bucket.count > dominantBucket.count) {
        dominantBucket = bucket;
      }
    }

    if (dominantBucket) {
      background = [
        dominantBucket.red / dominantBucket.count,
        dominantBucket.green / dominantBucket.count,
        dominantBucket.blue / dominantBucket.count,
      ];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorderPixel =
        x < borderBand ||
        y < borderBand ||
        x >= width - borderBand ||
        y >= height - borderBand;

      if (!isBorderPixel) continue;

      const index = (y * width + x) * channels;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const distance = Math.sqrt(
        (red - background[0]) * (red - background[0]) +
        (green - background[1]) * (green - background[1]) +
        (blue - background[2]) * (blue - background[2])
      );

      borderDistances.push(distance);
    }
  }

  borderDistances.sort((a, b) => a - b);
  const thresholdIndex = Math.min(borderDistances.length - 1, Math.max(0, Math.floor(borderDistances.length * 0.9)));
  const adaptiveThreshold = borderDistances.length > 0 ? borderDistances[thresholdIndex] + 10 : 72;

  const threshold = Math.max(42, Math.min(150, adaptiveThreshold));
  const thresholdSquared = threshold * threshold;
  const visited = new Uint8Array(width * height);
  const queue = [];
  let queueHead = 0;

  const isLikelyBackground = (x, y) => {
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

  const enqueueIfBackground = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (visited[idx]) return;
    if (!isLikelyBackground(x, y)) return;

    visited[idx] = 1;
    queue.push(idx);
  };

  const isSkinTonePixel = (red, green, blue) => {
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const chroma = maxChannel - minChannel;

    if (red < 95 || green < 40 || blue < 20) return false;
    if (chroma < 12) return false;
    if (Math.abs(red - green) < 18) return false;
    if (red <= green || red <= blue) return false;

    const saturation = maxChannel === 0 ? 0 : chroma / maxChannel;
    return saturation > 0.08;
  };

  for (let x = 0; x < width; x += 1) {
    enqueueIfBackground(x, 0);
    enqueueIfBackground(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    enqueueIfBackground(0, y);
    enqueueIfBackground(width - 1, y);
  }

  while (queueHead < queue.length) {
    const current = queue[queueHead++];
    const x = current % width;
    const y = Math.floor(current / width);

    enqueueIfBackground(x + 1, y);
    enqueueIfBackground(x - 1, y);
    enqueueIfBackground(x, y + 1);
    enqueueIfBackground(x, y - 1);
  }

  const outputRaw = Buffer.from(data);
  const foregroundMask = new Uint8Array(width * height);
  const centerX = width / 2;
  const centerY = height / 2;
  const maxCenterDistance = Math.hypot(centerX, centerY);
  const components = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;

      if (visited[pixelIndex] || outputRaw[offset + 3] === 0) continue;
      foregroundMask[pixelIndex] = 1;
    }
  }

  const componentVisited = new Uint8Array(width * height);
  const componentQueue = [];
  let componentQueueHead = 0;

  for (let startIndex = 0; startIndex < foregroundMask.length; startIndex += 1) {
    if (!foregroundMask[startIndex] || componentVisited[startIndex]) continue;

    componentVisited[startIndex] = 1;
    componentQueue.length = 0;
    componentQueueHead = 0;
    componentQueue.push(startIndex);

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const pixels = [];

    while (componentQueueHead < componentQueue.length) {
      const current = componentQueue[componentQueueHead++];
      const x = current % width;
      const y = Math.floor(current / width);

      area += 1;
      sumX += x;
      sumY += y;
      pixels.push(current);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nextX, nextY] of neighbors) {
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;

        const nextIndex = nextY * width + nextX;
        if (!foregroundMask[nextIndex] || componentVisited[nextIndex]) continue;

        componentVisited[nextIndex] = 1;
        componentQueue.push(nextIndex);
      }
    }

    const centroidX = sumX / area;
    const centroidY = sumY / area;
    const centerDistance = Math.hypot(centroidX - centerX, centroidY - centerY);
    const normalizedCenterDistance = maxCenterDistance === 0 ? 1 : centerDistance / maxCenterDistance;
    const widthSpan = maxX - minX + 1;
    const heightSpan = maxY - minY + 1;
    const aspectPenalty = widthSpan > 0 && heightSpan > 0 ? Math.abs(Math.log(widthSpan / heightSpan)) * 0.05 : 0;
    const touchesBorder = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    const borderPenalty = touchesBorder ? 0.22 : 0;
    const centerWeight = Math.max(0.18, 1 - normalizedCenterDistance * 1.2);
    const score = area * centerWeight * (1 - aspectPenalty - borderPenalty);

    components.push({
      area,
      score,
      minX,
      minY,
      maxX,
      maxY,
      centroidX,
      centroidY,
      pixels,
    });
  }

  if (components.length === 0) {
    return createColorKeyCutout(buffer);
  }

  components.sort((a, b) => b.score - a.score || b.area - a.area);
  const selected = components[0];
  const selectedMask = new Uint8Array(width * height);

  for (const pixelIndex of selected.pixels) {
    selectedMask[pixelIndex] = 1;
  }

  if (selected.pixels.length === 0) {
    return createColorKeyCutout(buffer);
  }

  const wearerMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;

      if (!selectedMask[pixelIndex] || outputRaw[offset + 3] === 0) continue;

      if (isSkinTonePixel(outputRaw[offset], outputRaw[offset + 1], outputRaw[offset + 2])) {
        wearerMask[pixelIndex] = 1;
      }
    }
  }

  const wearerExpansionPasses = 3;
  for (let pass = 0; pass < wearerExpansionPasses; pass += 1) {
    const expandedMask = new Uint8Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        if (!wearerMask[pixelIndex]) continue;

        expandedMask[pixelIndex] = 1;
        if (x > 0) expandedMask[pixelIndex - 1] = 1;
        if (x < width - 1) expandedMask[pixelIndex + 1] = 1;
        if (y > 0) expandedMask[pixelIndex - width] = 1;
        if (y < height - 1) expandedMask[pixelIndex + width] = 1;
      }
    }

    wearerMask.set(expandedMask);
  }

  const baseMask = new Uint8Array(width * height);
  const rowCounts = new Array(height).fill(0);
  const columnCounts = new Array(width).fill(0);
  let baseArea = 0;
  let baseSumX = 0;
  let baseSumY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;

      if (!selectedMask[pixelIndex] || wearerMask[pixelIndex]) continue;
      if (outputRaw[offset + 3] === 0) continue;

      baseMask[pixelIndex] = 1;
      rowCounts[y] += 1;
      columnCounts[x] += 1;
      baseArea += 1;
      baseSumX += x;
      baseSumY += y;
    }
  }

  if (baseArea === 0) {
    return createColorKeyCutout(buffer);
  }

  const rowPeak = Math.max(...rowCounts);
  const columnPeak = Math.max(...columnCounts);
  const rowThreshold = Math.max(2, Math.round(rowPeak * 0.14));
  const columnThreshold = Math.max(2, Math.round(columnPeak * 0.14));
  const centroidX = baseSumX / baseArea;
  const centroidY = baseSumY / baseArea;

  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  let peakRow = 0;
  let peakColumn = 0;
  for (let i = 0; i < height; i += 1) {
    if (rowCounts[i] >= rowPeak) {
      peakRow = i;
      break;
    }
  }

  for (let i = 0; i < width; i += 1) {
    if (columnCounts[i] >= columnPeak) {
      peakColumn = i;
      break;
    }
  }

  top = peakRow;
  while (top > 0 && rowCounts[top - 1] >= rowThreshold) top -= 1;
  bottom = peakRow;
  while (bottom < height - 1 && rowCounts[bottom + 1] >= rowThreshold) bottom += 1;
  left = peakColumn;
  while (left > 0 && columnCounts[left - 1] >= columnThreshold) left -= 1;
  right = peakColumn;
  while (right < width - 1 && columnCounts[right + 1] >= columnThreshold) right += 1;

  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  top = Math.max(0, top - padding);
  bottom = Math.min(height - 1, bottom + padding);
  left = Math.max(0, left - padding);
  right = Math.min(width - 1, right + padding);

  const coreMask = new Uint8Array(width * height);
  const coreRadiusX = Math.max(1, (right - left + 1) / 2);
  const coreRadiusY = Math.max(1, (bottom - top + 1) / 2);
  const ellipseScale = 1.08;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const pixelIndex = y * width + x;
      if (!baseMask[pixelIndex]) continue;

      const normalizedX = (x - centroidX) / (coreRadiusX * ellipseScale);
      const normalizedY = (y - centroidY) / (coreRadiusY * ellipseScale);
      if ((normalizedX * normalizedX) + (normalizedY * normalizedY) <= 1) {
        coreMask[pixelIndex] = 1;
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;

      if (!coreMask[pixelIndex]) {
        outputRaw[offset + 3] = 0;
        continue;
      }

      if (outputRaw[offset + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return createColorKeyCutout(buffer);
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;

  const croppedPngBuffer = await sharp(outputRaw, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();

  return {
    pngDataUrl: `data:image/png;base64,${croppedPngBuffer.toString('base64')}`,
    cutout: {
      width: cropWidth,
      height: cropHeight,
      offsetX: minX,
      offsetY: minY,
    },
  };
}

function normalizeOcrToken(text) {
  return String(text || '')
    .replace(/[|]/g, 'I')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[,:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isSizeLabelToken(token) {
  const compact = normalizeSizeLabel(token).replace(/\s+/g, '');
  if (!compact) return false;

  return /^(X|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d+XL|\d+X|\d+T|\d{1,2}(?:\/\d{1,2})?|00)$/.test(compact);
}

function parseNumericValueFromToken(token) {
  if (!token) return null;

  const normalized = String(token)
    .replace(/\u00BC/g, '.25')
    .replace(/\u00BD/g, '.5')
    .replace(/\u00BE/g, '.75')
    .replace(/\u215B/g, '.125')
    .replace(/\u215C/g, '.375')
    .replace(/\u215D/g, '.625')
    .replace(/\u215E/g, '.875')
    .replace(/,/g, '.')
    .trim();

  const percentHalfMatch = normalized.match(/^(\d+(?:\.\d+)?)%$/);
  if (percentHalfMatch) {
    const parsedHalf = Number.parseFloat(percentHalfMatch[1]);
    return Number.isFinite(parsedHalf) ? parsedHalf + 0.5 : null;
  }

  const normalizeCompactedMeasurement = (rawValue, normalizedToken) => {
    if (!Number.isFinite(rawValue)) {
      return rawValue;
    }

    // OCR often drops decimal separators in measurement tables (e.g. 365 -> 36.5).
    if (/^\d{3}$/.test(normalizedToken) && rawValue >= 120) {
      return rawValue / 10;
    }

    // 4-digit compact values are usually two-digit measurements with two decimal digits.
    if (/^\d{4}$/.test(normalizedToken) && rawValue >= 1000) {
      return rawValue / 100;
    }

    return rawValue;
  };

  const rangeMatch = normalized.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    return normalizeCompactedMeasurement(Number.parseFloat(rangeMatch[1]), rangeMatch[1]);
  }

  const mixedFractionMatch = normalized.match(/(\d+)\s+(\d+)\/(\d+)/);
  if (mixedFractionMatch) {
    const whole = Number.parseFloat(mixedFractionMatch[1]);
    const numerator = Number.parseFloat(mixedFractionMatch[2]);
    const denominator = Number.parseFloat(mixedFractionMatch[3]);
    if (Number.isFinite(whole) && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return whole + numerator / denominator;
    }
  }

  const fractionMatch = normalized.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }

  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return normalizeCompactedMeasurement(parsed, match[0]);
}

function groupWordsIntoRows(words) {
  const rows = [];
  const sortedWords = [...words].sort((a, b) => a.cy - b.cy);

  for (const word of sortedWords) {
    let bestRow = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      const tolerance = Math.max(8, row.avgHeight * 0.65);
      const distance = Math.abs(word.cy - row.cy);
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance;
        bestRow = row;
      }
    }

    if (!bestRow) {
      rows.push({
        cy: word.cy,
        avgHeight: word.height,
        tokens: [word],
      });
      continue;
    }

    bestRow.tokens.push(word);
    bestRow.cy = (bestRow.cy * (bestRow.tokens.length - 1) + word.cy) / bestRow.tokens.length;
    bestRow.avgHeight = (bestRow.avgHeight * (bestRow.tokens.length - 1) + word.height) / bestRow.tokens.length;
  }

  rows.sort((a, b) => a.cy - b.cy);
  rows.forEach((row) => {
    row.tokens.sort((a, b) => a.cx - b.cx);
  });

  return rows;
}

function repairSizeHeaderColumns(columns) {
  const repaired = (columns || []).map((column) => ({
    ...column,
    label: normalizeSizeLabel(column.label),
  }));

  const hasNumericXSeries = repaired.some((column) => /^\d+X$/.test(column.label));
  const hasLoneX = repaired.some((column) => column.label === 'X');
  const hasPlusSizeContext = repaired.some((column) => /^(XXL|XXXL|4XL|5XL|6XL)$/.test(column.label));

  if (hasNumericXSeries || hasLoneX || hasPlusSizeContext) {
    for (const column of repaired) {
      if (/^\d+$/.test(column.label)) {
        column.label = `${column.label}X`;
      }
    }
  }

  for (let index = 0; index < repaired.length; index += 1) {
    if (repaired[index].label !== 'X') {
      continue;
    }

    let inferred = null;

    for (let left = index - 1; left >= 0; left -= 1) {
      const match = repaired[left].label.match(/^(\d+)X$/);
      if (match) {
        inferred = Number.parseInt(match[1], 10) + 1;
        break;
      }
    }

    if (inferred === null) {
      for (let right = index + 1; right < repaired.length; right += 1) {
        const match = repaired[right].label.match(/^(\d+)X$/);
        if (match) {
          inferred = Number.parseInt(match[1], 10) - 1;
          break;
        }
      }
    }

    if (Number.isInteger(inferred) && inferred > 0) {
      repaired[index].label = `${inferred}X`;
    }
  }

  const toddlerSequence = inferSuffixedNumericSizeSequence(repaired, 'T');
  if (toddlerSequence) {
    repaired.forEach((column, index) => {
      const expectedValue = toddlerSequence.start + index * toddlerSequence.step;
      const currentMatch = normalizeSizeLabel(column.label).match(/^(\d+)T$/);

      if (!currentMatch || Number.parseInt(currentMatch[1], 10) !== expectedValue) {
        column.label = `${expectedValue}T`;
      }
    });
  }

  const numericSequence = inferNumericSizeSequence(repaired);
  if (numericSequence) {
    repaired.forEach((column, index) => {
      const expectedValue = numericSequence.start + index * numericSequence.step;
      const currentNumericValue = parseNumericSizeLabel(column.label);

      if (currentNumericValue !== expectedValue) {
        column.label = `${expectedValue}`;
      }
    });
  }

  return repaired.filter((column) => isSizeLabelToken(column.label));
}

function extractSizesFromTableWords(ocrData) {
  const words = (ocrData?.words || [])
    .map((word) => {
      const text = normalizeOcrToken(word.text);
      if (!text) return null;

      const x0 = word?.bbox?.x0 ?? 0;
      const x1 = word?.bbox?.x1 ?? 0;
      const y0 = word?.bbox?.y0 ?? 0;
      const y1 = word?.bbox?.y1 ?? 0;

      return {
        text,
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        height: Math.max(1, y1 - y0),
      };
    })
    .filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  const rows = groupWordsIntoRows(words);
  if (rows.length === 0) {
    return [];
  }

  const missingValuePattern = /^(?:N\s*\/\s*A|NA|N\.A\.?|NONE|--|—|–|-)$/i;
  const isMissingValueToken = (text) => missingValuePattern.test(String(text || '').trim());
  const getColumnDistanceLimit = (columns, index) => {
    const currentX = columns[index]?.x;
    if (typeof currentX !== 'number') {
      return 24;
    }

    const prevX = index > 0 ? columns[index - 1]?.x : null;
    const nextX = index < columns.length - 1 ? columns[index + 1]?.x : null;
    const neighborGaps = [
      typeof prevX === 'number' ? Math.abs(currentX - prevX) : Infinity,
      typeof nextX === 'number' ? Math.abs(nextX - currentX) : Infinity,
    ].filter(Number.isFinite);

    if (neighborGaps.length === 0) {
      return 24;
    }

    return Math.max(18, Math.min(...neighborGaps) * 0.45);
  };

  const assignRowCellsToColumns = (row, columns) => {
    const orderedColumns = [...(columns || [])]
      .map((column, index) => ({ ...column, index }))
      .filter((column) => typeof column.x === 'number')
      .sort((first, second) => first.x - second.x);

    const sortedRowTokens = [...row.tokens].sort((first, second) => first.cx - second.cx);
    const numericCells = [];
    for (let index = 0; index < sortedRowTokens.length; index += 1) {
      const token = sortedRowTokens[index];
      let value = parseNumericValueFromToken(token.text);
      if (!Number.isFinite(value)) {
        continue;
      }

      const nextToken = sortedRowTokens[index + 1];
      if (nextToken && String(nextToken.text || '').trim() === '%') {
        value += 0.5;
        index += 1;
      }

      numericCells.push({ x: token.cx, value });
    }

    for (let index = 1; index < numericCells.length; index += 1) {
      while (numericCells[index].value + 4 < numericCells[index - 1].value) {
        numericCells[index].value += 10;
      }
    }

    const missingCells = row.tokens
      .filter((token) => parseNumericValueFromToken(token.text) === null && isMissingValueToken(token.text))
      .map((token) => ({ x: token.cx, text: token.text }));

    if (numericCells.length === 0 || orderedColumns.length === 0) {
      return new Map();
    }

    const assignments = new Map();
    for (const numericCell of numericCells) {
      let bestColumn = null;
      let bestDistance = Infinity;

      for (let index = 0; index < orderedColumns.length; index += 1) {
        const column = orderedColumns[index];
        const distance = Math.abs(numericCell.x - column.x);
        const distanceLimit = getColumnDistanceLimit(orderedColumns, index);
        const blockedByMissingValue = missingCells.some((cell) => Math.abs(cell.x - column.x) <= distanceLimit);

        if (blockedByMissingValue || distance > distanceLimit || distance >= bestDistance) {
          continue;
        }

        bestDistance = distance;
        bestColumn = column;
      }

      if (!bestColumn) {
        continue;
      }

      const existing = assignments.get(bestColumn.index);
      if (!existing || bestDistance < existing.distance) {
        assignments.set(bestColumn.index, {
          value: numericCell.value,
          distance: bestDistance,
        });
      }
    }

    return assignments;
  };

  let headerRowIndex = -1;
  let headerLabels = [];

  const headerMeasurementKeywords = ['CHEST', 'BUST', 'WAIST', 'BODY', 'WIDTH', 'LENGTH', 'HIP', 'INSEAM', 'SLEEVE', 'SHOULDER', 'NECK', 'RISE'];
  let bestHeaderCandidate = null;

  for (let index = 0; index < Math.min(rows.length, 8); index += 1) {
    const row = rows[index];
    const sizeTokens = row.tokens.filter((token) => isSizeLabelToken(token.text));
    const hasSizeWord = row.tokens.some((token) => token.text === 'SIZE');

    if (sizeTokens.length < 2 && !(hasSizeWord && sizeTokens.length >= 1)) {
      continue;
    }

    const rowText = row.tokens.map((token) => token.text).join(' ');
    const hasMeasurementKeyword = headerMeasurementKeywords.some((keyword) => rowText.includes(keyword));
    const nonSizeNonNumericCount = row.tokens.filter((token) => {
      if (isSizeLabelToken(token.text)) {
        return false;
      }

      return parseNumericValueFromToken(token.text) === null;
    }).length;

    const firstContentIndex = row.tokens.findIndex((token) => {
      if (isSizeLabelToken(token.text) || parseNumericValueFromToken(token.text) !== null) {
        return true;
      }

      return String(token.text || '').trim().length === 1;
    });
    const candidateLabels = firstContentIndex === -1 ? sizeTokens : row.tokens.slice(firstContentIndex);

    const score =
      sizeTokens.length * 4
      + (hasSizeWord ? 5 : 0)
      - (hasMeasurementKeyword ? 12 : 0)
      - Math.max(0, nonSizeNonNumericCount - 2)
      - index * 0.25;

    if (!bestHeaderCandidate || score > bestHeaderCandidate.score) {
      bestHeaderCandidate = {
        index,
        labels: candidateLabels,
        score,
      };
    }
  }

  if (bestHeaderCandidate) {
    headerRowIndex = bestHeaderCandidate.index;
    headerLabels = bestHeaderCandidate.labels;
  }

  // --- Column-oriented detection ---
  // In a column-oriented table the first column contains size labels (one per row)
  // and the header row (if any) contains measurement type names.
  // Heuristic: if we found no row-oriented header, OR if the first non-header column
  // has size label tokens in most data rows, treat as column-oriented.
  const detectColumnOriented = () => {
    // Gather text of first-column tokens across all rows (excluding any detected header)
    const startCheck = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
    const checkRows = rows.slice(startCheck, startCheck + 12);
    if (checkRows.length < 2) return false;
    const firstColXs = checkRows.map((r) => r.tokens[0]?.cx ?? 0);
    const avgFirstColX = firstColXs.reduce((a, b) => a + b, 0) / firstColXs.length;
    const sizeRowCount = checkRows.filter((r) => {
      const firstToken = r.tokens.find((t) => Math.abs(t.cx - avgFirstColX) < 30);
      return firstToken && isSizeLabelToken(firstToken.text);
    }).length;
    return sizeRowCount >= Math.max(2, Math.floor(checkRows.length * 0.5));
  };

  const isColumnOriented = headerRowIndex === -1 || detectColumnOriented();

  if (isColumnOriented) {
    // Find the measurement-type header row and keep all plausible measurement columns,
    // not only a narrow keyword list (guides vary: sleeve, shoulder, neck, rise, etc.).
    const measurementKeywordsCol = ['CHEST', 'BUST', 'WAIST', 'BODY', 'WIDTH', 'LENGTH', 'HIP', 'INSEAM', 'SLEEVE', 'SHOULDER', 'NECK', 'RISE'];
    const headerStopWords = new Set(['SIZE', 'US', 'UK', 'EU', 'CM', 'MM', 'IN', 'INCH', 'INCHES']);
    const isMeasurementHeaderToken = (text) => {
      const token = String(text || '').trim();
      if (!token || token.length < 2) {
        return false;
      }

      if (isSizeLabelToken(token)) {
        return false;
      }

      if (parseNumericValueFromToken(token) !== null) {
        return false;
      }

      if (headerStopWords.has(token)) {
        return false;
      }

      return true;
    };

    let colHeaderRowIndex = -1;
    let colMeasurementHeaders = [];
    let bestHeaderScore = -1;

    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const row = rows[i];
      const candidateHeaders = row.tokens
        .filter((t) => isMeasurementHeaderToken(t.text))
        .map((t) => ({ text: t.text, x: t.cx }));

      if (candidateHeaders.length < 2) {
        continue;
      }

      const rowText = row.tokens.map((t) => t.text).join(' ');
      const kwCount = measurementKeywordsCol.filter((kw) => rowText.includes(kw)).length;
      const score = candidateHeaders.length + kwCount * 2;

      if (score > bestHeaderScore) {
        bestHeaderScore = score;
        colHeaderRowIndex = i;
        colMeasurementHeaders = candidateHeaders;
      }
    }

    if (colHeaderRowIndex === -1 || colMeasurementHeaders.length === 0) {
      // No measurement header found – cannot parse column-oriented table
      return [];
    }

    const dataRows = rows.slice(colHeaderRowIndex + 1);
    const allMappedColRows = [];

    for (const row of dataRows) {
      if (row.tokens.length < 2) continue;

      // Determine the size label: first token in the row that is a size label token
      const sizeLabelToken = row.tokens.find((t) => isSizeLabelToken(t.text));
      if (!sizeLabelToken) continue;
      const sizeLabel = normalizeSizeLabel(sizeLabelToken.text);
      if (!sizeLabel) continue;

      const assignedValues = assignRowCellsToColumns(row, colMeasurementHeaders);
      if (assignedValues.size === 0) continue;

      for (let headerIndex = 0; headerIndex < colMeasurementHeaders.length; headerIndex += 1) {
        const header = colMeasurementHeaders[headerIndex];
        const assignedValue = assignedValues.get(headerIndex);
        if (assignedValue) {
          allMappedColRows.push({
            label: sizeLabel,
            sizeLabel,
            measurementType: header.text.slice(0, 64).trim(),
            value: assignedValue.value,
          });
        }
      }
    }

    return allMappedColRows;
  }

  if (headerRowIndex === -1 || headerLabels.length === 0) {
    return [];
  }

  // Keep one consistent size depiction row (e.g., XXS/XS/... or 00/0/2/...).
  // Some guides include both depictions on stacked rows; we intentionally use only
  // the first detected row to avoid mixing label styles.
  const headerColumns = repairSizeHeaderColumns(headerLabels.map((token) => ({
    label: normalizeSizeLabel(token.text),
    x: token.cx,
  })));

  let depictionRowCount = 1;
  for (let index = headerRowIndex + 1; index < Math.min(rows.length, headerRowIndex + 3); index += 1) {
    const row = rows[index];
    const sizeTokens = row.tokens.filter((token) => isSizeLabelToken(token.text));
    const rowText = row.tokens.map((token) => token.text).join(' ');
    const numericValueTokens = row.tokens.filter((token) => parseNumericValueFromToken(token.text) !== null).length;
    const hasMeasurementKeyword = ['CHEST', 'BUST', 'WAIST', 'BODY', 'WIDTH', 'LENGTH', 'HIP', 'INSEAM', 'SLEEVE', 'SHOULDER', 'NECK', 'RISE']
      .some((keyword) => rowText.includes(keyword));

    if (
      !hasMeasurementKeyword
      && numericValueTokens <= 1
      && sizeTokens.length >= Math.max(2, Math.floor(headerColumns.length * 0.6))
    ) {
      depictionRowCount += 1;
    } else {
      break;
    }
  }

  const measurementKeywords = ['CHEST', 'BUST', 'WAIST', 'BODY', 'WIDTH', 'LENGTH', 'HIP', 'INSEAM'];
  const measurementSearchStart = headerRowIndex + depictionRowCount;

  const headerMinX = headerColumns.reduce((min, column) => Math.min(min, column.x), Number.POSITIVE_INFINITY);
  const minExpectedNumericCells = Math.max(2, Math.floor(headerColumns.length * 0.5));

  const inferMeasurementTypeFromRow = (row) => {
    const nonNumericLeftTokens = row.tokens
      .filter((token) => parseNumericValueFromToken(token.text) === null)
      .filter((token) => token.cx <= headerMinX + 8)
      .map((token) => token.text)
      .filter(Boolean);

    let measurementType = nonNumericLeftTokens.join(' ').replace(/\s+/g, ' ').trim();
    if (!measurementType) {
      const rowText = row.tokens.map((token) => token.text).join(' ');
      const keyword = measurementKeywords.find((candidate) => rowText.includes(candidate));
      measurementType = keyword || 'MEASUREMENT';
    }

    return measurementType.slice(0, 64).trim() || 'MEASUREMENT';
  };

  const mapSizeValuesForRow = (row, measurementType) => {
    const assignedValues = assignRowCellsToColumns(row, headerColumns);

    if (assignedValues.size < minExpectedNumericCells) {
      return [];
    }

    const mapped = [];
    for (let columnIndex = 0; columnIndex < headerColumns.length; columnIndex += 1) {
      const column = headerColumns[columnIndex];
      const sizeLabel = normalizeSizeLabel(column.label);
      const assignedValue = assignedValues.get(columnIndex);
      if (!sizeLabel || !assignedValue) {
        continue;
      }

      mapped.push({
        label: sizeLabel,
        sizeLabel,
        measurementType,
        value: assignedValue.value,
      });
    }

    return mapped;
  };

  const allMappedRows = [];
  for (let index = measurementSearchStart; index < rows.length; index += 1) {
    const row = rows[index];
    const rowText = row.tokens.map((token) => token.text).join(' ');
    const hasKeyword = measurementKeywords.some((keyword) => rowText.includes(keyword));
    const numericTokenCount = row.tokens.filter((token) => parseNumericValueFromToken(token.text) !== null).length;

    if (!hasKeyword && numericTokenCount < minExpectedNumericCells) {
      continue;
    }

    const measurementType = inferMeasurementTypeFromRow(row);
    const mapped = mapSizeValuesForRow(row, measurementType);
    if (mapped.length > 0) {
      allMappedRows.push(...mapped);
    }
  }

  return allMappedRows;
}

function parseSizeGuideText(text) {
  const sizes = [];
  const seenLabels = new Set();

  const cleanText = String(text || '')
    .replace(/[•·◦\[\]]/g, ' ')
    .replace(/[%]/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .toUpperCase();

  console.log('Cleaned text:', cleanText);

  const labelPattern = /\b(XXXL|XXL|2XL|XL|XS|S|M|L|3XL|4XL|5XL|\d+T|00|\d{1,2}(?:\/\d{1,2})?)\b/gi;
  const numberPattern = /\b(\d{1,3}(?:\.\d+)?)\b/g;
  const lines = cleanText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalizedLine = line
      .replace(/(\d+)\s*X\s*L\b/g, '$1XL')
      .replace(/X\s*X\s*L\b/g, 'XXL')
      .replace(/X\s*X\s*X\s*L\b/g, 'XXXL')
      .replace(/X\s*S\b/g, 'XS')
      .replace(/(\d+)\s*T\b/g, '$1T');

    const labelMatches = [...normalizedLine.matchAll(labelPattern)];
    if (labelMatches.length === 0) {
      continue;
    }

    for (let labelIndex = 0; labelIndex < labelMatches.length; labelIndex += 1) {
      const labelMatch = labelMatches[labelIndex];
      const label = normalizeSizeLabel(labelMatch[1]);
      if (seenLabels.has(label)) {
        continue;
      }

      const labelStart = labelMatch.index;
      const labelEnd = labelStart + labelMatch[0].length;
      const nextLabelStart = labelIndex < labelMatches.length - 1 ? labelMatches[labelIndex + 1].index : normalizedLine.length;
      const segmentAfterLabel = normalizedLine.slice(labelEnd, nextLabelStart);

      if (/(N\s*\/\s*A|NA|N\.A\.?|NONE|--|—|–)/.test(segmentAfterLabel)) {
        continue;
      }

      let matchedValue = null;
      let bestDistance = Infinity;

      numberPattern.lastIndex = 0;
      let numberMatch;

      while ((numberMatch = numberPattern.exec(segmentAfterLabel)) !== null) {
        const value = parseFloat(numberMatch[1]);
        if (!Number.isFinite(value) || value <= 0 || value > 1000) {
          continue;
        }

        const distance = numberMatch.index;
        if (distance > 12 || distance >= bestDistance) {
          continue;
        }

        bestDistance = distance;
        matchedValue = value;
      }

      if (matchedValue !== null) {
        sizes.push({ label, value: matchedValue });
        seenLabels.add(label);
        console.log(`Matched: ${label} = ${matchedValue}`);
      }
    }
  }

  console.log('Parsed sizes:', sizes);
  return sizes;
}

function inferSizeLabelsFromText(text) {
  const cleanedTokens = String(text || '')
    .toUpperCase()
    .replace(/[\[\]{}()]/g, ' ')
    .split(/[^A-Z0-9\/]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (token === 'O' || token === 'D' || token === 'Q' || token === 'W0' || token === 'WO') {
        return '0';
      }
      return token;
    });

  const labels = [];
  const seen = new Set();
  for (const token of cleanedTokens) {
    if (!isSizeLabelToken(token)) {
      continue;
    }

    const normalized = normalizeSizeLabel(token);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    labels.push(normalized);
  }

  return labels;
}

function buildFallbackSizes(garmentType, observedText) {
  const inferred = inferSizeLabelsFromText(observedText);
  const normalizedGarmentType = normalizeGarmentType(garmentType);
  const numericPreferred = ['pants', 'shorts', 'skirt'].includes(normalizedGarmentType);

  const inferredNumericCount = inferred.filter((label) => parseNumericSizeLabel(label) !== null).length;
  const inferredAlphaCount = inferred.length - inferredNumericCount;

  let labels = inferred;
  if (numericPreferred && (inferredNumericCount < 3 || inferredAlphaCount > inferredNumericCount)) {
    labels = ['0', '2', '4', '6', '8', '10', '12', '14'];
  }

  if (!labels.length) {
    labels = numericPreferred
      ? ['0', '2', '4', '6', '8', '10', '12', '14']
      : ['XS', 'S', 'M', 'L', 'XL'];
  }

  const alphaDefaults = {
    XXXS: 10,
    XXS: 11,
    XS: 12,
    S: 14,
    M: 16,
    L: 18,
    XL: 20,
    XXL: 22,
    XXXL: 24,
    '4XL': 26,
    '5XL': 28,
    '6XL': 30,
  };

  return labels.map((label, index) => {
    const numeric = parseNumericSizeLabel(label);
    if (numeric !== null) {
      const inferredMeasurement = numeric <= 20 ? numeric + 24 : numeric;
      return { label, value: inferredMeasurement };
    }

    if (Object.prototype.hasOwnProperty.call(alphaDefaults, label)) {
      return { label, value: alphaDefaults[label] };
    }

    return { label, value: 12 + index * 2 };
  });
}

function normalizeNumericGuideValues(sizes) {
  if ((sizes || []).some((size) => size?.measurementType)) {
    return sortSizes(dedupeSizes(sizes || []));
  }

  const ordered = sortSizes(dedupeSizes(sizes || []));
  if (!ordered.length) {
    return ordered;
  }

  const numericLabels = ordered.map((size) => parseNumericSizeLabel(size.label));
  if (numericLabels.some((value) => value === null)) {
    return ordered;
  }

  const numericValues = ordered.map((size) => Number(size.value));
  const anchors = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const value = numericValues[index];
    if (!Number.isFinite(value)) continue;
    if (value < 10 || value > 80) continue;
    anchors.push({ x: numericLabels[index], y: value });
  }

  if (anchors.length < 2) {
    return ordered;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const anchor of anchors) {
    sumX += anchor.x;
    sumY += anchor.y;
    sumXY += anchor.x * anchor.y;
    sumXX += anchor.x * anchor.x;
  }

  const denominator = anchors.length * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-6) {
    return ordered;
  }

  const slope = (anchors.length * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / anchors.length;

  return ordered.map((size, index) => {
    const fitted = intercept + slope * numericLabels[index];
    return {
      ...size,
      value: Number.isFinite(fitted) ? Number.parseFloat(fitted.toFixed(2)) : size.value,
    };
  });
}

async function parseSizeGuideImage(file, garmentType = '') {
  const scoreParsedSizes = (sizes) => {
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = sizes.length * 20;
    const labels = sizes.map((size) => normalizeSizeLabel(size?.label));
    const values = sizes.map((size) => Number(size?.value));

    const numericLabels = labels
      .map((label) => parseNumericSizeLabel(label))
      .filter((value) => Number.isFinite(value));

    if (numericLabels.length >= 3) {
      const sorted = [...numericLabels].sort((a, b) => a - b);
      let nonDecreasingPairs = 0;
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index] >= sorted[index - 1]) {
          nonDecreasingPairs += 1;
        }
      }
      score += nonDecreasingPairs * 3;
    }

    const knownAlphaLabels = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL'];
    let knownAlphaCount = 0;
    for (const label of labels) {
      if (knownAlphaLabels.includes(label)) {
        knownAlphaCount += 1;
      }
    }
    score += knownAlphaCount * 3;

    const validValueCount = values.filter((value) => Number.isFinite(value) && value > 0).length;
    score += validValueCount * 2;

    const outlierCount = values.filter((value) => Number.isFinite(value) && (value > 120 || value < 2)).length;
    score -= outlierCount * 6;

    return score;
  };

  let observedText = '';

  const parseFromOcrResult = (result, label) => {
    const ocrText = result?.data?.text || '';
    observedText += `\n${ocrText}`;
    console.log(`Raw OCR text (${label}):`, ocrText);

    let sizes = extractSizesFromTableWords(result?.data);
    console.log(`Table parser result (${label}):`, sizes);

    if (sizes.length === 0 && ocrText.trim()) {
      console.log(`Table parser found no sizes (${label}), falling back to line-based parser...`);
      sizes = parseSizeGuideText(ocrText);
      console.log(`Line parser result (${label}):`, sizes);
    }

    return {
      sizes,
      score: scoreParsedSizes(sizes),
    };
  };

  const result = await Tesseract.recognize(file.buffer, 'eng', {
    logger: (m) => console.log('OCR:', m),
  });
  let bestCandidate = parseFromOcrResult(result, 'original');
  let sizes = bestCandidate.sizes;

  if (sizes.length === 0) {
    console.log('Retrying OCR with preprocessed size guide image...');
    const originalSize = sizeOf(file.buffer);
    const preprocessedBuffer = await sharp(file.buffer)
      .rotate()
      .resize({
        width: Math.max(1200, Math.round((originalSize.width || 0) * 2)),
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .grayscale()
      .normalise()
      .sharpen()
      .threshold(205)
      .png()
      .toBuffer();

    const preprocessedResult = await Tesseract.recognize(preprocessedBuffer, 'eng', {
      logger: (m) => console.log('OCR (preprocessed):', m),
      tessedit_pageseg_mode: 6,
    });
    const preprocessedCandidate = parseFromOcrResult(preprocessedResult, 'preprocessed');
    if (preprocessedCandidate.score > bestCandidate.score) {
      bestCandidate = preprocessedCandidate;
      sizes = preprocessedCandidate.sizes;
    }

    if (sizes.length === 0) {
      const adaptiveBuffer = await sharp(file.buffer)
        .rotate()
        .resize({
          width: Math.max(1400, Math.round((originalSize.width || 0) * 2.3)),
          withoutEnlargement: false,
          kernel: sharp.kernel.lanczos3,
        })
        .grayscale()
        .normalise()
        .sharpen({ sigma: 1.1 })
        .threshold(170)
        .png()
        .toBuffer();

      const adaptiveResult = await Tesseract.recognize(adaptiveBuffer, 'eng', {
        logger: (m) => console.log('OCR (adaptive):', m),
        tessedit_pageseg_mode: 4,
      });
      const adaptiveCandidate = parseFromOcrResult(adaptiveResult, 'adaptive');
      if (adaptiveCandidate.score > bestCandidate.score) {
        bestCandidate = adaptiveCandidate;
        sizes = adaptiveCandidate.sizes;
      }
    }
  }

  if (sizes.length === 0) {
    const inferredLabels = inferSizeLabelsFromText(observedText);
    if (inferredLabels.length > 0) {
      console.log('Detected size labels without reliable numeric associations. Skipping fallback sizes to avoid fabricated entries.', inferredLabels);
    } else {
      console.log('No reliable OCR sizes found. Generating robust fallback size set.');
      sizes = buildFallbackSizes(garmentType, observedText);
    }
  }

  const normalized = normalizeNumericGuideValues(sizes);
  console.log('Final parsed sizes:', normalized);
  return normalized;
}

app.post('/upload-scan', upload.single('model'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No model file uploaded.' });
  }

  const analysis = buildAnalysis(req.file);
  res.json({ success: true, preview: { fileName: analysis.fileName, mimeType: analysis.mimeType }, analysis });
});

app.post('/analyze-image', upload.any(), async (req, res) => {
  console.log('=== /analyze-image endpoint hit ===');
  console.log('req.body:', req.body);
  console.log('req.files:', Array.isArray(req.files) ? req.files.map((file) => `${file.originalname} (${file.size} bytes)`) : 'No files');
  
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  if (uploadedFiles.length === 0) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    const primaryFile = uploadedFiles[0];
    const analysis = buildAnalysis(primaryFile);
    console.log('Image type:', req.body.type);
    
    let sizes = [];
    let processedImageUrl = null;
    let cutout = null;
    let analyses = [analysis];
    let sizeGuideEntries = [];
    let rawSizeEntries = [];
    
    if (req.body.type === 'sizeGuide') {
      console.log('Processing as size guide...');
      sizeGuideEntries = [];

      for (const file of uploadedFiles) {
        const fileAnalysis = buildAnalysis(file);
        const fileSizes = await parseSizeGuideImage(file, req.body.garmentType || '');

        sizeGuideEntries.push({
          analysis: fileAnalysis,
          sizes: fileSizes,
        });

        rawSizeEntries.push(
          ...fileSizes.map((size) => ({
            ...size,
            sourceFile: fileAnalysis.fileName,
          })),
        );
      }

      analyses = sizeGuideEntries.map((entry) => entry.analysis);
      // Keep all parsed measurement rows so each size can carry multiple measurements.
      sizes = sortSizes(
        rawSizeEntries.map((entry) => ({
          ...entry,
          label: entry.sizeLabel || entry.label,
        })),
      );
      console.log('Size guide processing complete. Sizes:', sizes);
    } else if (req.body.type === 'clothing') {
      console.log('Processing as clothing 3D garment model...');
      const garmentResult = await createGarment3DModel(primaryFile.buffer, req.body.garmentType, primaryFile.mimetype);
      processedImageUrl = garmentResult.pngDataUrl;
      cutout = garmentResult.cutout;
      console.log('Garment model generation complete:', {
        cutout,
        hasModel: Boolean(garmentResult.garmentModel),
        vertexCount: garmentResult.garmentModel ? Math.floor(garmentResult.garmentModel.positions.length / 3) : 0,
      });
      res.locals.garmentModel = garmentResult.garmentModel;
    } else {
      console.log('Processing as generic image');
    }
    
    console.log('Sending response:', { success: true, analysis, sizes, hasCutout: Boolean(processedImageUrl) });
    res.json({
      success: true,
      analysis,
      analyses: req.body.type === 'sizeGuide' ? analyses : undefined,
      sizeGuideEntries: req.body.type === 'sizeGuide' ? sizeGuideEntries : undefined,
      rawSizeEntries: req.body.type === 'sizeGuide' ? rawSizeEntries : undefined,
      sizes,
      processedImageUrl,
      cutout,
      garmentModel: req.body.type === 'clothing' ? (res.locals.garmentModel || null) : undefined,
    });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
