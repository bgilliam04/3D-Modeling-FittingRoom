const navToggle = document.getElementById('navToggle');
const siteNav = document.getElementById('siteNav');
const contactForm = document.getElementById('contactForm');
const formStatus = document.getElementById('formStatus');
const themeSwitcher = document.getElementById('themeSwitcher');

if (themeSwitcher) {
  themeSwitcher.addEventListener('change', (e) => {
    document.body.className = e.target.value;
  });
}

if (navToggle && siteNav) {
  navToggle.addEventListener('click', () => {
    siteNav.classList.toggle('open');
  });
}

if (contactForm) {
  contactForm.addEventListener('submit', (event) => {
    event.preventDefault();
    formStatus.textContent = 'Thank you! Your request has been received.';
    contactForm.reset();
  });
}

const anchors = document.querySelectorAll('a[href^="#"]');
anchors.forEach((anchor) => {
  anchor.addEventListener('click', (event) => {
    const targetId = anchor.getAttribute('href').slice(1);
    const target = document.getElementById(targetId);
    if (target) {
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (siteNav.classList.contains('open')) {
        siteNav.classList.remove('open');
      }
    }
  });
});

const scanUpload = document.getElementById('scanUpload');
const clothingUpload = document.getElementById('clothingUpload');
const garmentTypeSelect = document.getElementById('garmentTypeSelect');
const sizeGuideUpload = document.getElementById('sizeGuideUpload');
const modelHeightFeetInput = document.getElementById('modelHeightFeetInput');
const modelHeightInchesInput = document.getElementById('modelHeightInchesInput');
const analyzeButton = document.getElementById('analyzeButton');
const analysisResults = document.getElementById('analysisResults');
const analyzeStatus = document.getElementById('analyzeStatus');
const modelContainer = document.getElementById('modelContainer');
const clothingOverlay = document.getElementById('clothingOverlay');
const sizeButtons = document.getElementById('sizeButtons');
const previewHint = document.getElementById('previewHint');
const BACKEND_URL = 'http://localhost:4000';
const THREE_LIB = window.THREE || window.three || null;

if (!THREE_LIB) {
  console.error('Three.js was not found on window. Check CDN script loading order in index.html.');
  if (typeof analyzeStatus !== 'undefined' && analyzeStatus) {
    analyzeStatus.textContent = '3D engine failed to load (Three.js missing). Please refresh the page.';
  }
}

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let currentModel = null;
let generatedGarmentMesh = null;
let generatedGarmentBaseScale = 1;
let clothingPreviewJobId = 0;
let currentClothingSizeValue = null;
let currentGarmentCutout = null;
let cachedClothingAnalysisKey = null;
let cachedClothingResult = null;
let debugPanel = null;
let currentClothingSizeLabel = null;
let currentSizeRepresentativeMeasurementType = null;
let modelMeasurementCalibration = null;
let measurementPixelMap = {};
let sizeToMeasurementsMap = {};
let previewRaycaster = null;
let previewPointer = null;
let isDraggingPreviewGarment = false;
let previewDragPlane = null;
let previewDragOffset = null;

function getSizeGuideScaleMultiplier() {
  const numericSize = Number(currentClothingSizeValue);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return 1;
  }

  // Check if this is a length measurement (should not be doubled)
  if (isLengthMeasurement(currentSizeRepresentativeMeasurementType)) {
    // Length measurements are already accurate; use directly without doubling
    const referenceLengthInches = 28;
    return Math.max(0.55, Math.min(1.85, numericSize / referenceLengthInches));
  }

  // Size-guide values for circumferences are interpreted as one-sided measurements.
  // Convert to full body circumference estimate before scaling.
  const fullCircumferenceInches = numericSize * 2;
  const referenceCircumferenceInches = 40;
  return Math.max(0.55, Math.min(1.85, fullCircumferenceInches / referenceCircumferenceInches));
}

function isLengthMeasurement(label) {
  // Check if a size label indicates a linear/length measurement rather than circumference
  // Note: "width" is treated as a circumference measurement, not length
  if (!label) return false;
  const normalizedLabel = String(label).toUpperCase();
  const lengthKeywords = ['LENGTH', 'INSEAM', 'SHOULDER', 'SLEEVE', 'RISE', 'CHEST HEIGHT', 'HIP HEIGHT'];
  const circumferenceKeywords = ['WIDTH', 'CHEST', 'BUST', 'WAIST', 'HIP'];
  
  // If it's explicitly a circumference keyword, it's not a length measurement
  if (circumferenceKeywords.some((keyword) => normalizedLabel.includes(keyword))) {
    return false;
  }
  
  return lengthKeywords.some((keyword) => normalizedLabel.includes(keyword));
}

function getCircumferenceMeasurementMultiplier(label) {
  // Only explicit flat/half-width style measurements should be doubled.
  // Circumference-like labels (WAIST/CHEST/HIP/BUST) are already full values.
  if (!label) return 1;
  const normalizedLabel = String(label).toUpperCase();
  const flatKeywords = ['WIDTH', 'HALF', 'ACROSS'];
  return flatKeywords.some((keyword) => normalizedLabel.includes(keyword)) ? 2 : 1;
}

function getMeasurementZoneAndType(label) {
  // Determine which part of the garment a measurement affects and whether it's length or circumference
  if (!label) return { zone: 'full', isLength: false, zoneStart: 0, zoneEnd: 1 };
  
  const normalized = String(label).toUpperCase();
  const isLength = isLengthMeasurement(label);
  
  // Zone: 0 = top, 1 = bottom. Define ranges for different measurements.
  if (normalized.includes('SHOULDER') || normalized.includes('NECK')) {
    return { zone: 'shoulder', isLength, zoneStart: 0.85, zoneEnd: 1.0 };
  }
  if (normalized.includes('CHEST') || normalized.includes('BUST')) {
    return { zone: 'chest', isLength, zoneStart: 0.7, zoneEnd: 0.88 };
  }
  if (normalized.includes('WAIST')) {
    return { zone: 'waist', isLength, zoneStart: 0.4, zoneEnd: 0.6 };
  }
  if (normalized.includes('HIP')) {
    return { zone: 'hip', isLength, zoneStart: 0.15, zoneEnd: 0.4 };
  }
  if (normalized.includes('SLEEVE') || normalized.includes('ARMHOLE')) {
    return { zone: 'sleeve', isLength, zoneStart: 0.5, zoneEnd: 1.0 };
  }
  if (normalized.includes('INSEAM') || normalized.includes('RISE')) {
    return { zone: 'inseam', isLength, zoneStart: 0.0, zoneEnd: 1.0 };
  }
  if (normalized.includes('LENGTH')) {
    return { zone: 'length', isLength, zoneStart: 0.0, zoneEnd: 1.0 };
  }
  
  return { zone: 'full', isLength, zoneStart: 0, zoneEnd: 1 };
}

function applyMeasurementSpecificDeformation(mesh, sizeValue, label, pixelValue) {
  // Apply targeted deformations using pre-computed pixel values for consistent measurement application
  if (!mesh || !sizeValue || !THREE_LIB) return;
  
  const isLength = isLengthMeasurement(label);
  const zone = getMeasurementZoneAndType(label);
  
  // Use the pre-computed pixel value; fallback to inch calculation if not provided
  let targetPixels = pixelValue;
  if (!Number.isFinite(targetPixels)) {
    const ppi = getPixelsPerInch();
    targetPixels = sizeValue * ppi;
    if (!isLength) {
      targetPixels = sizeValue * 2 * ppi;  // Circumference is one-sided, so double it
    }
  }
  
  mesh.traverse((child) => {
    if (!child?.isMesh || !child.geometry?.attributes?.position) return;
    
    const positionAttr = child.geometry.attributes.position;
    const source = positionAttr.array;
    if (!source || source.length < 9) return;
    
    // Ensure we have base positions to work from
    if (!child.userData.basePositionArray || child.userData.basePositionArray.length !== source.length) {
      child.userData.basePositionArray = Float32Array.from(source);
      const baseBounds = new THREE_LIB.Box3().setFromBufferAttribute(positionAttr);
      child.userData.baseBounds = {
        minX: baseBounds.min.x,
        minY: baseBounds.min.y,
        minZ: baseBounds.min.z,
        maxX: baseBounds.max.x,
        maxY: baseBounds.max.y,
        maxZ: baseBounds.max.z,
      };
    }
    
    const base = child.userData.basePositionArray;
    const bounds = child.userData.baseBounds;
    if (!bounds) return;
    
    const height = Math.max(0.0001, bounds.maxY - bounds.minY);
    const width = Math.max(0.0001, bounds.maxX - bounds.minX);
    const depth = Math.max(0.0001, bounds.maxZ - bounds.minZ);
    const midX = (bounds.minX + bounds.maxX) * 0.5;
    const midY = (bounds.minY + bounds.maxY) * 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
    
    // Calculate deformation factors based on pre-computed pixel values
    let circumferenceScale = 1;
    if (!isLength) {
      // For circumference: compare target pixels to reference (40 inch = 40 * 2 * ppi pixels)
      const ppi = modelMeasurementCalibration?.modelUnitsPerInch || getPixelsPerInch();
      const referencePixels = 40 * 2 * ppi;  // Full 40-inch circumference in pixels
      circumferenceScale = Math.max(0.5, Math.min(2.0, targetPixels / referencePixels));
    }
    
    let lengthDelta = 0;
    if (isLength) {
      // For length, compute delta from the target pixel height
      const baseLengthPixels = height;
      const minLengthPixels = baseLengthPixels * 0.55;
      const maxLengthPixels = baseLengthPixels * 1.95;
      const clampedTargetPixels = Math.max(minLengthPixels, Math.min(maxLengthPixels, targetPixels));
      lengthDelta = clampedTargetPixels - baseLengthPixels;
    }
    
    for (let i = 0; i < base.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const z = base[i + 2];
      
      const yNorm01 = (y - bounds.minY) / height;
      
      // Check if this vertex is in the affected zone
      const inZone = yNorm01 >= zone.zoneStart && yNorm01 <= zone.zoneEnd;
      
      if (inZone) {
        if (!isLength) {
          // Circumference deformation: scale X and Z uniformly around center
          const xOffset = x - midX;
          const zOffset = z - midZ;
          source[i] = midX + xOffset * circumferenceScale;
          source[i + 2] = midZ + zOffset * circumferenceScale;
          source[i + 1] = y; // Keep Y unchanged for circumference
        } else {
          // Length deformation: extend from bottom, keep top anchored
          // Pixels below the top contribute proportionally to the delta
          const topWeight = (bounds.maxY - y) / height;
          source[i + 1] = y - lengthDelta * Math.max(0, Math.min(1, topWeight));
          source[i] = x; // Keep X unchanged
          source[i + 2] = z; // Keep Z unchanged
        }
      } else {
        // Keep vertices outside the zone at their base positions
        source[i] = x;
        source[i + 1] = y;
        source[i + 2] = z;
      }
    }
    
    positionAttr.needsUpdate = true;
    child.geometry.computeVertexNormals();
  });
}

function applyAllMeasurementDeformations(mesh, measurements) {
  // Apply all chart measurements simultaneously to the garment mesh
  // Each measurement affects specific zones of the garment based on its type
  if (!mesh || !measurements || measurements.length === 0 || !THREE_LIB) return;
  
  mesh.traverse((child) => {
    if (!child?.isMesh || !child.geometry?.attributes?.position) return;
    
    const positionAttr = child.geometry.attributes.position;
    const source = positionAttr.array;
    if (!source || source.length < 9) return;
    
    // Ensure we have base positions to work from
    if (!child.userData.basePositionArray || child.userData.basePositionArray.length !== source.length) {
      child.userData.basePositionArray = Float32Array.from(source);
      const baseBounds = new THREE_LIB.Box3().setFromBufferAttribute(positionAttr);
      child.userData.baseBounds = {
        minX: baseBounds.min.x,
        minY: baseBounds.min.y,
        minZ: baseBounds.min.z,
        maxX: baseBounds.max.x,
        maxY: baseBounds.max.y,
        maxZ: baseBounds.max.z,
      };
    }
    
    const base = child.userData.basePositionArray;
    const bounds = child.userData.baseBounds;
    if (!bounds) return;
    
    const height = Math.max(0.0001, bounds.maxY - bounds.minY);
    const width = Math.max(0.0001, bounds.maxX - bounds.minX);
    const depth = Math.max(0.0001, bounds.maxZ - bounds.minZ);
    const midX = (bounds.minX + bounds.maxX) * 0.5;
    const midY = (bounds.minY + bounds.maxY) * 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
    
    // Calculate deformation factors for each measurement
    const deformations = measurements.map((measurement) => {
      const measurementType = measurement.measurementType || measurement.type || measurement.label;
      const sizeLabel = measurement.sizeLabel || currentClothingSizeLabel || '';
      const isLength = isLengthMeasurement(measurementType);
      const zone = getMeasurementZoneAndType(measurementType);
      const pixelValue = getPixelValueForMeasurement(measurementType, measurement.value, sizeLabel);
      
      let circumferenceScale = 1;
      let lengthDelta = 0;
      
      if (!isLength) {
        // pixelValue = inchValue * 2 * ppi (world units, full circumference equivalent).
        // Target flat width in world units = pixelValue / 2.
        // Convert to local units by dividing by current garment base scale.
        // Then compare to the garment's own local half-width so the scale is relative
        // to THIS garment, not a fixed adult-body reference.
        const safeBaseScale = Math.max(0.00001, generatedGarmentBaseScale);
        const targetLocalHalfWidth = (pixelValue / 2) / safeBaseScale;
        const currentLocalHalfWidth = Math.max(0.00001, width / 2);
        circumferenceScale = Math.max(0.3, Math.min(3.0, targetLocalHalfWidth / currentLocalHalfWidth));
      } else {
        // pixelValue = inchValue * ppi (world units).
        // Convert to local units so the delta is in the same space as the vertex positions.
        const safeBaseScale = Math.max(0.00001, generatedGarmentBaseScale);
        const targetLocalHeight = pixelValue / safeBaseScale;
        const baseLengthPixels = height;
        const minLengthPixels = baseLengthPixels * 0.55;
        const maxLengthPixels = baseLengthPixels * 1.95;
        const clampedTargetPixels = Math.max(minLengthPixels, Math.min(maxLengthPixels, targetLocalHeight));
        lengthDelta = clampedTargetPixels - baseLengthPixels;
      }
      
      return {
        isLength,
        zone,
        circumferenceScale,
        lengthDelta,
      };
    });
    
    // Apply all measurements to vertices
    for (let i = 0; i < base.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const z = base[i + 2];
      
      const yNorm01 = (y - bounds.minY) / height;
      let newX = x;
      let newY = y;
      let newZ = z;
      
      // Apply each measurement if this vertex is in its zone
      for (let m = 0; m < measurements.length; m++) {
        const measurement = measurements[m];
        const deform = deformations[m];
        const zone = deform.zone;
        const inZone = yNorm01 >= zone.zoneStart && yNorm01 <= zone.zoneEnd;
        
        if (inZone) {
          if (!deform.isLength) {
            // Circumference deformation: scale X and Z uniformly around center
            const xOffset = newX - midX;
            const zOffset = newZ - midZ;
            newX = midX + xOffset * deform.circumferenceScale;
            newZ = midZ + zOffset * deform.circumferenceScale;
          } else {
            // Length deformation: extend from bottom, keep top anchored
            const topWeight = (bounds.maxY - y) / height;
            newY = y - deform.lengthDelta * Math.max(0, Math.min(1, topWeight));
          }
        }
      }
      
      source[i] = newX;
      source[i + 1] = newY;
      source[i + 2] = newZ;
    }
    
    positionAttr.needsUpdate = true;
    child.geometry.computeVertexNormals();
  });
}

function getSelectedSizeInches() {
  const numericSize = Number(currentClothingSizeValue);
  return Number.isFinite(numericSize) && numericSize > 0 ? numericSize : null;
}

function getModelHeightInches() {
  const feet = Number(modelHeightFeetInput?.value) || 0;
  const inches = Number(modelHeightInchesInput?.value) || 0;
  const totalInches = feet * 12 + inches;
  return Number.isFinite(totalInches) && totalInches > 0 ? totalInches : 68;
}

function getPixelsPerInch() {
  // Calculate pixels (3D units) per inch based on the current model's visual height
  if (!THREE_LIB || !currentModel) {
    return 1; // Default fallback
  }

  const modelBox = new THREE_LIB.Box3().setFromObject(currentModel);
  if (modelBox.isEmpty()) {
    return 1; // Default fallback
  }

  const modelHeightUnits = modelBox.getSize(new THREE_LIB.Vector3()).y;
  const modelHeightInches = getModelHeightInches();
  const ppi = modelHeightUnits / Math.max(1, modelHeightInches);
  
  return ppi;
}

function calibrateMeasurementsForModel() {
  // Compute a single model-level calibration that will be used for all size-guide conversions
  if (!THREE_LIB || !currentModel) {
    modelMeasurementCalibration = null;
    measurementPixelMap = {};
    return;
  }

  const modelHeightInches = getModelHeightInches();
  const modelUnitsPerInch = getPixelsPerInch();

  modelMeasurementCalibration = {
    modelHeightInches,
    modelUnitsPerInch,
    calibratedAt: new Date().toISOString(),
  };

  console.log('Measurement calibration set:', modelMeasurementCalibration);
}

function normalizeMeasurementEntry(entry) {
  if (!entry || !Number.isFinite(Number(entry.value))) {
    return null;
  }

  const rawSizeLabel = entry.sizeLabel || entry.size || entry.size_name || null;
  const rawMeasurementType = entry.measurementType || entry.type || entry.measurement || null;
  const fallbackLabel = entry.label ? String(entry.label).trim() : '';

  const sizeLabel = String(rawSizeLabel || fallbackLabel || '').trim();
  const measurementType = String(rawMeasurementType || fallbackLabel || '').trim();
  const inchValue = Number(entry.value);

  if (!sizeLabel || !measurementType) {
    return null;
  }

  return {
    sizeLabel,
    measurementType,
    value: inchValue,
    sourceFile: entry.sourceFile || null,
  };
}

function convertMeasurementsToPixels(sizeEntries) {
  // Convert all size-guide measurements (in inches) to pixel values using the current model calibration
  if (!modelMeasurementCalibration) {
    calibrateMeasurementsForModel();
  }
  
  if (!modelMeasurementCalibration) {
    return sizeEntries; // Fallback: return unchanged if no calibration
  }

  const { modelUnitsPerInch } = modelMeasurementCalibration;
  const newPixelMap = {};

  for (const rawEntry of sizeEntries || []) {
    const entry = normalizeMeasurementEntry(rawEntry);
    if (!entry) {
      continue;
    }

    const inchValue = entry.value;
    const isLength = isLengthMeasurement(entry.measurementType);
    let pixelValue = inchValue * modelUnitsPerInch;

    // For circumference measurements, convert from one-sided to full circumference
    if (!isLength) {
      pixelValue = inchValue * 2 * modelUnitsPerInch;
    }

    const key = `${entry.sizeLabel}|${entry.measurementType}|${entry.value}`;
    newPixelMap[key] = {
      sizeLabel: entry.sizeLabel,
      measurementType: entry.measurementType,
      inchValue,
      pixelValue,
      isLength,
    };
  }

  measurementPixelMap = newPixelMap;
  return sizeEntries;
}

function getPixelValueForMeasurement(label, inchValue, sizeLabel = '') {
  // Look up the pre-computed pixel value for a measurement
  const sizeTypeKey = `${String(sizeLabel || '').trim()}|${label}|${inchValue}`;
  if (measurementPixelMap[sizeTypeKey]) {
    return measurementPixelMap[sizeTypeKey].pixelValue;
  }

  // Legacy fallback key support
  const legacyKey = `${label}|${inchValue}`;
  if (measurementPixelMap[legacyKey]) {
    return measurementPixelMap[legacyKey].pixelValue;
  }

  // Fallback: compute on-the-fly if not in map
  if (!modelMeasurementCalibration) {
    return inchValue * getPixelsPerInch();
  }
  const { modelUnitsPerInch } = modelMeasurementCalibration;
  const isLength = isLengthMeasurement(label);
  if (isLength) {
    return inchValue * modelUnitsPerInch;
  }
  return inchValue * getCircumferenceMeasurementMultiplier(label) * modelUnitsPerInch;
}

function applyBodyConformingDeformationToGarment(modelSize, fitProfile, sizeGuideScale) {
  if (!generatedGarmentMesh || !THREE_LIB) return;

  const targetHalfWidth = Math.max(0.05, modelSize.x * fitProfile.widthRatio * 0.5 * sizeGuideScale);
  const targetHalfDepth = Math.max(0.025, modelSize.z * (0.16 + 0.06 * sizeGuideScale));
  const verticalScale = Math.max(0.82, Math.min(1.3, 1 + (sizeGuideScale - 1) * 0.28));
  const lowerDrape = Math.max(-0.18, Math.min(0.22, (sizeGuideScale - 1) * 0.14));

  generatedGarmentMesh.traverse?.((child) => {
    if (!child?.isMesh || !child.geometry?.attributes?.position) return;

    const positionAttr = child.geometry.attributes.position;
    const source = positionAttr.array;
    if (!source || source.length < 9) return;

    if (!child.userData.basePositionArray || child.userData.basePositionArray.length !== source.length) {
      child.userData.basePositionArray = Float32Array.from(source);
      const baseBounds = new THREE_LIB.Box3().setFromBufferAttribute(positionAttr);
      child.userData.baseBounds = {
        minX: baseBounds.min.x,
        minY: baseBounds.min.y,
        minZ: baseBounds.min.z,
        maxX: baseBounds.max.x,
        maxY: baseBounds.max.y,
        maxZ: baseBounds.max.z,
      };
    }

    const base = child.userData.basePositionArray;
    const bounds = child.userData.baseBounds;
    if (!bounds) return;

    const width = Math.max(0.0001, bounds.maxX - bounds.minX);
    const height = Math.max(0.0001, bounds.maxY - bounds.minY);
    const depth = Math.max(0.0001, bounds.maxZ - bounds.minZ);
    const midX = (bounds.minX + bounds.maxX) * 0.5;
    const midY = (bounds.minY + bounds.maxY) * 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

    for (let i = 0; i < base.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const z = base[i + 2];

      const xNorm = (x - midX) / (width * 0.5);
      const yNorm01 = (y - bounds.minY) / height;
      const zNorm = (z - midZ) / (depth * 0.5);

      const torsoProfile = 1 - Math.pow(Math.min(1, Math.abs(xNorm)), 1.7);
      const bodyZone = 0.72 + 0.28 * Math.sin(yNorm01 * Math.PI);
      const widthAtY = targetHalfWidth * (0.88 + 0.22 * bodyZone);
      const depthAtY = targetHalfDepth * (0.72 + 0.28 * bodyZone);
      const drapeAtY = lowerDrape * modelSize.y * Math.pow(1 - yNorm01, 1.35);

      const signedZ = Math.sign(zNorm === 0 ? (z >= midZ ? 1 : -1) : zNorm);

      const newX = midX + xNorm * widthAtY;
      const newY = midY + (y - midY) * verticalScale - drapeAtY;
      const newZ =
        midZ +
        signedZ * depthAtY * (0.35 + 0.65 * torsoProfile) +
        signedZ * 0.015 * modelSize.z * (0.4 + 0.6 * bodyZone);

      source[i] = newX;
      source[i + 1] = newY;
      source[i + 2] = newZ;
    }

    positionAttr.needsUpdate = true;
    child.geometry.computeVertexNormals();
    child.geometry.computeBoundingBox();
    child.geometry.computeBoundingSphere();
  });
}

function setPreviewBackground(hasModel = false) {
  if (!scene || !THREE_LIB) return;
  scene.background = new THREE_LIB.Color(hasModel ? 0xc4c4c4 : 0x070b13);
}

function ensureDebugPanel() {
  if (debugPanel) return debugPanel;

  debugPanel = document.createElement('pre');
  debugPanel.id = 'garmentDebugPanel';
  debugPanel.style.position = 'fixed';
  debugPanel.style.right = '12px';
  debugPanel.style.bottom = '12px';
  debugPanel.style.zIndex = '9999';
  debugPanel.style.maxWidth = '420px';
  debugPanel.style.maxHeight = '45vh';
  debugPanel.style.overflow = 'auto';
  debugPanel.style.margin = '0';
  debugPanel.style.padding = '10px 12px';
  debugPanel.style.borderRadius = '8px';
  debugPanel.style.background = 'rgba(0, 0, 0, 0.85)';
  debugPanel.style.color = '#7dffa1';
  debugPanel.style.font = '12px/1.35 Consolas, Menlo, Monaco, monospace';
  debugPanel.style.whiteSpace = 'pre-wrap';
  debugPanel.style.pointerEvents = 'auto';
  debugPanel.style.overscrollBehavior = 'contain';
  debugPanel.textContent = 'Debug panel ready.';
  document.body.appendChild(debugPanel);
  return debugPanel;
}

function updateDebugPanel(message, details = null) {
  const panel = ensureDebugPanel();
  const timestamp = new Date().toLocaleTimeString();
  let line = `[${timestamp}] ${message}`;
  if (details) {
    try {
      line += `\n${JSON.stringify(details, null, 2)}`;
    } catch {
      line += `\n${String(details)}`;
    }
  }
  panel.textContent = line;
}

function initModelViewer() {
  if (!modelContainer || !THREE_LIB) return;
  scene = new THREE_LIB.Scene();
  setPreviewBackground(false);
  previewRaycaster = new THREE_LIB.Raycaster();
  previewPointer = new THREE_LIB.Vector2();
  previewDragPlane = new THREE_LIB.Plane();
  previewDragOffset = new THREE_LIB.Vector3();

  const width = modelContainer.clientWidth;
  const height = Math.max(modelContainer.clientHeight, 300);

  camera = new THREE_LIB.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(0, 1.5, 5);

  renderer = new THREE_LIB.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  renderer.domElement.style.display = 'block';

  modelContainer.innerHTML = '';
  modelContainer.appendChild(renderer.domElement);
  if (previewHint) {
    previewHint.hidden = false;
    modelContainer.appendChild(previewHint);
  }
  if (clothingOverlay) {
    modelContainer.appendChild(clothingOverlay);
  }
  const light = new THREE_LIB.DirectionalLight(0xffffff, 1);
  light.position.set(5, 10, 7);
  scene.add(light);

  const ambientLight = new THREE_LIB.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  controls = new THREE_LIB.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  const getPreviewPointerPosition = (event) => {
    if (!renderer || !camera || !previewPointer) {
      return false;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }

    previewPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    previewPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return true;
  };

  const updateGarmentDragPosition = (event) => {
    if (!isDraggingPreviewGarment || !previewRaycaster || !previewDragPlane || !generatedGarmentMesh) {
      return;
    }

    if (!getPreviewPointerPosition(event)) {
      return;
    }

    previewRaycaster.setFromCamera(previewPointer, camera);
    const hitPoint = new THREE_LIB.Vector3();
    if (!previewRaycaster.ray.intersectPlane(previewDragPlane, hitPoint)) {
      return;
    }

    generatedGarmentMesh.position.copy(hitPoint.sub(previewDragOffset));
    generatedGarmentMesh.updateMatrixWorld(true);
  };

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (!generatedGarmentMesh || !previewRaycaster || !previewDragPlane || !previewDragOffset) {
      return;
    }

    if (!getPreviewPointerPosition(event)) {
      return;
    }

    previewRaycaster.setFromCamera(previewPointer, camera);
    const meshCandidates = [];
    generatedGarmentMesh.traverse?.((child) => {
      if (child?.isMesh) {
        meshCandidates.push(child);
      }
    });

    const intersections = previewRaycaster.intersectObjects(meshCandidates, false);
    if (!intersections.length) {
      return;
    }

    const hitPoint = intersections[0].point.clone();
    const cameraNormal = camera.getWorldDirection(new THREE_LIB.Vector3()).normalize();
    previewDragPlane.setFromNormalAndCoplanarPoint(cameraNormal, hitPoint);
    previewDragOffset.copy(hitPoint).sub(generatedGarmentMesh.position);
    isDraggingPreviewGarment = true;
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    event.preventDefault();
  });

  renderer.domElement.addEventListener('pointermove', (event) => {
    updateGarmentDragPosition(event);
  });

  window.addEventListener('pointerup', () => {
    if (!isDraggingPreviewGarment) {
      return;
    }

    isDraggingPreviewGarment = false;
    if (controls) {
      controls.enabled = true;
    }
    if (renderer?.domElement) {
      renderer.domElement.style.cursor = 'grab';
    }
  });

  renderer.domElement.addEventListener('pointerleave', () => {
    if (!isDraggingPreviewGarment) {
      renderer.domElement.style.cursor = 'grab';
    }
  });

  renderer.domElement.addEventListener('pointerenter', () => {
    if (!isDraggingPreviewGarment) {
      renderer.domElement.style.cursor = 'grab';
    }
  });

  window.addEventListener('resize', () => {
    if (!modelContainer) return;
    const newWidth = modelContainer.clientWidth;
    const newHeight = Math.max(modelContainer.clientHeight, 300);
    camera.aspect = newWidth / newHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(newWidth, newHeight);
  });

  animateModel();
}

function animateModel() {
  requestAnimationFrame(animateModel);
  if (controls) controls.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function getGarmentFitProfile(garmentType) {
  const type = String(garmentType || 'shirt').toLowerCase();
  const profiles = {
    shirt: { widthRatio: 0.6, heightRatio: 0.42, yOffset: 0.16, zOffsetRatio: 0.04 },
    tshirt: { widthRatio: 0.6, heightRatio: 0.42, yOffset: 0.16, zOffsetRatio: 0.04 },
    blouse: { widthRatio: 0.6, heightRatio: 0.44, yOffset: 0.16, zOffsetRatio: 0.04 },
    dress: { widthRatio: 0.58, heightRatio: 0.72, yOffset: -0.04, zOffsetRatio: 0.045 },
    pants: { widthRatio: 0.5, heightRatio: 0.58, yOffset: -0.28, zOffsetRatio: 0.035 },
    shorts: { widthRatio: 0.52, heightRatio: 0.42, yOffset: -0.2, zOffsetRatio: 0.035 },
    skirt: { widthRatio: 0.6, heightRatio: 0.44, yOffset: -0.24, zOffsetRatio: 0.04 },
    jacket: { widthRatio: 0.68, heightRatio: 0.52, yOffset: 0.12, zOffsetRatio: 0.05 },
    hoodie: { widthRatio: 0.68, heightRatio: 0.52, yOffset: 0.12, zOffsetRatio: 0.05 },
    sweater: { widthRatio: 0.66, heightRatio: 0.5, yOffset: 0.13, zOffsetRatio: 0.045 },
    suit: { widthRatio: 0.66, heightRatio: 0.56, yOffset: 0.12, zOffsetRatio: 0.05 },
    romper: { widthRatio: 0.58, heightRatio: 0.68, yOffset: -0.05, zOffsetRatio: 0.045 },
    jumpsuit: { widthRatio: 0.58, heightRatio: 0.68, yOffset: -0.05, zOffsetRatio: 0.045 },
  };
  return profiles[type] || profiles.shirt;
}

function alignGarmentToCurrentModel() {
  if (!THREE_LIB || !scene || !currentModel || !generatedGarmentMesh) return;

  if (generatedGarmentMesh.parent !== scene && typeof scene.attach === 'function') {
    scene.attach(generatedGarmentMesh);
  }

  const modelBox = new THREE_LIB.Box3().setFromObject(currentModel);
  if (modelBox.isEmpty()) {
    return;
  }

  const garmentType = getSelectedGarmentType();
  const fitProfile = getGarmentFitProfile(garmentType);
  const modelSize = modelBox.getSize(new THREE_LIB.Vector3());
  const modelCenter = modelBox.getCenter(new THREE_LIB.Vector3());
  const selectedMeasurements = currentClothingSizeLabel
    ? (sizeToMeasurementsMap[String(currentClothingSizeLabel).trim()] || [])
    : [];
  const hasProvidedMeasurements = selectedMeasurements.length > 0;

  generatedGarmentMesh.position.set(0, 0, 0);
  generatedGarmentMesh.scale.setScalar(Math.max(0.0001, generatedGarmentBaseScale));
  generatedGarmentMesh.updateMatrixWorld(true);

  // Only conform garment shape to body when no chart measurements are available.
  // If measurements exist, they are the single source of dimensional truth.
  if (!hasProvidedMeasurements) {
    applyBodyConformingDeformationToGarment(modelSize, fitProfile, 1);
  }

  const garmentBoxBefore = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  if (garmentBoxBefore.isEmpty()) {
    return;
  }

  const garmentSizeBefore = garmentBoxBefore.getSize(new THREE_LIB.Vector3());

  const safeGarmentWidth = Math.max(garmentSizeBefore.x, 0.0001);
  const safeGarmentHeight = Math.max(garmentSizeBefore.y, 0.0001);
  const targetWidthFromModel = modelSize.x * fitProfile.widthRatio;
  const targetHeightFromModel = modelSize.y * fitProfile.heightRatio;

  // Fallback: fit garment to model proportions when no measurements available
  const bodyFitScale = Math.max(0.2, Math.min(6, Math.min(targetWidthFromModel / safeGarmentWidth, targetHeightFromModel / safeGarmentHeight)));

  // Start from model-fit baseline for both axes, then override only the axes
  // that have explicit measurements in the selected size.
  let xzScaleFactor = bodyFitScale;
  let yScaleFactor = bodyFitScale;
  let hasWidthMeasurement = false;
  let hasLengthMeasurement = false;
  let widthMeasurementType = null;
  let widthMeasurementMultiplier = 1;
  if (hasProvidedMeasurements) {
    const ppi = modelMeasurementCalibration?.modelUnitsPerInch || getPixelsPerInch();
    for (const m of selectedMeasurements) {
      const type = String(m.measurementType || '').trim();
      if (isLengthMeasurement(type) && !hasLengthMeasurement) {
        hasLengthMeasurement = true;
        yScaleFactor = (m.value * ppi) / Math.max(0.0001, garmentSizeBefore.y);
      } else if (!isLengthMeasurement(type) && !hasWidthMeasurement) {
        hasWidthMeasurement = true;
        widthMeasurementType = type;
        widthMeasurementMultiplier = getCircumferenceMeasurementMultiplier(type);
        xzScaleFactor = (m.value * widthMeasurementMultiplier * ppi) / Math.max(0.0001, garmentSizeBefore.x);
      }
    }
  }

  generatedGarmentMesh.scale.set(
    generatedGarmentBaseScale * xzScaleFactor,
    generatedGarmentBaseScale * yScaleFactor,
    generatedGarmentBaseScale * xzScaleFactor
  );
  generatedGarmentMesh.updateMatrixWorld(true);

  const garmentBoxAfter = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  const garmentCenter = garmentBoxAfter.getCenter(new THREE_LIB.Vector3());
  const targetCenter = new THREE_LIB.Vector3(
    modelCenter.x,
    modelCenter.y + modelSize.y * fitProfile.yOffset,
    modelCenter.z + modelSize.z * fitProfile.zOffsetRatio
  );

  const offset = targetCenter.sub(garmentCenter);
  generatedGarmentMesh.position.add(offset);
  generatedGarmentMesh.updateMatrixWorld(true);

  if (generatedGarmentMesh.parent !== currentModel && typeof currentModel.attach === 'function') {
    currentModel.attach(generatedGarmentMesh);
  }

  updateDebugPanel('Garment aligned to avatar model.', {
    garmentType,
    xzScaleFactor: Number(xzScaleFactor.toFixed(4)),
    yScaleFactor: Number(yScaleFactor.toFixed(4)),
    hasWidthMeasurement,
    hasLengthMeasurement,
    hasProvidedMeasurements,
    widthMeasurementType,
    widthMeasurementMultiplier,
    selectedSize: getSelectedSizeInches(),
    modelHeightInches: Number(getModelHeightInches().toFixed(2)),
    ppi: Number((modelMeasurementCalibration?.modelUnitsPerInch || getPixelsPerInch()).toFixed(6)),
    targetWidth: Number(targetWidthFromModel.toFixed(4)),
    targetHeight: Number(targetHeightFromModel.toFixed(4)),
  });
}

function clearGeneratedGarmentMesh() {
  if (!scene || !generatedGarmentMesh) return;
  if (generatedGarmentMesh.parent) {
    generatedGarmentMesh.parent.remove(generatedGarmentMesh);
  }
  generatedGarmentMesh.traverse?.((child) => {
    if (!child || !child.isMesh) return;
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material?.map) {
          material.map.dispose();
        }
        material?.dispose?.();
      });
    }
  });
  generatedGarmentMesh = null;
  generatedGarmentBaseScale = 1;
  setPreviewBackground(Boolean(currentModel));
}

function dataUrlToArrayBuffer(dataUrl) {
  const parts = String(dataUrl || '').split(',');
  if (parts.length < 2) return null;
  const binary = atob(parts[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function setGeneratedGarmentMesh(modelPayload) {
  if (!THREE_LIB) {
    updateDebugPanel('Three.js is missing. Cannot render garment model.');
    return;
  }

  if (!modelPayload) {
    updateDebugPanel('No garment model payload present.');
    return;
  }

  if (!scene) {
    initModelViewer();
  }

  clearGeneratedGarmentMesh();

  if (modelPayload.format === 'glb-base64' && modelPayload.glbDataUrl) {
    const glbBuffer = dataUrlToArrayBuffer(modelPayload.glbDataUrl);
    if (!glbBuffer) {
      updateDebugPanel('GLB payload decode failed.', {
        format: modelPayload.format,
        hasDataUrl: Boolean(modelPayload.glbDataUrl),
      });
      return;
    }

    const loader = new THREE_LIB.GLTFLoader();
    loader.parse(glbBuffer, '', (gltf) => {
      generatedGarmentMesh = gltf.scene;
      generatedGarmentMesh.name = 'GeneratedGarmentGLB';
      generatedGarmentMesh.position.set(0, 0, 0);
      generatedGarmentMesh.traverse((child) => {
        if (!child?.isMesh) return;
        child.material = new THREE_LIB.MeshStandardMaterial({
          color: 0xff1493,
          roughness: 0.78,
          metalness: 0.04,
          side: THREE_LIB.DoubleSide,
        });
      });

      const bounds = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
      const size = bounds.getSize(new THREE_LIB.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
      generatedGarmentBaseScale = 1.5 / maxDimension;
      generatedGarmentMesh.scale.setScalar(generatedGarmentBaseScale);

      scene.add(generatedGarmentMesh);
      alignGarmentToCurrentModel();
      setPreviewBackground(true);
      if (previewHint) {
        previewHint.hidden = true;
      }
      updateDebugPanel('GLB garment model rendered.', {
        name: generatedGarmentMesh.name,
        scale: generatedGarmentBaseScale,
      });
    }, undefined, (error) => {
      console.error('Failed to parse generated garment GLB:', error);
      updateDebugPanel('GLB parse/render failed.', {
        error: error?.message || String(error),
      });
    });

    return;
  }

  if (!Array.isArray(modelPayload.positions) || !Array.isArray(modelPayload.indices)) {
    updateDebugPanel('Tri-mesh payload missing positions or indices.', {
      hasPositions: Array.isArray(modelPayload.positions),
      hasIndices: Array.isArray(modelPayload.indices),
      format: modelPayload.format || null,
    });
    return;
  }

  const geometry = new THREE_LIB.BufferGeometry();
  geometry.setAttribute('position', new THREE_LIB.Float32BufferAttribute(modelPayload.positions, 3));
  if (Array.isArray(modelPayload.uvs) && modelPayload.uvs.length >= 2) {
    geometry.setAttribute('uv', new THREE_LIB.Float32BufferAttribute(modelPayload.uvs, 2));
  }
  geometry.setIndex(modelPayload.indices);
  geometry.computeVertexNormals();

  const material = new THREE_LIB.MeshStandardMaterial({
    color: 0xff1493,
    side: THREE_LIB.DoubleSide,
    roughness: 0.78,
    metalness: 0.04,
  });

  generatedGarmentMesh = new THREE_LIB.Mesh(geometry, material);
  generatedGarmentMesh.name = 'GeneratedGarmentMesh';
  generatedGarmentMesh.position.set(0, 0, 0);

  const bounds = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  const size = bounds.getSize(new THREE_LIB.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  generatedGarmentBaseScale = 1.5 / maxDimension;
  generatedGarmentMesh.scale.setScalar(generatedGarmentBaseScale);

  scene.add(generatedGarmentMesh);
  alignGarmentToCurrentModel();
  setPreviewBackground(true);
  if (previewHint) {
    previewHint.hidden = true;
  }
  updateDebugPanel('Tri-mesh garment model rendered.', {
    vertices: modelPayload.positions.length / 3,
    triangles: Array.isArray(modelPayload.indices) ? modelPayload.indices.length / 3 : 0,
    framework: modelPayload.framework || null,
    format: modelPayload.format || null,
  });
}

function fitModelToView(object) {
  if (!THREE_LIB) return;
  const box = new THREE_LIB.Box3().setFromObject(object);
  const size = box.getSize(new THREE_LIB.Vector3());
  const center = box.getCenter(new THREE_LIB.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
  cameraZ *= 1.5;
  camera.position.set(center.x, center.y, center.z + cameraZ);
  camera.lookAt(center);
  controls.target.copy(center);
  controls.update();
}

async function uploadScanFileToBackend(file) {
  const formData = new FormData();
  formData.append('model', file);

  const response = await fetch(`${BACKEND_URL}/upload-scan`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Model upload failed.');
  }

  return response.json();
}

function setClothingOverlay(file) {
  if (!clothingOverlay) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    clothingOverlay.onload = () => {
      currentGarmentCutout = {
        width: clothingOverlay.naturalWidth || clothingOverlay.width || 0,
        height: clothingOverlay.naturalHeight || clothingOverlay.height || 0,
      };
      applySelectedClothingSize();
    };
    clothingOverlay.src = event.target.result;
    clothingOverlay.hidden = false;
    if (previewHint) {
      previewHint.hidden = true;
    }
  };
  reader.readAsDataURL(file);
}

function setCutoutOverlay(dataUrl, cutout = null) {
  if (!clothingOverlay || !dataUrl) return;

  clothingOverlay.onload = () => {
    currentGarmentCutout = {
      width:
        cutout?.width ||
        clothingOverlay.naturalWidth ||
        clothingOverlay.width ||
        0,
      height:
        cutout?.height ||
        clothingOverlay.naturalHeight ||
        clothingOverlay.height ||
        0,
    };
    applySelectedClothingSize();
  };

  clothingOverlay.src = dataUrl;
  clothingOverlay.hidden = false;
  if (previewHint) {
    previewHint.hidden = true;
  }
}

function getSelectedGarmentType() {
  return garmentTypeSelect?.value || 'shirt';
}

function getClothingAnalysisKey(file, garmentType) {
  if (!file) return null;
  return [
    file.name,
    file.size,
    file.lastModified,
    garmentType || 'shirt',
  ].join('|');
}

function calculateImageWidth(sizeValue) {
  // Convert inches to pixels using dynamically calculated ppi from the 3D model
  if (!modelContainer) return 200; // Fallback if container not available

  const previewWidth = modelContainer.clientWidth;
  const previewHeight = modelContainer.clientHeight;
  const cutoutWidth = currentGarmentCutout?.width || clothingOverlay?.naturalWidth || 1;
  const cutoutHeight = currentGarmentCutout?.height || clothingOverlay?.naturalHeight || 1;
  const cutoutAspectRatio = cutoutWidth / Math.max(1, cutoutHeight);

  // Calculate pixels per inch based on the 3D model's visual height and user's provided height
  const pixelsPerInch = getPixelsPerInch();
  const widthInPixels = Math.round(sizeValue * pixelsPerInch);

  // Constrain to reasonable bounds and keep the scaled cutout inside the preview.
  const minWidth = 50;
  const maxWidthByContainer = Math.round(previewWidth * 0.95);
  const maxHeightByContainer = Math.round(previewHeight * 0.92);
  const maxWidthByCutoutHeight = Math.round(maxHeightByContainer * cutoutAspectRatio);
  const maxWidth = Math.max(minWidth, Math.min(maxWidthByContainer, maxWidthByCutoutHeight));
  const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, widthInPixels));

  console.log(
    `Size ${sizeValue}" with ppi=${pixelsPerInch.toFixed(2)} -> ${widthInPixels}px (constrained: ${constrainedWidth}px)`
  );
  return constrainedWidth;
}

function resizeClothingImage(sizeValue) {
  if (generatedGarmentMesh) {
    alignGarmentToCurrentModel();
  }

  if (!clothingOverlay || clothingOverlay.hidden) return;

  const isLengthSize = isLengthMeasurement(currentSizeRepresentativeMeasurementType);
  if (isLengthSize) {
    // Use pre-calibrated pixel value for consistent measurement display
    let targetHeight = Math.max(80, Math.round(getPixelValueForMeasurement(
      currentSizeRepresentativeMeasurementType,
      sizeValue,
      currentClothingSizeLabel,
    )));
    
    // Fallback: calculate from ppi if not in calibration map
    if (!Number.isFinite(targetHeight) || targetHeight < 80) {
      const pixelsPerInch = getPixelsPerInch();
      targetHeight = Math.max(80, Math.round(sizeValue * pixelsPerInch));
    }
    
    const cutoutWidth = currentGarmentCutout?.width || clothingOverlay?.naturalWidth || 1;
    const cutoutHeight = currentGarmentCutout?.height || clothingOverlay?.naturalHeight || 1;
    const aspectRatio = cutoutWidth / Math.max(1, cutoutHeight);
    const targetWidth = Math.max(50, Math.round(targetHeight * aspectRatio));

    const previousRect = clothingOverlay.getBoundingClientRect();
    const topBefore = previousRect.top;

    clothingOverlay.style.width = targetWidth + 'px';
    clothingOverlay.style.height = targetHeight + 'px';
    clothingOverlay.style.transform = 'translate(-50%, -50%)';

    const nextRect = clothingOverlay.getBoundingClientRect();
    const topShift = nextRect.top - topBefore;
    if (Math.abs(topShift) > 0.5) {
      const currentTop = parseFloat(clothingOverlay.style.top || '50%');
      if (Number.isFinite(currentTop)) {
        clothingOverlay.style.top = (currentTop - topShift) + 'px';
        clothingOverlay.style.transform = 'translate(0, 0)';
      }
    }
  } else {
    const newWidth = calculateImageWidth(sizeValue);
    clothingOverlay.style.width = newWidth + 'px';
    clothingOverlay.style.height = 'auto';
  }

  clothingOverlay.style.maxWidth = 'none';
  clothingOverlay.style.maxHeight = 'none';
}

function applySelectedClothingSize() {
  if (currentClothingSizeValue === null || currentClothingSizeValue === undefined) return;
  resizeClothingImage(currentClothingSizeValue);
}

function chooseRepresentativeMeasurement(measurements) {
  const list = Array.isArray(measurements) ? measurements.filter(Boolean) : [];
  if (list.length === 0) {
    return null;
  }

  // Anchor representative size to model-height-driven behavior by preferring length metrics.
  const preferredLength = list.find((entry) => {
    const type = String(entry.measurementType || '').toUpperCase();
    return type.includes('BODY LENGTH') || type.includes('LENGTH') || type.includes('INSEAM') || type.includes('SLEEVE');
  });
  if (preferredLength) {
    return preferredLength;
  }

  const prioritized = list.find((entry) => {
    const type = String(entry.measurementType || '').toUpperCase();
    return type.includes('CHEST') || type.includes('BUST') || type.includes('WAIST') || type.includes('HIP') || type.includes('WIDTH');
  });
  if (prioritized) {
    return prioritized;
  }

  const anyCircumference = list.find((entry) => !isLengthMeasurement(entry.measurementType));
  if (anyCircumference) {
    return anyCircumference;
  }

  return list[0];
}

function createSizeButton(size) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'size-button';
  button.textContent = size.label;
  button.dataset.sizeValue = size.value;

  const representativeType = String(size.measurementType || '').trim();
  const representativeValue = Number(size.value);
  const inchValue = Number(size.value);
  const pixelValue = Number.isFinite(inchValue) && representativeType
    ? getPixelValueForMeasurement(representativeType, representativeValue, size.label)
    : null;
  button.dataset.pixelValue = pixelValue || '';
  
  button.addEventListener('click', () => {
    document.querySelectorAll('.size-button').forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    currentClothingSizeValue = size.value;
    currentClothingSizeLabel = size.label;
    currentSizeRepresentativeMeasurementType = representativeType || null;
    
    // Get all measurements for this size
    const sizeLabel = String(size.label).trim();
    const measurementsForSize = sizeToMeasurementsMap[sizeLabel] || [];
    
    if (measurementsForSize.length > 0) {
      analyzeStatus.textContent = `Selected ${size.label} with ${measurementsForSize.length} measurements`;
    } else {
      analyzeStatus.textContent = `Selected ${size.label} — ${size.value}"${pixelValue ? ` (${Math.round(pixelValue)}px)` : ''}`;
    }

    if (generatedGarmentMesh) {
      if (currentModel) {
        alignGarmentToCurrentModel();
      } else if (measurementsForSize.length > 0) {
        // Fallback when no avatar model is loaded: still apply selected size measurements.
        applyAllMeasurementDeformations(generatedGarmentMesh, measurementsForSize);
      }
    }

    applySelectedClothingSize();
  });
  return button;
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

function sortSizes(sizes) {
  return [...(sizes || [])].sort((first, second) => {
    const sizeOrder = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL'];
    const getSortRank = (size) => {
      const label = normalizeSizeLabel(size?.label);
      const value = Number(size?.value);

      if (/^\d+T$/.test(label)) {
        return { group: 0, rank: Number.parseInt(label, 10), secondary: Number.isFinite(value) ? value : Number.POSITIVE_INFINITY, label };
      }

      const labelIndex = sizeOrder.indexOf(label);
      if (labelIndex !== -1) {
        return { group: 1, rank: labelIndex, secondary: Number.isFinite(value) ? value : Number.POSITIVE_INFINITY, label };
      }

      if (Number.isFinite(value)) {
        return { group: 2, rank: value, secondary: label, label };
      }

      return { group: 3, rank: Number.POSITIVE_INFINITY, secondary: label, label };
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

function renderSizeButtons(sizes) {
  if (!sizeButtons) return;
  sizeButtons.innerHTML = '';

  const normalizedMeasurements = (sizes || [])
    .map((entry) => normalizeMeasurementEntry(entry))
    .filter(Boolean);

  if (normalizedMeasurements.length === 0) {
    sizeButtons.textContent = 'No sizes detected. Try uploading a clearer, high-quality screenshot of the size guide. Ensure the text is crisp and the table is well-lit.';
    return;
  }

  // Calibrate and convert all measurements to pixel values using the model's current setup
  convertMeasurementsToPixels(normalizedMeasurements);

  // Build a map of size to ALL its measurements from the chart
  // Group by size label so all measurements for a size apply together
  sizeToMeasurementsMap = {};
  normalizedMeasurements.forEach((measurement) => {
    const sizeLabel = String(measurement.sizeLabel).trim();
    if (!sizeToMeasurementsMap[sizeLabel]) {
      sizeToMeasurementsMap[sizeLabel] = [];
    }
    sizeToMeasurementsMap[sizeLabel].push({
      sizeLabel,
      measurementType: String(measurement.measurementType).trim(),
      value: Number(measurement.value),
    });
  });

  const uniqueSizes = sortSizes(
    Object.keys(sizeToMeasurementsMap).map((sizeLabel) => {
      const representative = chooseRepresentativeMeasurement(sizeToMeasurementsMap[sizeLabel]);
      return {
        label: sizeLabel,
        value: representative?.value ?? 0,
        measurementType: representative?.measurementType || '',
      };
    })
  );

  // Build debug output grouped per size, listing all measurements for each size
  const measurementGroupsBySize = {};
  normalizedMeasurements.forEach((measurement) => {
    const sizeLabel = String(measurement.sizeLabel).trim();
    const measurementType = String(measurement.measurementType).trim();
    const inchValue = Number(measurement.value);
    const isLength = isLengthMeasurement(measurementType);
    const pixelValue = getPixelValueForMeasurement(measurementType, inchValue, sizeLabel);

    if (!measurementGroupsBySize[sizeLabel]) {
      measurementGroupsBySize[sizeLabel] = [];
    }

    measurementGroupsBySize[sizeLabel].push({
      measurementType,
      inches: inchValue,
      type: isLength ? 'Length' : 'Circumference',
      pixels: Math.round(pixelValue * 100) / 100,
    });
  });

  const measurementDetails = Object.keys(measurementGroupsBySize)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((sizeLabel) => ({
      size: sizeLabel,
      measurementCount: measurementGroupsBySize[sizeLabel].length,
      measurements: measurementGroupsBySize[sizeLabel],
    }));
  
  updateDebugPanel('Size measurements detected and calibrated.', {
    totalMeasurements: normalizedMeasurements.length,
    totalSizes: measurementDetails.length,
    calibration: modelMeasurementCalibration,
    measurementsBySize: measurementDetails,
  });

  uniqueSizes.forEach((size) => {
    sizeButtons.appendChild(createSizeButton(size));
  });
}

function loadScanFile(file) {
  if (!file) return;
  if (!modelContainer || !THREE_LIB) return;

  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.glb') && !fileName.endsWith('.gltf')) {
    alert('Please upload a .glb or .gltf scan file');
    return;
  }

  if (!scene) {
    initModelViewer();
  }

  if (currentModel) {
    if (generatedGarmentMesh && generatedGarmentMesh.parent === currentModel && typeof scene.attach === 'function') {
      scene.attach(generatedGarmentMesh);
    }
    scene.remove(currentModel);
    currentModel = null;
    setPreviewBackground(Boolean(generatedGarmentMesh));
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    console.log('File loaded, processing...');
    const LoaderCtor = THREE_LIB.GLTFLoader || window.GLTFLoader;
    if (!LoaderCtor) {
      alert('GLTFLoader is not available. Please refresh the page.');
      return;
    }
    const loader = new LoaderCtor();
    loader.parse(event.target.result, '', (gltf) => {
      currentModel = gltf.scene;
      // Traverse the model to ensure materials are visible
      currentModel.traverse((child) => {
        if (child.isMesh) {
          // Only replace material if it doesn't exist or is completely transparent
          if (!child.material || child.material.opacity === 0) {
            child.material = new THREE_LIB.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.1 });
          }
          // Ensure both sides are visible
          if (child.material) {
            child.material.side = THREE_LIB.DoubleSide;
          }
        }
      });
      scene.add(currentModel);
      calibrateMeasurementsForModel();
      alignGarmentToCurrentModel();
      setPreviewBackground(true);
      console.log('3D model loaded successfully');
      if (previewHint) previewHint.hidden = true;
      fitModelToView(currentModel);
    }, undefined, (error) => {
      console.error('GLTF parse error:', error);
      alert('Error loading scan. Make sure the file is a valid .glb or .gltf.');
    });
  };

  reader.readAsArrayBuffer(file);
}

if (scanUpload) {
  scanUpload.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await uploadScanFileToBackend(file);
    } catch (error) {
      console.warn('Backend scan upload failed:', error.message);
    }

    loadScanFile(file);
  });
}

if (clothingUpload) {
  clothingUpload.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      clearGeneratedGarmentMesh();
      clothingPreviewJobId += 1;
      cachedClothingAnalysisKey = null;
      cachedClothingResult = null;
      currentGarmentCutout = null;
      setClothingOverlay(file);
      analyzeStatus.textContent = 'Clothing image ready. Press Analyze to generate the garment model.';
    }
  });
}

if (garmentTypeSelect) {
  garmentTypeSelect.addEventListener('change', () => {
    // Changing garment type invalidates the cached cutout selection.
    cachedClothingAnalysisKey = null;
    cachedClothingResult = null;
  });
}

if (modelHeightFeetInput) {
  modelHeightFeetInput.addEventListener('input', () => {
    if (generatedGarmentMesh && currentModel) {
      alignGarmentToCurrentModel();
    }
  });
}
if (modelHeightInchesInput) {
  modelHeightInchesInput.addEventListener('input', () => {
    if (generatedGarmentMesh && currentModel) {
      alignGarmentToCurrentModel();
    }
  });
}

async function analyzeImages(files, type, garmentType = null) {
  const formData = new FormData();
  const fileList = Array.isArray(files) ? files : [files];

  for (const file of fileList) {
    formData.append('image', file);
  }

  formData.append('type', type);
  if (garmentType) {
    formData.append('garmentType', garmentType);
  }

  const response = await fetch(`${BACKEND_URL}/analyze-image`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Image analyzer request failed.');
  }

  const result = await response.json();
  return result;
}

function formatAnalysis(title, analysis) {
  return `
${title}
-------------
File: ${analysis.fileName}
Type: ${analysis.mimeType}
Size: ${Math.round(analysis.fileSize / 1024)} KB
Width: ${analysis.width}px
Height: ${analysis.height}px
Orientation: ${analysis.orientation || 'unknown'}
Notes: ${analysis.notes}
`;
}

// Clothing overlay resize and drag functionality
let isResizingClothing = false;
let isDraggingClothing = false;
let startX, startY, startWidth, startHeight, startTop, startLeft;

if (clothingOverlay) {
  clothingOverlay.addEventListener('mousedown', (e) => {
    const rect = clothingOverlay.getBoundingClientRect();
    const isResizeHandle = e.offsetX > rect.width - 25 && e.offsetY > rect.height - 25;

    if (isResizeHandle) {
      isResizingClothing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = clothingOverlay.offsetWidth;
      startHeight = clothingOverlay.offsetHeight;
      startTop = clothingOverlay.style.top;
      startLeft = clothingOverlay.style.left;
      e.preventDefault();
    } else {
      isDraggingClothing = true;
      startX = e.clientX;
      startY = e.clientY;
      startTop = clothingOverlay.style.top;
      startLeft = clothingOverlay.style.left;
      clothingOverlay.classList.add('dragging');
      e.preventDefault();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizingClothing) {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const newWidth = Math.max(80, startWidth + deltaX);
      const newHeight = Math.max(80, startHeight + deltaY);
      clothingOverlay.style.width = newWidth + 'px';
      clothingOverlay.style.height = newHeight + 'px';
      clothingOverlay.style.maxWidth = 'none';
      clothingOverlay.style.maxHeight = 'none';
    } else if (isDraggingClothing) {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const container = modelContainer.getBoundingClientRect();
      const currentTop = parseFloat(clothingOverlay.style.top || '50%');
      const currentLeft = parseFloat(clothingOverlay.style.left || '50%');
      clothingOverlay.style.top = (currentTop + deltaY) + 'px';
      clothingOverlay.style.left = (currentLeft + deltaX) + 'px';
      clothingOverlay.style.transform = 'translate(0, 0)';
      startX = e.clientX;
      startY = e.clientY;
    }
  });

  document.addEventListener('mouseup', () => {
    isResizingClothing = false;
    isDraggingClothing = false;
    clothingOverlay.classList.remove('dragging');
  });
}

if (analyzeButton) {
  analyzeButton.addEventListener('click', async () => {
    analysisResults.innerHTML = '';
    analyzeStatus.textContent = '';
    currentClothingSizeValue = null;

    const clothingFile = clothingUpload?.files[0];
    const sizeGuideFiles = Array.from(sizeGuideUpload?.files || []);
    const garmentType = getSelectedGarmentType();
    const analysisKey = getClothingAnalysisKey(clothingFile, garmentType);

    if (!clothingFile) {
      analyzeStatus.textContent = 'Please upload a clothing image first.';
      return;
    }

    analyzeStatus.textContent = 'Analyzing images...';
    updateDebugPanel('Analyze started.', {
      hasClothingFile: Boolean(clothingFile),
      sizeGuideCount: sizeGuideFiles.length,
      garmentType,
    });

    try {
      let clothingResult = cachedClothingResult;
      if (!clothingResult || analysisKey !== cachedClothingAnalysisKey) {
        clothingResult = await analyzeImages(clothingFile, 'clothing', garmentType);
        cachedClothingAnalysisKey = analysisKey;
        cachedClothingResult = clothingResult;
      }

      console.log('Clothing result:', clothingResult);
      updateDebugPanel('Clothing API response received.', {
        hasGarmentModel: Boolean(clothingResult.garmentModel),
        hasProcessedImageUrl: Boolean(clothingResult.processedImageUrl),
        modelFramework: clothingResult.garmentModel?.framework || null,
        modelFormat: clothingResult.garmentModel?.format || null,
        modelSource: clothingResult.modelSource || null,
      });

      if (clothingResult.garmentModel) {
        setGeneratedGarmentMesh(clothingResult.garmentModel);
        clothingOverlay.hidden = true;
        currentGarmentCutout = null;
      } else if (clothingResult.processedImageUrl) {
        clearGeneratedGarmentMesh();
        setCutoutOverlay(clothingResult.processedImageUrl, clothingResult.cutout);
      } else {
        clearGeneratedGarmentMesh();
        currentGarmentCutout = null;
        setClothingOverlay(clothingFile);
        updateDebugPanel('Fallback to original clothing overlay (no generated model).');
      }

      let sizeGuideAnalyses = [];
      let mergedSizes = [];

      if (sizeGuideFiles.length > 0) {
        const sizeGuideResult = await analyzeImages(sizeGuideFiles, 'sizeGuide', garmentType);
        sizeGuideAnalyses = sizeGuideResult.sizeGuideEntries
          ? sizeGuideResult.sizeGuideEntries.map((entry) => entry.analysis)
          : (sizeGuideResult.analyses || (sizeGuideResult.analysis ? [sizeGuideResult.analysis] : []));
        mergedSizes = sizeGuideResult.sizes || sortSizes(dedupeSizes(sizeGuideResult.rawSizeEntries || []));
      }

      analysisResults.innerHTML = `
        <div>
          <h4>Clothing Image Analysis</h4>
          <pre>${formatAnalysis('Clothing Image', clothingResult.analysis)}</pre>
        </div>
        ${sizeGuideAnalyses.length > 0 ? sizeGuideAnalyses
          .map((analysis, index) => `
            <div style="margin-top: 1.25rem;">
              <h4>Size Guide Analysis ${sizeGuideAnalyses.length > 1 ? `(${index + 1})` : ''}</h4>
              <pre>${formatAnalysis('Size Guide Image', analysis)}</pre>
            </div>
          `)
          .join('') : ''}
      `;

      if (sizeGuideFiles.length > 0) {
        console.log('About to render sizes:', mergedSizes);
        renderSizeButtons(mergedSizes);
        analyzeStatus.textContent = 'Analysis complete.';
      } else {
        if (sizeButtons) {
          sizeButtons.innerHTML = '';
          sizeButtons.textContent = 'Upload a size guide to generate size buttons.';
        }
        analyzeStatus.textContent = 'Garment model generated. Upload a size guide to enable sizing controls.';
      }
    } catch (error) {
      analyzeStatus.textContent = error.message;
      analysisResults.textContent = '';
      updateDebugPanel('Analyze failed.', {
        error: error?.message || String(error),
      });
      if (sizeButtons) {
        sizeButtons.innerHTML = '';
      }
    }
  });
}
