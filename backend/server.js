const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sizeOf = require('image-size');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { pipeline, RawImage } = require('@huggingface/transformers');

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
  const lowerBodyGarments = new Set(['skirt', 'pants', 'shorts']);

  let bestDetection = null;
  let bestScore = -Infinity;

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

    // Skirt-specific hard filters to avoid selecting bracelets/arms.
    if (garmentType === 'skirt') {
      const isTooSmall = areaRatio < 0.08 || heightRatio < 0.18;
      const isTooHigh = yNormalized < 0.48;
      const isTooSkinHeavy = skinRatio > 0.42;
      const hasAccessoryLikeShape = aspectRatio > 3.2 || aspectRatio < 0.28;

      if (isTooSmall || isTooHigh || isTooSkinHeavy || hasAccessoryLikeShape) {
        continue;
      }
    }

    const baseScore = Math.max(0.01, detection.score);
    const areaWeight = Math.max(0.2, Math.min(2.5, areaRatio * 6));
    const centerWeight = Math.max(0.2, 1 - centerDistance * 0.8);
    const skinWeight = Math.max(0.05, 1 - skinRatio * 0.9);

    let garmentSpecificWeight = 1;
    if (lowerBodyGarments.has(garmentType)) {
      const lowerBodyWeight = yNormalized < 0.45 ? 0.2 : Math.min(1.4, 0.6 + yNormalized);
      const minAreaWeight = areaRatio < 0.06 ? 0.15 : 1;
      garmentSpecificWeight *= lowerBodyWeight * minAreaWeight;
    }

    const combinedScore = baseScore * areaWeight * centerWeight * skinWeight * garmentSpecificWeight;
    if (combinedScore > bestScore) {
      bestScore = combinedScore;
      bestDetection = {
        ...detection,
        box: { xmin: left, ymin: top, xmax: right, ymax: bottom },
      };
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

  // Skirt-specific cleanup: remove attached hand/arm regions by stripping skin-like clusters.
  if (garmentType === 'skirt') {
    const skinMask = new Uint8Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!keepMask[index]) continue;

        const offset = index * channels;
        if (data[offset + 3] === 0) continue;

        // Skirt hands are most often near upper/mid garment area; avoid over-trimming lower hem.
        if (y > Math.round(height * 0.8)) continue;

        if (isSkinTonePixel(data[offset], data[offset + 1], data[offset + 2])) {
          skinMask[index] = 1;
        }
      }
    }

    // Expand the mask so connected bracelet/arm edges are removed with the skin pixels.
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
  const candidateLabels = getCandidateLabelsForGarment(normalizedGarmentType);

  try {
    const orientedBuffer = await sharp(buffer).rotate().png().toBuffer();
    const image = await rawImageFromBuffer(orientedBuffer, 'image/png');
    const orientedRaw = await sharp(orientedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const detector = await getGarmentDetector();
    const detections = await detector(image, candidateLabels, { threshold: 0.08, top_k: 5 });

    if (!detections || detections.length === 0) {
      throw new Error('No garment detected.');
    }

    const bestDetection = selectBestGarmentDetection(
      detections,
      normalizedGarmentType,
      orientedRaw.info.width,
      orientedRaw.info.height,
      orientedRaw.data,
      orientedRaw.info.channels
    );

    if (!bestDetection) {
      throw new Error('No garment bounding box found.');
    }

    const { xmin, ymin, xmax, ymax } = bestDetection.box;
    const left = Math.max(0, Math.floor(xmin));
    const top = Math.max(0, Math.floor(ymin));
    const right = Math.min(image.width - 1, Math.ceil(xmax));
    const bottom = Math.min(image.height - 1, Math.ceil(ymax));

    if (right <= left || bottom <= top) {
      throw new Error('Invalid garment detection bounds.');
    }

    const boxWidth = right - left + 1;
    const boxHeight = bottom - top + 1;
    const lowerBodyGarments = new Set(['skirt', 'pants', 'shorts']);
    const isLowerBodyGarment = lowerBodyGarments.has(normalizedGarmentType);

    // Lower-body garments often get partial boxes; expand asymmetrically to include the full garment.
    const paddingX = Math.max(8, Math.round(boxWidth * (isLowerBodyGarment ? 0.26 : 0.12)));
    const topPadding = Math.max(8, Math.round(boxHeight * (isLowerBodyGarment ? 0.32 : 0.12)));
    const bottomPadding = Math.max(8, Math.round(boxHeight * (isLowerBodyGarment ? 0.95 : 0.12)));

    const cropLeft = Math.max(0, left - paddingX);
    const cropTop = Math.max(0, top - topPadding);
    const cropRight = Math.min(image.width - 1, right + paddingX);
    const cropBottom = Math.min(image.height - 1, bottom + bottomPadding);
    const cropWidth = cropRight - cropLeft + 1;
    const cropHeight = cropBottom - cropTop + 1;

    const croppedBuffer = await sharp(orientedBuffer)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    const croppedImage = await rawImageFromBuffer(croppedBuffer, 'image/png');
    const backgroundRemover = await getBackgroundRemover();
    const cutoutImage = await backgroundRemover(croppedImage);
    const refinedResult = refineCutoutMask(cutoutImage, normalizedGarmentType);
    const alphaBounds = refinedResult.bounds;

    if (!alphaBounds) {
      // Never return a raw crop when no garment mask exists.
      return createHeuristicGarmentCutout(croppedBuffer);
    }

    const cutoutBuffer = await sharp(Buffer.from(refinedResult.image.data), {
      raw: {
        width: refinedResult.image.width,
        height: refinedResult.image.height,
        channels: refinedResult.image.channels,
      },
    })
      .extract(alphaBounds)
      .png()
      .toBuffer();

    return {
      pngDataUrl: `data:image/png;base64,${cutoutBuffer.toString('base64')}`,
      cutout: {
        width: alphaBounds.width,
        height: alphaBounds.height,
        offsetX: cropLeft + alphaBounds.left,
        offsetY: cropTop + alphaBounds.top,
      },
    };
  } catch (error) {
    console.warn('Model-based garment cutout failed, falling back to heuristic cutout:', error.message);
    return createHeuristicGarmentCutout(buffer);
  }
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
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    const fallbackSize = sizeOf(fallbackPngBuffer);
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width: fallbackSize.width || width,
        height: fallbackSize.height || height,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  components.sort((a, b) => b.score - a.score || b.area - a.area);
  const selected = components[0];
  const selectedMask = new Uint8Array(width * height);

  for (const pixelIndex of selected.pixels) {
    selectedMask[pixelIndex] = 1;
  }

  if (selected.pixels.length === 0) {
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    const fallbackSize = sizeOf(fallbackPngBuffer);
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width: fallbackSize.width || width,
        height: fallbackSize.height || height,
        offsetX: 0,
        offsetY: 0,
      },
    };
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
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    const fallbackSize = sizeOf(fallbackPngBuffer);
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width: fallbackSize.width || width,
        height: fallbackSize.height || height,
        offsetX: 0,
        offsetY: 0,
      },
    };
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
    const fallbackPngBuffer = await sharp(buffer).rotate().png().toBuffer();
    const fallbackSize = sizeOf(fallbackPngBuffer);
    return {
      pngDataUrl: `data:image/png;base64,${fallbackPngBuffer.toString('base64')}`,
      cutout: {
        width: fallbackSize.width || width,
        height: fallbackSize.height || height,
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
    let cutout = null;
    
    if (req.body.type === 'sizeGuide') {
      console.log('Processing as size guide...');
      sizes = await parseSizeGuideImage(req.file);
      console.log('Size guide processing complete. Sizes:', sizes);
    } else if (req.body.type === 'clothing') {
      console.log('Processing as clothing cutout...');
      const cutoutResult = await createGarmentCutout(req.file.buffer, req.body.garmentType, req.file.mimetype);
      processedImageUrl = cutoutResult.pngDataUrl;
      cutout = cutoutResult.cutout;
      console.log('Clothing cutout complete:', cutout);
    } else {
      console.log('Processing as generic image');
    }
    
    console.log('Sending response:', { success: true, analysis, sizes, hasCutout: Boolean(processedImageUrl) });
    res.json({ success: true, analysis, sizes, processedImageUrl, cutout });
  } catch (error) {
    console.error('Image analysis failed:', error);
    res.status(500).json({ error: 'Failed to analyze image.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FittingRoom backend listening on http://localhost:${PORT}`);
});
