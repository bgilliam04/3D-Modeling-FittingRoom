const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sizeOf = require('image-size');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { removeBackground } = require('@imgly/background-removal-node');

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

function dedupeSizes(sizes) {
  const uniqueSizes = [];
  const seenLabels = new Set();

  for (const size of sizes || []) {
    if (!size || typeof size.value === 'undefined' || !size.label) {
      continue;
    }

    const labelKey = normalizeSizeLabel(size.label);
    if (!labelKey || seenLabels.has(labelKey)) {
      continue;
    }

    seenLabels.add(labelKey);
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

function isSkinTonePixel(red, green, blue) {
  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  const chroma = maxChannel - minChannel;

  if (red < 85 || green < 35 || blue < 15) return false;
  if (chroma < 10) return false;
  if (Math.abs(red - green) < 12) return false;
  if (red <= green || red <= blue) return false;

  const saturation = maxChannel === 0 ? 0 : chroma / maxChannel;
  return saturation > 0.08;
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

  // Harden the matte so low-confidence background haze becomes transparent.
  const alphaThreshold = 96;
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

  const keepMask = selectMainComponent(mask, centerX, centerY);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (keepMask[index]) continue;
      const offset = index * channels;
      data[offset + 3] = 0;
    }
  }

  // Remove attached wearer skin clusters (hands/arms/neck/legs) from all garment masks.
  {
    const skinMask = new Uint8Array(width * height);
    const lowerBodyGarments = new Set(['skirt', 'pants', 'shorts']);
    const skipLowerBand = lowerBodyGarments.has(garmentType);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!keepMask[index]) continue;

        const offset = index * channels;
        if (data[offset + 3] === 0) continue;

        // For lower-body garments, preserve a small bottom band to reduce hem clipping.
        if (skipLowerBand && y > Math.round(height * 0.9)) continue;

        if (isSkinTonePixel(data[offset], data[offset + 1], data[offset + 2])) {
          skinMask[index] = 1;
        }
      }
    }

    // Expand the mask so connected skin-adjacent edges are removed too.
    const expansionPasses = 2;
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
  }

  // Second pass: trim weak alpha remnants then keep the strongest remaining component again.
  const secondPassAlphaThreshold = 144;
  const secondMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;

      if (!keepMask[index] || data[offset + 3] < secondPassAlphaThreshold) {
        data[offset + 3] = 0;
        continue;
      }

      secondMask[index] = 1;
    }
  }

  const secondKeepMask = selectMainComponent(secondMask, centerX, centerY);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (secondKeepMask[index]) continue;
      const offset = index * channels;
      data[offset + 3] = 0;
    }
  }

  // Garment-only hardening: remove remaining border-connected foreground.
  // For lower-body garments, keep bottom-connected pixels to avoid clipping skirt hems.
  const lowerBodyGarments = new Set(['skirt', 'pants', 'shorts']);
  const preserveBottomEdge = lowerBodyGarments.has(garmentType);
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

  const borderCleanMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      if (data[offset + 3] === 0 || borderConnected[index]) {
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

  const refined = new RawImage(data, width, height, 4);
  return {
    image: refined,
    bounds: findAlphaBounds(refined),
  };
}

async function createGarmentCutout(buffer, garmentType = 'shirt', mimeType = '') {
  const normalizedGarmentType = normalizeGarmentType(garmentType);
  const orientedBuffer = await sharp(buffer).rotate().png().toBuffer();
  const orientedPngBlob = new Blob([orientedBuffer], { type: 'image/png' });

  const outputBlob = await removeBackground(orientedPngBlob, {
    model: 'small',
    output: {
      quality: 0.8,
      format: 'image/png',
      type: 'foreground',
    },
  });

  const outputArrayBuffer = await outputBlob.arrayBuffer();
  const cutoutBuffer = Buffer.from(outputArrayBuffer);
  let finalBuffer = cutoutBuffer;
  let cutoutInfo = await sharp(cutoutBuffer).metadata();
  let offsetX = 0;
  let offsetY = 0;

  try {
    const cutoutRawImage = await rawImageFromBuffer(cutoutBuffer, 'image/png');
    const refined = refineCutoutMask(cutoutRawImage, normalizedGarmentType);

    if (refined && refined.image) {
      const refinedPngBuffer = await rawImageToPngBuffer(refined.image);
      if (refined.bounds && refined.bounds.width > 0 && refined.bounds.height > 0) {
        finalBuffer = await sharp(refinedPngBuffer)
          .extract({
            left: refined.bounds.left,
            top: refined.bounds.top,
            width: refined.bounds.width,
            height: refined.bounds.height,
          })
          .png()
          .toBuffer();
        offsetX = refined.bounds.left;
        offsetY = refined.bounds.top;
      } else {
        finalBuffer = refinedPngBuffer;
      }

      cutoutInfo = await sharp(finalBuffer).metadata();
    }
  } catch (error) {
    console.warn('Cutout refinement failed, using raw background-removal output:', error.message);
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

  return repaired;
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

  let headerRowIndex = -1;
  let headerLabels = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sizeTokens = row.tokens.filter((token) => isSizeLabelToken(token.text));
    const hasSizeWord = row.tokens.some((token) => token.text === 'SIZE');

    if (sizeTokens.length >= 3 || (hasSizeWord && sizeTokens.length >= 1)) {
      headerRowIndex = index;
      const firstContentIndex = row.tokens.findIndex((token) => {
        if (isSizeLabelToken(token.text) || parseNumericValueFromToken(token.text) !== null) {
          return true;
        }

        return String(token.text || '').trim().length === 1;
      });

      headerLabels = firstContentIndex === -1 ? sizeTokens : row.tokens.slice(firstContentIndex);
      break;
    }
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
    if (sizeTokens.length >= Math.max(2, Math.floor(headerColumns.length * 0.6))) {
      depictionRowCount += 1;
    } else {
      break;
    }
  }

  let measurementRow = null;
  const measurementKeywords = ['CHEST', 'BUST', 'WAIST', 'BODY', 'WIDTH', 'LENGTH', 'HIP', 'INSEAM'];
  const measurementSearchStart = headerRowIndex + depictionRowCount;

  for (let index = measurementSearchStart; index < rows.length; index += 1) {
    const row = rows[index];
    const rowText = row.tokens.map((token) => token.text).join(' ');
    const hasKeyword = measurementKeywords.some((keyword) => rowText.includes(keyword));
    const numericTokenCount = row.tokens.filter((token) => parseNumericValueFromToken(token.text) !== null).length;

    if (hasKeyword && numericTokenCount >= 2) {
      measurementRow = row;
      break;
    }
  }

  if (!measurementRow) {
    for (let index = measurementSearchStart; index < rows.length; index += 1) {
      const row = rows[index];
      const numericTokenCount = row.tokens.filter((token) => parseNumericValueFromToken(token.text) !== null).length;
      if (numericTokenCount >= 2) {
        measurementRow = row;
        break;
      }
    }
  }

  if (!measurementRow) {
    return [];
  }

  const numericCells = measurementRow.tokens
    .map((token) => ({ x: token.cx, value: parseNumericValueFromToken(token.text) }))
    .filter((token) => Number.isFinite(token.value));

  if (numericCells.length === 0) {
    return [];
  }

  const mapLabelsToValues = (labelTokens) => {
    const mapped = [];

    for (const labelToken of labelTokens) {
      const label = normalizeSizeLabel(labelToken.text || labelToken.label);
      const x = typeof labelToken.x === 'number' ? labelToken.x : labelToken.cx;
      if (!label || typeof x !== 'number') {
        continue;
      }

      let nearest = null;
      let nearestDistance = Infinity;
      for (const numericCell of numericCells) {
        const distance = Math.abs(numericCell.x - x);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = numericCell;
        }
      }

      if (nearest) {
        mapped.push({ label, value: nearest.value });
      }
    }

    return mapped;
  };

  return mapLabelsToValues(headerColumns);
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

    labelPattern.lastIndex = 0;
    let labelMatch;

    while ((labelMatch = labelPattern.exec(normalizedLine)) !== null) {
      const label = normalizeSizeLabel(labelMatch[1]);
      if (seenLabels.has(label)) {
        continue;
      }

      const labelStart = labelMatch.index;
      const labelEnd = labelStart + labelMatch[0].length;
      let matchedValue = null;
      let bestDistance = Infinity;

      numberPattern.lastIndex = 0;
      let numberMatch;

      while ((numberMatch = numberPattern.exec(line)) !== null) {
        const value = parseFloat(numberMatch[1]);
        if (!Number.isFinite(value) || value <= 0 || value > 1000) {
          continue;
        }

        const numberStart = numberMatch.index;
        const numberEnd = numberStart + numberMatch[0].length;
        if (numberStart >= labelStart && numberEnd <= labelEnd) {
          continue;
        }

        const distance = numberStart >= labelEnd ? numberStart - labelEnd : labelStart - numberEnd;
        if (distance < bestDistance) {
          bestDistance = distance;
          matchedValue = value;
        }
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
    console.log('No reliable OCR sizes found. Generating robust fallback size set.');
    sizes = buildFallbackSizes(garmentType, observedText);
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
      sizes = sortSizes(dedupeSizes(rawSizeEntries));
      console.log('Size guide processing complete. Sizes:', sizes);
    } else if (req.body.type === 'clothing') {
      console.log('Processing as clothing cutout...');
      const cutoutResult = await createGarmentCutout(primaryFile.buffer, req.body.garmentType, primaryFile.mimetype);
      processedImageUrl = cutoutResult.pngDataUrl;
      cutout = cutoutResult.cutout;
      console.log('Clothing cutout complete:', cutout);
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
    });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
