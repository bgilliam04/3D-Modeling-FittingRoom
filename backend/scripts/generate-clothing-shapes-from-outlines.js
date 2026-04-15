const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_OUTLINES_DIR = path.join(__dirname, '..', 'clothing-outline-pngs');
const DEFAULT_SHAPES_PATH = path.join(__dirname, '..', 'clothing-shapes.json');

const ALPHA_THRESHOLD = 16;
const WHITE_THRESHOLD = 245;
const TEMPLATE_ROW_SAMPLES = 24;
const WIDTH_PROFILE_BINS = 10;
const ROW_SEARCH_RADIUS = 3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 4) {
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function isForegroundPixel(raw, offset, hasAlpha) {
  const r = raw[offset];
  const g = raw[offset + 1];
  const b = raw[offset + 2];
  const a = raw[offset + 3];

  if (hasAlpha) {
    return a >= ALPHA_THRESHOLD;
  }

  return !(r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD);
}

function findForegroundBounds(raw, width, height, hasAlpha) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!isForegroundPixel(raw, offset, hasAlpha)) continue;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function findRowSpan(raw, width, y, minX, maxX, hasAlpha) {
  let left = -1;
  let right = -1;

  for (let x = minX; x <= maxX; x += 1) {
    const offset = (y * width + x) * 4;
    if (!isForegroundPixel(raw, offset, hasAlpha)) continue;
    left = x;
    break;
  }

  if (left === -1) return null;

  for (let x = maxX; x >= minX; x -= 1) {
    const offset = (y * width + x) * 4;
    if (!isForegroundPixel(raw, offset, hasAlpha)) continue;
    right = x;
    break;
  }

  if (right < left) return null;
  return { left, right };
}

function findNearestSpan(raw, width, height, yBase, bounds, hasAlpha) {
  const { minX, maxX } = bounds;
  const yStart = clamp(Math.round(yBase), 0, height - 1);

  for (let delta = 0; delta <= ROW_SEARCH_RADIUS; delta += 1) {
    const candidates = delta === 0 ? [yStart] : [yStart - delta, yStart + delta];
    for (const y of candidates) {
      if (y < 0 || y >= height) continue;
      const span = findRowSpan(raw, width, y, minX, maxX, hasAlpha);
      if (span) {
        return { y, ...span };
      }
    }
  }

  return null;
}

function extractTemplateFromOutline(filePath) {
  return sharp(filePath)
    .metadata()
    .then((meta) => {
      const hasAlpha = Boolean(meta.hasAlpha);
      return sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => {
          const { width, height } = info;
          const bounds = findForegroundBounds(data, width, height, hasAlpha);
          if (!bounds) return null;

          const boxWidth = bounds.maxX - bounds.minX + 1;
          const boxHeight = bounds.maxY - bounds.minY + 1;
          if (boxWidth < 3 || boxHeight < 3) return null;

          const leftSide = [];
          const rightSide = [];
          const widthByY = [];

          for (let i = 0; i < TEMPLATE_ROW_SAMPLES; i += 1) {
            const yNorm = TEMPLATE_ROW_SAMPLES === 1 ? 0 : i / (TEMPLATE_ROW_SAMPLES - 1);
            const yPixel = bounds.minY + yNorm * (boxHeight - 1);
            const span = findNearestSpan(data, width, height, yPixel, bounds, hasAlpha);
            if (!span) continue;

            const normalizedY = clamp((span.y - bounds.minY) / Math.max(1, boxHeight - 1), 0, 1);
            const normalizedLeftX = clamp((span.left - bounds.minX) / Math.max(1, boxWidth - 1), 0, 1);
            const normalizedRightX = clamp((span.right - bounds.minX) / Math.max(1, boxWidth - 1), 0, 1);
            const normalizedWidth = clamp(normalizedRightX - normalizedLeftX, 0, 1);

            leftSide.push([round(normalizedLeftX, 4), round(normalizedY, 4)]);
            rightSide.push([round(normalizedRightX, 4), round(normalizedY, 4)]);
            widthByY.push({ y: normalizedY, width: normalizedWidth });
          }

          const polygon = leftSide.concat([...rightSide].reverse());
          if (polygon.length < 6) return null;

          return {
            template: polygon,
            widthByY,
            sourceFile: path.basename(filePath),
          };
        });
    });
}

function listPngFilesRecursive(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPngFilesRecursive(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      files.push(fullPath);
    }
  }

  return files;
}

function buildWidthProfile(templates) {
  const bins = [];
  for (let i = 0; i < WIDTH_PROFILE_BINS; i += 1) {
    const y = WIDTH_PROFILE_BINS === 1 ? 0 : i / (WIDTH_PROFILE_BINS - 1);
    const widths = [];

    for (const item of templates) {
      if (!item.widthByY.length) continue;
      let best = item.widthByY[0];
      let bestDist = Math.abs(best.y - y);
      for (let j = 1; j < item.widthByY.length; j += 1) {
        const candidate = item.widthByY[j];
        const dist = Math.abs(candidate.y - y);
        if (dist < bestDist) {
          best = candidate;
          bestDist = dist;
        }
      }
      if (bestDist <= 0.08) {
        widths.push(best.width);
      }
    }

    const meanWidth = widths.length
      ? widths.reduce((sum, widthValue) => sum + widthValue, 0) / widths.length
      : 0;

    bins.push({
      y: round(y, 3),
      meanWidth: round(meanWidth, 3),
      sampleCount: widths.length,
    });
  }

  return bins;
}

async function generateFromOutlines(outlinesDir, shapesPath) {
  const shapeData = fs.existsSync(shapesPath)
    ? JSON.parse(fs.readFileSync(shapesPath, 'utf8'))
    : {};

  if (!fs.existsSync(outlinesDir)) {
    throw new Error(`Outlines directory not found: ${outlinesDir}`);
  }

  const garmentDirs = fs
    .readdirSync(outlinesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const summary = [];

  for (const garment of garmentDirs) {
    const garmentPath = path.join(outlinesDir, garment);
    const pngFiles = listPngFilesRecursive(garmentPath);
    if (!pngFiles.length) {
      continue;
    }

    const extracted = [];
    for (const filePath of pngFiles) {
      const template = await extractTemplateFromOutline(filePath);
      if (template) {
        extracted.push(template);
      }
    }

    if (!extracted.length) {
      continue;
    }

    const garmentKey = garment.toLowerCase().trim();
    const existingGarmentData = shapeData[garmentKey] && typeof shapeData[garmentKey] === 'object'
      ? shapeData[garmentKey]
      : {};

    shapeData[garmentKey] = {
      ...existingGarmentData,
      shapeOutlines: {
        templateCount: extracted.length,
        templates: extracted.map((item) => item.template),
        widthProfile: buildWidthProfile(extracted),
        sourceFolder: path.relative(path.dirname(shapesPath), garmentPath).replace(/\\/g, '/'),
        sourceFiles: extracted.map((item) => item.sourceFile),
      },
    };

    summary.push({ garment: garmentKey, files: pngFiles.length, templates: extracted.length });
  }

  shapeData._meta = {
    ...(shapeData._meta && typeof shapeData._meta === 'object' ? shapeData._meta : {}),
    generatedAt: new Date().toISOString(),
    generator: 'generate-clothing-shapes-from-outlines',
    outlinesDir: path.relative(path.dirname(shapesPath), outlinesDir).replace(/\\/g, '/'),
    garmentsFromOutlinePngs: summary.map((item) => item.garment),
  };

  fs.writeFileSync(shapesPath, `${JSON.stringify(shapeData, null, 2)}\n`);
  return summary;
}

async function main() {
  const outlinesDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUTLINES_DIR;
  const shapesPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : DEFAULT_SHAPES_PATH;

  const summary = await generateFromOutlines(outlinesDir, shapesPath);
  const templateCount = summary.reduce((sum, item) => sum + item.templates, 0);
  console.log(`Updated ${shapesPath}`);
  console.log(`Garments: ${summary.length}, templates: ${templateCount}`);
  for (const row of summary) {
    console.log(`- ${row.garment}: ${row.templates} templates from ${row.files} png files`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
