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
let garmentSimulationState = null;
let garmentSimulationLastTimestamp = 0;
let analyzeRequestId = 0;
let simulationModelBoundsBox = null;
let simulationFallbackCenter = null;
let simulationFallbackSize = null;
let simulationBoundsLocalBox = null;
let simulationBoundsWorldBox = null;
let simulationBoundsToLocalMatrix = null;
const ENABLE_BODY_COLLISION_IN_FIT_PREVIEW = true;

// Seam stitching system
let garmentPanels = {
  front: null,
  back: null,
  seams: [],
  fabricProperties: {
    maxStretch: 0.15,  // Muslin ~15% stretch
    elasticity: 0.8
  }
};

let seamConstraints = [];
let needsSeamRecalculation = false;

function computeBoundsExcludingRoot(root, excludeRoot, outBox, localSpaceRoot = null) {
  if (!THREE_LIB || !outBox) return null;
  outBox.makeEmpty();
  if (!root) return outBox;

  if (!simulationBoundsLocalBox) simulationBoundsLocalBox = new THREE_LIB.Box3();
  if (!simulationBoundsWorldBox) simulationBoundsWorldBox = new THREE_LIB.Box3();
  if (!simulationBoundsToLocalMatrix) simulationBoundsToLocalMatrix = new THREE_LIB.Matrix4();

  if (localSpaceRoot?.matrixWorld) {
    simulationBoundsToLocalMatrix.copy(localSpaceRoot.matrixWorld).invert();
  } else {
    simulationBoundsToLocalMatrix.identity();
  }

  const isUnderExcludedRoot = (node) => {
    let current = node;
    while (current) {
      if (current === excludeRoot) return true;
      current = current.parent;
    }
    return false;
  };

  root.traverse((child) => {
    if (!child?.isMesh || !child.geometry) return;
    if (excludeRoot && isUnderExcludedRoot(child)) return;

    const geometry = child.geometry;
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    if (!geometry.boundingBox) return;

    simulationBoundsLocalBox.copy(geometry.boundingBox);
    simulationBoundsWorldBox.copy(simulationBoundsLocalBox)
      .applyMatrix4(child.matrixWorld)
      .applyMatrix4(simulationBoundsToLocalMatrix);
    outBox.union(simulationBoundsWorldBox);
  });

  return outBox;
}

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
  // Only explicit half-measurements should be doubled to get the full visual width.
  // "BODY WIDTH" on a size chart is the full flat measurement (side seam to side seam),
  // so it must NOT be doubled — doubling it causes the garment to render twice as wide.
  // Only measurements explicitly labeled "HALF" need doubling.
  if (!label) return 1;
  const normalizedLabel = String(label).toUpperCase();
  const halfKeywords = ['HALF'];
  return halfKeywords.some((keyword) => normalizedLabel.includes(keyword)) ? 2 : 1;
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
      const wrappedX = midX + xNorm * widthAtY;
      const wrappedY = midY + (y - midY) * verticalScale - drapeAtY;
      const wrappedZ =
        midZ +
        signedZ * depthAtY * (0.35 + 0.65 * torsoProfile) +
        signedZ * 0.015 * modelSize.z * (0.4 + 0.6 * bodyZone);

      // Preserve front-panel width completely — only add depth in Z.
      const wrapStrengthX = 0.0;
      const wrapStrengthZ = 0.9;
      const newX = x + (wrappedX - x) * wrapStrengthX;
      const newY = wrappedY;
      const newZ = z + (wrappedZ - z) * wrapStrengthZ;

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
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0;
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
  if (garmentSimulationState) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const deltaSeconds = garmentSimulationLastTimestamp > 0
      ? Math.max(0.004, Math.min(0.05, (now - garmentSimulationLastTimestamp) / 1000))
      : 1 / 60;
    garmentSimulationLastTimestamp = now;
    stepGarmentSimulation(deltaSeconds);
  } else {
    garmentSimulationLastTimestamp = 0;
  }
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
    jeans: { widthRatio: 0.5, heightRatio: 0.58, yOffset: -0.28, zOffsetRatio: 0.035 },
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

  const garmentBoxBefore = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  if (garmentBoxBefore.isEmpty()) {
    return;
  }

  const garmentSizeBefore = garmentBoxBefore.getSize(new THREE_LIB.Vector3());

  const safeGarmentWidth = Math.max(garmentSizeBefore.x, 0.0001);
  const safeGarmentHeight = Math.max(garmentSizeBefore.y, 0.0001);
  const targetWidthFromModel = modelSize.x * fitProfile.widthRatio;
  const targetHeightFromModel = modelSize.y * fitProfile.heightRatio;

  // Scale X/Z from model width and Y from model height by default.
  const bodyFitScale = Math.max(0.2, Math.min(6, targetHeightFromModel / safeGarmentHeight));
  const bodyWidthScale = Math.max(0.2, Math.min(6, targetWidthFromModel / safeGarmentWidth));

  let xzScaleFactor = bodyWidthScale;
  let yScaleFactor = bodyFitScale;
  let hasWidthMeasurement = false;
  let hasLengthMeasurement = false;
  let widthMeasurementType = null;
  let lengthMeasurementType = null;
  let widthMeasurementMultiplier = 1;

  const getLengthMeasurementPriority = (type, garmentTypeName) => {
    const normalized = String(type || '').toUpperCase();
    const garment = String(garmentTypeName || '').toUpperCase();
    if (!normalized) return -1000;

    const isAux = normalized.includes('SLEEVE') || normalized.includes('ARMHOLE') || normalized.includes('SHOULDER') || normalized.includes('NECK');
    if (isAux) return -1000;

    if (garment === 'PANTS' || garment === 'SHORTS' || garment === 'SKIRT') {
      if (normalized.includes('OUTSEAM')) return 125;
      if (normalized.includes('INSEAM')) return 120;
      if (normalized.includes('RISE')) return 110;
    }

    if (normalized.includes('BODY LENGTH')) return 120;
    if (normalized.includes('TOTAL LENGTH')) return 115;
    if (normalized.includes('LENGTH')) return 110;
    if (normalized.includes('INSEAM')) return 105;
    return -100;
  };

  const getWidthMeasurementPriority = (type) => {
    const normalized = String(type || '').toUpperCase();
    if (!normalized) return -1000;

    const isAux = normalized.includes('SLEEVE') || normalized.includes('ARMHOLE') || normalized.includes('SHOULDER') || normalized.includes('NECK');
    if (isAux) return -1000;

    if (normalized.includes('BODY WIDTH')) return 130;
    if (normalized.includes('CHEST') || normalized.includes('BUST')) return 125;
    if (normalized.includes('WAIST')) return 120;
    if (normalized.includes('HIP')) return 118;
    if (normalized.includes('WIDTH')) return 115;
    if (!isLengthMeasurement(normalized)) return 100;
    return -100;
  };

  if (hasProvidedMeasurements) {
    const ppi = modelMeasurementCalibration?.modelUnitsPerInch || getPixelsPerInch();
    let bestLengthMeasurement = null;
    let bestLengthPriority = -1000;
    let bestWidthMeasurement = null;
    let bestWidthPriority = -1000;

    for (const m of selectedMeasurements) {
      const type = String(m.measurementType || '').trim();
      const value = Number(m.value);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      const lengthPriority = getLengthMeasurementPriority(type, garmentType);
      if (lengthPriority > bestLengthPriority) {
        bestLengthPriority = lengthPriority;
        bestLengthMeasurement = m;
      }

      const widthPriority = getWidthMeasurementPriority(type);
      if (widthPriority > bestWidthPriority) {
        bestWidthPriority = widthPriority;
        bestWidthMeasurement = m;
      }
    }

    if (bestLengthMeasurement && bestLengthPriority > 0) {
      hasLengthMeasurement = true;
      lengthMeasurementType = String(bestLengthMeasurement.measurementType || '').trim();
      const lengthValue = Number(bestLengthMeasurement.value);
      const lengthWorldUnits = getPixelValueForMeasurement(
        lengthMeasurementType,
        lengthValue,
        currentClothingSizeLabel || ''
      );
      yScaleFactor = Number.isFinite(lengthWorldUnits)
        ? lengthWorldUnits / Math.max(0.0001, garmentSizeBefore.y)
        : (lengthValue * ppi) / Math.max(0.0001, garmentSizeBefore.y);
    }

    if (bestWidthMeasurement && bestWidthPriority > 0) {
      hasWidthMeasurement = true;
      widthMeasurementType = String(bestWidthMeasurement.measurementType || '').trim();
      const widthValue = Number(bestWidthMeasurement.value);
      const widthWorldUnits = getPixelValueForMeasurement(
        widthMeasurementType,
        widthValue,
        currentClothingSizeLabel || ''
      );
      const fallbackMultiplier = getCircumferenceMeasurementMultiplier(widthMeasurementType);
      const fallbackWidthWorldUnits = widthValue * ppi * fallbackMultiplier;
      xzScaleFactor = (Number.isFinite(widthWorldUnits) ? widthWorldUnits : fallbackWidthWorldUnits) / Math.max(0.0001, garmentSizeBefore.x);

      if (Number.isFinite(widthWorldUnits) && Number.isFinite(widthValue) && widthValue > 0 && Number.isFinite(ppi) && ppi > 0) {
        widthMeasurementMultiplier = widthWorldUnits / (widthValue * ppi);
      } else {
        widthMeasurementMultiplier = fallbackMultiplier;
      }
    }
  }

  generatedGarmentMesh.scale.set(
    generatedGarmentBaseScale * xzScaleFactor,
    generatedGarmentBaseScale * yScaleFactor,
    generatedGarmentBaseScale * xzScaleFactor
  );
  generatedGarmentMesh.updateMatrixWorld(true);

  // Safety invariant: garment should never be taller than the model in world space.
  const scaledGarmentBox = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  const scaledGarmentSize = scaledGarmentBox.getSize(new THREE_LIB.Vector3());
  const maxGarmentHeight = Math.max(0.0001, modelSize.y * 0.985);
  let heightClampRatio = 1;
  if (scaledGarmentSize.y > maxGarmentHeight) {
    heightClampRatio = maxGarmentHeight / Math.max(0.0001, scaledGarmentSize.y);
    generatedGarmentMesh.scale.set(
      generatedGarmentMesh.scale.x,
      generatedGarmentMesh.scale.y * heightClampRatio,
      generatedGarmentMesh.scale.z
    );
    generatedGarmentMesh.updateMatrixWorld(true);
  }

  const garmentBoxAfter = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  const garmentCenter = garmentBoxAfter.getCenter(new THREE_LIB.Vector3());
  const targetCenter = new THREE_LIB.Vector3(
    modelCenter.x,
    modelCenter.y + modelSize.y * fitProfile.yOffset,
    modelCenter.z
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
    lengthMeasurementType,
    widthMeasurementType,
    widthMeasurementMultiplier,
    heightClampRatio: Number(heightClampRatio.toFixed(4)),
    selectedSize: getSelectedSizeInches(),
    modelHeightInches: Number(getModelHeightInches().toFixed(2)),
    ppi: Number((modelMeasurementCalibration?.modelUnitsPerInch || getPixelsPerInch()).toFixed(6)),
    targetWidth: Number(targetWidthFromModel.toFixed(4)),
    targetHeight: Number(targetHeightFromModel.toFixed(4)),
  });
}

function clearGeneratedGarmentMesh() {
  garmentSimulationState = null;
  garmentSimulationLastTimestamp = 0;

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

function createGarmentMaterial(textureDataUrl = null, options = {}) {
  const useTexture = options.useTexture !== false;
  const materialOptions = {
    color: options.color ?? 0x8a8f99,
    side: THREE_LIB.DoubleSide,
    roughness: 0.86,
    metalness: 0.02,
  };

  if (textureDataUrl && useTexture) {
    const textureLoader = new THREE_LIB.TextureLoader();
    const texture = textureLoader.load(textureDataUrl);
    texture.flipY = true;
    materialOptions.map = texture;
    materialOptions.color = 0xffffff;
    materialOptions.transparent = true;
    // Keep low-alpha fabric detail visible (especially light/white garments).
    materialOptions.alphaTest = 0.02;
  }

  return new THREE_LIB.MeshStandardMaterial(materialOptions);
}

function isLowerBodyCollisionGarment(garmentType) {
  const type = String(garmentType || '').toLowerCase();
  return type === 'pants' || type === 'jeans' || type === 'shorts';
}

function startGarmentSimulation(modelPayload) {
  if (!THREE_LIB || !generatedGarmentMesh) return;
  if (!modelPayload) return;

  const simulationMesh = generatedGarmentMesh.isMesh
    ? generatedGarmentMesh
    : generatedGarmentMesh.getObjectByProperty?.('isMesh', true);
  if (!simulationMesh) return;

  const simulationMaterialArray = Array.isArray(simulationMesh.material)
    ? simulationMesh.material
    : [simulationMesh.material];
  const seamMaterial = simulationMesh?.userData?.seamMaterial
    || (simulationMaterialArray.length > 1 ? simulationMaterialArray[1] : null);

  const geometry = simulationMesh.geometry;
  const positionAttr = geometry?.attributes?.position;
  if (!positionAttr?.array || positionAttr.array.length < 9) return;

  const vertexCount = Math.floor(positionAttr.array.length / 3);
  if (vertexCount < 3 || vertexCount > 90000) return;

  const positions = positionAttr.array;
  const basePositions = Float32Array.from(positions);
  const velocities = new Float32Array(positions.length);
  const garmentType = getSelectedGarmentType();
  const isLowerBodyGarment = isLowerBodyCollisionGarment(garmentType);

  let minBaseZ = Infinity;
  let maxBaseZ = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const z = basePositions[vertex * 3 + 2];
    if (z < minBaseZ) minBaseZ = z;
    if (z > maxBaseZ) maxBaseZ = z;
  }
  const baseDepth = Math.max(0.001, maxBaseZ - minBaseZ);

  const panelIds = Array.isArray(modelPayload.panelIds) ? modelPayload.panelIds : null;
  const surfaceSides = Array.isArray(modelPayload.surfaceSides) ? modelPayload.surfaceSides : null;
  const seamPanelCount = Number.isFinite(Number(modelPayload.seamPanelCount)) ? Number(modelPayload.seamPanelCount) : 0;
  const pinnedFlags = Array.isArray(modelPayload.pinnedVertices)
    ? modelPayload.pinnedVertices.map((value) => Boolean(value))
    : new Array(vertexCount).fill(false);

  if (panelIds && seamPanelCount > 1 && panelIds.length >= vertexCount) {
    // Minimize explode so panels start close enough for seam closure.
    const explodeRadius = isLowerBodyGarment ? 0.025 : 0.012;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const side = surfaceSides && surfaceSides.length >= vertexCount
        ? (Number(surfaceSides[vertex]) || 0)
        : (Number(panelIds[vertex]) || 0) % 2;
      const zDir = side === 0 ? 1 : -1;
      positions[vertex * 3 + 2] += zDir * explodeRadius;
    }
  }

  const stitchPairs = Array.isArray(modelPayload.stitchPairs) ? modelPayload.stitchPairs : [];
  const selfCollisionPairs = Array.isArray(modelPayload.selfCollisionPairs) ? modelPayload.selfCollisionPairs : [];
  const seamVertexFlags = new Array(vertexCount).fill(false);
  const stitchPairKeySet = new Set();
  const restLengths = [];
  // Force seam closure: set rest length to a very small value.
  const seamRestLength = 0.0025;
  for (let pair = 0; pair < stitchPairs.length - 1; pair += 2) {
    const first = Number(stitchPairs[pair]);
    const second = Number(stitchPairs[pair + 1]);
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) {
      restLengths.push(0);
      continue;
    }

    seamVertexFlags[first] = true;
    seamVertexFlags[second] = true;
    stitchPairKeySet.add(`${Math.min(first, second)}:${Math.max(first, second)}`);
    restLengths.push(seamRestLength);
  }

  // Pre-stitch: snap ALL seam pair vertices to their XY midpoint so they start AT the body
  // sides rather than on the front/back face. Without this the seam force fires straight through
  // the body, collision blocks it every frame, and the seam never closes.
  // After snapping, basePositions is updated for seam vertices so the memory term doesn't
  // drag them back to their pre-snap positions.
  for (let pair = 0; pair < stitchPairs.length - 1; pair += 2) {
    const first = Number(stitchPairs[pair]);
    const second = Number(stitchPairs[pair + 1]);
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;
    if (pinnedFlags[first] && pinnedFlags[second]) continue;
    const fi = first * 3;
    const si = second * 3;
    const midX = (positions[fi]     + positions[si])     * 0.5;
    const midY = (positions[fi + 1] + positions[si + 1]) * 0.5;
    const midZ = (positions[fi + 2] + positions[si + 2]) * 0.5;
    if (!pinnedFlags[first]) {
      positions[fi]     = midX;
      positions[fi + 1] = midY;
      positions[fi + 2] = midZ;
    }
    if (!pinnedFlags[second]) {
      positions[si]     = midX;
      positions[si + 1] = midY;
      positions[si + 2] = midZ;
    }
  }

  const indexArray = geometry?.index?.array;
  const structuralPairs = [];
  const structuralRestLengths = [];
  const bendPairs = [];
  const bendRestLengths = [];
  if (indexArray && indexArray.length >= 3) {
    const edgeKeys = new Set();
    const edgeToOpposites = new Map();
    const addStructuralEdge = (first, second) => {
      if (!Number.isInteger(first) || !Number.isInteger(second)) return;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount || first === second) return;

      if (surfaceSides && surfaceSides.length >= vertexCount) {
        const firstSide = Number(surfaceSides[first]);
        const secondSide = Number(surfaceSides[second]);
        if (Number.isFinite(firstSide) && Number.isFinite(secondSide) && firstSide !== secondSide) {
          return;
        }
      }

      const min = Math.min(first, second);
      const max = Math.max(first, second);
      const key = `${min}:${max}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);

      const firstBase = first * 3;
      const secondBase = second * 3;
      const dx = basePositions[firstBase] - basePositions[secondBase];
      const dy = basePositions[firstBase + 1] - basePositions[secondBase + 1];
      const dz = basePositions[firstBase + 2] - basePositions[secondBase + 2];
      const restLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!Number.isFinite(restLength) || restLength <= 1e-6) return;

      structuralPairs.push(first, second);
      structuralRestLengths.push(restLength);
    };

    const addBendPair = (first, second) => {
      if (!Number.isInteger(first) || !Number.isInteger(second)) return;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount || first === second) return;

      if (surfaceSides && surfaceSides.length >= vertexCount) {
        const firstSide = Number(surfaceSides[first]);
        const secondSide = Number(surfaceSides[second]);
        if (Number.isFinite(firstSide) && Number.isFinite(secondSide) && firstSide !== secondSide) {
          return;
        }
      }

      const min = Math.min(first, second);
      const max = Math.max(first, second);
      const key = `${min}:${max}`;
      if (edgeKeys.has(`bend:${key}`)) return;
      edgeKeys.add(`bend:${key}`);

      const firstBase = first * 3;
      const secondBase = second * 3;
      const dx = basePositions[firstBase] - basePositions[secondBase];
      const dy = basePositions[firstBase + 1] - basePositions[secondBase + 1];
      const dz = basePositions[firstBase + 2] - basePositions[secondBase + 2];
      const restLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!Number.isFinite(restLength) || restLength <= 1e-6) return;

      bendPairs.push(first, second);
      bendRestLengths.push(restLength);
    };

    for (let tri = 0; tri < indexArray.length - 2; tri += 3) {
      const i0 = Number(indexArray[tri]);
      const i1 = Number(indexArray[tri + 1]);
      const i2 = Number(indexArray[tri + 2]);
      addStructuralEdge(i0, i1);
      addStructuralEdge(i1, i2);
      addStructuralEdge(i2, i0);

      const e01 = `${Math.min(i0, i1)}:${Math.max(i0, i1)}`;
      const e12 = `${Math.min(i1, i2)}:${Math.max(i1, i2)}`;
      const e20 = `${Math.min(i2, i0)}:${Math.max(i2, i0)}`;

      if (!edgeToOpposites.has(e01)) edgeToOpposites.set(e01, []);
      if (!edgeToOpposites.has(e12)) edgeToOpposites.set(e12, []);
      if (!edgeToOpposites.has(e20)) edgeToOpposites.set(e20, []);

      edgeToOpposites.get(e01).push(i2);
      edgeToOpposites.get(e12).push(i0);
      edgeToOpposites.get(e20).push(i1);
    }

    for (const oppositeVertices of edgeToOpposites.values()) {
      if (!Array.isArray(oppositeVertices) || oppositeVertices.length < 2) continue;
      const first = Number(oppositeVertices[0]);
      const second = Number(oppositeVertices[1]);
      addBendPair(first, second);
    }
  }

  // Lock a stable front/back collision side per vertex from the base geometry.
  const baseMidZ = (minBaseZ + maxBaseZ) * 0.5;
  const collisionSideFlags = new Uint8Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    collisionSideFlags[vertex] = basePositions[vertex * 3 + 2] >= baseMidZ ? 0 : 1;
  }

  // For top garments: compute the max Y of pinned (shoulder/collar) vertices so the
  // simulation can clamp free vertices below this ceiling — prevents fabric from rising
  // up over the head.
  let maxPinnedY = -Infinity;
  if (!isLowerBodyGarment) {
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (pinnedFlags[vertex]) {
        const py = basePositions[vertex * 3 + 1];
        if (py > maxPinnedY) maxPinnedY = py;
      }
    }
  }
  if (!Number.isFinite(maxPinnedY)) maxPinnedY = 0;

  // --- Initial panel placement around the body ---
  // The garment mesh is scaled to match the avatar, so garment-local Z ~= +-0.006 (raw
  // backend values) does NOT reach the body surface after scaling.  Build the collision
  // cloud now to find the actual front (mxZ) and back (mnZ) surfaces in garment-local
  // space, then shift each panel so it starts just OUTSIDE its side of the body.
  let initialBodyCloud = null;
  if (panelIds && seamPanelCount > 1 && currentModel) {
    try {
      simulationMesh.updateMatrixWorld(true);
      currentModel.updateMatrixWorld(true);
      initialBodyCloud = buildBodyCollisionCloud(currentModel, simulationMesh, generatedGarmentMesh);
    } catch (_e) {
      initialBodyCloud = null;
    }
  }
  if (initialBodyCloud && initialBodyCloud.triangleCount > 0) {
    const bodyFrontZ = initialBodyCloud.mxZ;
    const bodyBackZ  = initialBodyCloud.mnZ;
    const INIT_GAP   = 0.02;
    let frontZSum = 0, frontCount = 0, backZSum = 0, backCount = 0;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const side = surfaceSides && surfaceSides.length >= vertexCount
        ? (Number(surfaceSides[vertex]) || 0)
        : (Number(panelIds[vertex]) || 0) % 2;
      const vz = positions[vertex * 3 + 2];
      if (side === 0) { frontZSum += vz; frontCount += 1; }
      else             { backZSum  += vz; backCount  += 1; }
    }
    const frontZAvg  = frontCount > 0 ? frontZSum / frontCount : 0.05;
    const backZAvg   = backCount  > 0 ? backZSum  / backCount  : -0.05;
    const frontShift = (bodyFrontZ + INIT_GAP) - frontZAvg;
    const backShift  = (bodyBackZ  - INIT_GAP) - backZAvg;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const side = surfaceSides && surfaceSides.length >= vertexCount
        ? (Number(surfaceSides[vertex]) || 0)
        : (Number(panelIds[vertex]) || 0) % 2;
      positions[vertex * 3 + 2] += side === 0 ? frontShift : backShift;
    }
    // Update the memory-term anchor so it doesn't pull panels back inside the body.
    basePositions.set(positions);
  }

  // After all placement and pre-snapping: update basePositions for seam vertices so the
  // memory term doesn't fight the seam closure by pulling vertices back to their original positions.
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (seamVertexFlags[vertex]) {
      basePositions[vertex * 3]     = positions[vertex * 3];
      basePositions[vertex * 3 + 1] = positions[vertex * 3 + 1];
      basePositions[vertex * 3 + 2] = positions[vertex * 3 + 2];
    }
  }
  garmentSimulationState = {
    simulationMesh,
    seamMaterial,
    geometry,
    positionAttr,
    positions,
    basePositions,
    velocities,
    vertexCount,
    pinnedFlags,
    structuralPairs,
    structuralRestLengths,
    bendPairs,
    bendRestLengths,
    stitchPairs,
    restLengths,
    selfCollisionPairs,
    stitchPairKeySet,
    collisionSideFlags,
    surfaceSides,
    seamVertexFlags,
    garmentType,
    seamPanelCount,
    maxPinnedY,
    stitchPairPhase: 0,
    bodyCloud: initialBodyCloud || null,
    frame: 0,
    lastGarmentWorldMatrix: Float32Array.from(simulationMesh.matrixWorld.elements),
    stitchAccumDeltaX: new Float32Array(vertexCount),
    stitchAccumDeltaY: new Float32Array(vertexCount),
    stitchAccumDeltaZ: new Float32Array(vertexCount),
    stitchAccumWeight: new Float32Array(vertexCount),
    stitchTouchedVertices: new Int32Array(vertexCount),
    seamStretchVisual: 0,
  };

  garmentSimulationLastTimestamp = 0;
  updateDebugPanel('Started continuous garment simulation.', {
    vertexCount,
    structuralEdgeCount: Math.floor(structuralPairs.length / 2),
    bendPairCount: Math.floor(bendPairs.length / 2),
    stitchPairCount: Math.floor(stitchPairs.length / 2),
    selfCollisionPairCount: Math.floor(selfCollisionPairs.length / 2),
    seamPanelCount,
  });
}// Build once at simulation start: triangle mesh body collider in garment-local space.

// Build once at simulation start: triangle mesh body collider in garment-local space.
function buildBodyCollisionCloud(model, garmentMesh, excludeRoot = garmentMesh) {
  if (!model || !garmentMesh || !THREE_LIB) return null;

  const isUnderGarmentMesh = (node) => {
    let current = node;
    while (current) {
      if (current === excludeRoot) return true;
      current = current.parent;
    }
    return false;
  };

  const triAx = [];
  const triAy = [];
  const triAz = [];
  const triBx = [];
  const triBy = [];
  const triBz = [];
  const triCx = [];
  const triCy = [];
  const triCz = [];
  const triNx = [];
  const triNy = [];
  const triNz = [];

  let mnX = Infinity;
  let mxX = -Infinity;
  let mnY = Infinity;
  let mxY = -Infinity;
  let mnZ = Infinity;
  let mxZ = -Infinity;

  const invWorld = garmentMesh.matrixWorld.clone().invert();
  const tempLocal = new THREE_LIB.Vector3();
  const tempA = new THREE_LIB.Vector3();
  const tempB = new THREE_LIB.Vector3();
  const tempC = new THREE_LIB.Vector3();

  model.traverse((child) => {
    if (isUnderGarmentMesh(child)) return;
    if (!child.isMesh || !child.geometry) return;
    const posAttr = child.geometry.attributes?.position;
    if (!posAttr || posAttr.count < 3) return;

    const localToGarment = new THREE_LIB.Matrix4().multiplyMatrices(invWorld, child.matrixWorld);
    const index = child.geometry.index?.array;
    const triCount = index ? Math.floor(index.length / 3) : Math.floor(posAttr.count / 3);
    if (triCount <= 0) return;

    const triStride = Math.max(1, Math.floor(triCount / 7000));
    const isSkinned = Boolean(child.isSkinnedMesh && typeof child.boneTransform === 'function');

    const readVertex = (vertexIndex, out) => {
      if (isSkinned) {
        tempLocal.set(posAttr.getX(vertexIndex), posAttr.getY(vertexIndex), posAttr.getZ(vertexIndex));
        child.boneTransform(vertexIndex, tempLocal);
        out.copy(tempLocal).applyMatrix4(localToGarment);
      } else {
        out.set(posAttr.getX(vertexIndex), posAttr.getY(vertexIndex), posAttr.getZ(vertexIndex)).applyMatrix4(localToGarment);
      }
    };

    for (let t = 0; t < triCount; t += triStride) {
      const i0 = index ? Number(index[t * 3]) : t * 3;
      const i1 = index ? Number(index[t * 3 + 1]) : t * 3 + 1;
      const i2 = index ? Number(index[t * 3 + 2]) : t * 3 + 2;
      if (!Number.isInteger(i0) || !Number.isInteger(i1) || !Number.isInteger(i2)) continue;
      if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= posAttr.count || i1 >= posAttr.count || i2 >= posAttr.count) continue;

      readVertex(i0, tempA);
      readVertex(i1, tempB);
      readVertex(i2, tempC);

      const abx = tempB.x - tempA.x;
      const aby = tempB.y - tempA.y;
      const abz = tempB.z - tempA.z;
      const acx = tempC.x - tempA.x;
      const acy = tempC.y - tempA.y;
      const acz = tempC.z - tempA.z;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen < 1e-8) continue;

      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      triAx.push(tempA.x); triAy.push(tempA.y); triAz.push(tempA.z);
      triBx.push(tempB.x); triBy.push(tempB.y); triBz.push(tempB.z);
      triCx.push(tempC.x); triCy.push(tempC.y); triCz.push(tempC.z);
      triNx.push(nx); triNy.push(ny); triNz.push(nz);

      mnX = Math.min(mnX, tempA.x, tempB.x, tempC.x);
      mxX = Math.max(mxX, tempA.x, tempB.x, tempC.x);
      mnY = Math.min(mnY, tempA.y, tempB.y, tempC.y);
      mxY = Math.max(mxY, tempA.y, tempB.y, tempC.y);
      mnZ = Math.min(mnZ, tempA.z, tempB.z, tempC.z);
      mxZ = Math.max(mxZ, tempA.z, tempB.z, tempC.z);
    }
  });

  const triangleCount = triAx.length;
  if (triangleCount === 0) return null;

  let cs = 0.08;
  let ic = 1.0 / cs;
  let ox = Math.floor(mnX * ic) - 1;
  let oy = Math.floor(mnY * ic) - 1;
  let oz = Math.floor(mnZ * ic) - 1;
  let gW = Math.floor(mxX * ic) + 2 - ox;
  let gH = Math.floor(mxY * ic) + 2 - oy;
  let gD = Math.floor(mxZ * ic) + 2 - oz;
  let gTotal = gW * gH * gD;
  const GRID_BUDGET = 220000;
  while (gTotal > GRID_BUDGET) {
    cs *= 1.45;
    ic = 1.0 / cs;
    ox = Math.floor(mnX * ic) - 1;
    oy = Math.floor(mnY * ic) - 1;
    oz = Math.floor(mnZ * ic) - 1;
    gW = Math.floor(mxX * ic) + 2 - ox;
    gH = Math.floor(mxY * ic) + 2 - oy;
    gD = Math.floor(mxZ * ic) + 2 - oz;
    gTotal = gW * gH * gD;
  }

  if (gTotal <= 0 || !Number.isFinite(gTotal)) return null;

  const MAX_PER = 48;
  const cellCount = new Int32Array(gTotal);
  const cellData = new Int32Array(gTotal * MAX_PER).fill(-1);
  let droppedCellRefs = 0;

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const minX = Math.min(triAx[tri], triBx[tri], triCx[tri]);
    const maxX = Math.max(triAx[tri], triBx[tri], triCx[tri]);
    const minY = Math.min(triAy[tri], triBy[tri], triCy[tri]);
    const maxY = Math.max(triAy[tri], triBy[tri], triCy[tri]);
    const minZ = Math.min(triAz[tri], triBz[tri], triCz[tri]);
    const maxZ = Math.max(triAz[tri], triBz[tri], triCz[tri]);

    const cxMin = Math.max(0, Math.floor(minX * ic) - ox);
    const cxMax = Math.min(gW - 1, Math.floor(maxX * ic) - ox);
    const cyMin = Math.max(0, Math.floor(minY * ic) - oy);
    const cyMax = Math.min(gH - 1, Math.floor(maxY * ic) - oy);
    const czMin = Math.max(0, Math.floor(minZ * ic) - oz);
    const czMax = Math.min(gD - 1, Math.floor(maxZ * ic) - oz);

    for (let cx = cxMin; cx <= cxMax; cx += 1) {
      for (let cy = cyMin; cy <= cyMax; cy += 1) {
        for (let cz = czMin; cz <= czMax; cz += 1) {
          const gi = (cx * gH + cy) * gD + cz;
          const n = cellCount[gi];
          if (n < MAX_PER) {
            cellData[gi * MAX_PER + n] = tri;
            cellCount[gi] = n + 1;
          } else {
            droppedCellRefs += 1;
          }
        }
      }
    }
  }

  return {
    triAx: Float32Array.from(triAx),
    triAy: Float32Array.from(triAy),
    triAz: Float32Array.from(triAz),
    triBx: Float32Array.from(triBx),
    triBy: Float32Array.from(triBy),
    triBz: Float32Array.from(triBz),
    triCx: Float32Array.from(triCx),
    triCy: Float32Array.from(triCy),
    triCz: Float32Array.from(triCz),
    triNx: Float32Array.from(triNx),
    triNy: Float32Array.from(triNy),
    triNz: Float32Array.from(triNz),
    triangleCount,
    cellData,
    cellCount,
    cs,
    ic,
    ox,
    oy,
    oz,
    gW,
    gH,
    gD,
    MAX_PER,
    droppedCellRefs,
    mnX,
    mxX,
    mnY,
    mxY,
    mnZ,
    mxZ,
    triVisited: new Int32Array(triangleCount),
    triVisitStamp: 1,
    hasSkinnedMesh: Boolean(model.getObjectByProperty && model.getObjectByProperty('isSkinnedMesh', true)),
  };
}

// Zero-allocation scratch space for closestPointOnTriangle.
let _cpX = 0, _cpY = 0, _cpZ = 0;

function closestPointOnTriangle(vx, vy, vz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = vx - ax, apy = vy - ay, apz = vz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { _cpX = ax; _cpY = ay; _cpZ = az; return; }

  const bpx = vx - bx, bpy = vy - by, bpz = vz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { _cpX = bx; _cpY = by; _cpZ = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    _cpX = ax + abx * v; _cpY = ay + aby * v; _cpZ = az + abz * v; return;
  }

  const cpx2 = vx - cx, cpy2 = vy - cy, cpz2 = vz - cz;
  const d5 = abx * cpx2 + aby * cpy2 + abz * cpz2;
  const d6 = acx * cpx2 + acy * cpy2 + acz * cpz2;
  if (d6 >= 0 && d5 <= d6) { _cpX = cx; _cpY = cy; _cpZ = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    _cpX = ax + acx * w; _cpY = ay + acy * w; _cpZ = az + acz * w; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    _cpX = bx + (cx - bx) * w; _cpY = by + (cy - by) * w; _cpZ = bz + (cz - bz) * w; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  _cpX = ax + abx * v + acx * w;
  _cpY = ay + aby * v + acy * w;
  _cpZ = az + abz * v + acz * w;
}

function applyBodyMeshCollision(positions, velocities, pinnedFlags, vertexCount, cloud) {
  if (!cloud || !cloud.cellData || !cloud.triangleCount) return 0;
  const {
    triAx, triAy, triAz,
    triBx, triBy, triBz,
    triCx, triCy, triCz,
    triNx, triNy, triNz,
    triangleCount,
    cellData,
    cellCount,
    ic,
    ox,
    oy,
    oz,
    gW,
    gH,
    gD,
    MAX_PER,
    cs,
    mnX,
    mxX,
    mnY,
    mxY,
    mnZ,
    mxZ,
  } = cloud;

  const THICK = Math.max(0.028, cs * 0.55);
  const centerX = (mnX + mxX) * 0.5;
  const centerY = (mnY + mxY) * 0.5;
  const centerZ = (mnZ + mxZ) * 0.5;
  const visited = cloud.triVisited && cloud.triVisited.length === triangleCount
    ? cloud.triVisited
    : new Int32Array(triangleCount);
  let stamp = Number.isFinite(Number(cloud.triVisitStamp)) ? Number(cloud.triVisitStamp) : 1;

  let correctedCount = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    if (pinnedFlags[v]) continue;
    const vi = v * 3;
    const vx = positions[vi];
    const vy = positions[vi + 1];
    const vz = positions[vi + 2];

    const cx0 = Math.floor(vx * ic) - ox;
    const cy0 = Math.floor(vy * ic) - oy;
    const cz0 = Math.floor(vz * ic) - oz;

    let bestPen = 0;
    let pushX = 0, pushY = 0, pushZ = 0;
    let foundCandidate = false;

    // Search neighborhood of increasing radius.  Radius 1-2 covers normal proximity;
    // radius 3-4 catches vertices that have tunneled deeper into the body mesh.
    outerSearch: for (let radius = 1; radius <= 4; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= gW) continue;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const cy = cy0 + dy;
          if (cy < 0 || cy >= gH) continue;
          for (let dz = -radius; dz <= radius; dz += 1) {
            const cz = cz0 + dz;
            if (cz < 0 || cz >= gD) continue;

            const gi = (cx * gH + cy) * gD + cz;
            const n = cellCount[gi];
            if (n <= 0) continue;
            const base = gi * MAX_PER;

            for (let j = 0; j < n; j += 1) {
              const tri = cellData[base + j];
              if (tri < 0 || visited[tri] === stamp) continue;
              visited[tri] = stamp;
              foundCandidate = true;

              closestPointOnTriangle(
                vx, vy, vz,
                triAx[tri], triAy[tri], triAz[tri],
                triBx[tri], triBy[tri], triBz[tri],
                triCx[tri], triCy[tri], triCz[tri]
              );

              const toVX = vx - _cpX;
              const toVY = vy - _cpY;
              const toVZ = vz - _cpZ;
              const distSq = toVX * toVX + toVY * toVY + toVZ * toVZ;
              const dist = Math.sqrt(Math.max(1e-12, distSq));

              // Orient triangle normal to point away from body center.
              let nX = triNx[tri];
              let nY = triNy[tri];
              let nZ = triNz[tri];
              const cpx = _cpX - centerX;
              const cpy = _cpY - centerY;
              const cpz = _cpZ - centerZ;
              if (nX * cpx + nY * cpy + nZ * cpz < 0) {
                nX = -nX;
                nY = -nY;
                nZ = -nZ;
              }

              const signed = toVX * nX + toVY * nY + toVZ * nZ;
              let pen = 0;
              let candX = 0;
              let candY = 0;
              let candZ = 0;

              if (signed < 0) {
                // Inside body side of surface: force outward along oriented normal.
                pen = Math.abs(signed) + THICK;
                candX = nX;
                candY = nY;
                candZ = nZ;
              } else {
                // Outside but close: maintain clearance thickness.
                pen = THICK - dist;
                if (dist > 1e-10) {
                  const invDist = 1 / dist;
                  candX = toVX * invDist;
                  candY = toVY * invDist;
                  candZ = toVZ * invDist;
                } else {
                  candX = nX;
                  candY = nY;
                  candZ = nZ;
                }
              }

              if (pen <= 0 || pen <= bestPen) continue;
              bestPen = pen;
              pushX = candX;
              pushY = candY;
              pushZ = candZ;
            }
          }
        }
      }
      if (foundCandidate) break outerSearch;
    }

    stamp += 1;
    if (stamp === 2147483647) { visited.fill(0); stamp = 1; }

    if (bestPen > 0) {
      positions[vi]     += pushX * bestPen;
      positions[vi + 1] += pushY * bestPen;
      positions[vi + 2] += pushZ * bestPen;
      correctedCount += 1;

      const vn = velocities[vi] * pushX + velocities[vi + 1] * pushY + velocities[vi + 2] * pushZ;
      if (vn < 0) {
        velocities[vi] -= vn * pushX;
        velocities[vi + 1] -= vn * pushY;
        velocities[vi + 2] -= vn * pushZ;
      }
    }
  }

  cloud.triVisited = visited;
  cloud.triVisitStamp = stamp;
  return correctedCount;
}

function applyBodyBoundsFallbackCollision(positions, velocities, pinnedFlags, vertexCount, boundsBox) {
  if (!boundsBox) return;

  const minX = boundsBox.min.x;
  const maxX = boundsBox.max.x;
  const minY = boundsBox.min.y;
  const maxY = boundsBox.max.y;
  const minZ = boundsBox.min.z;
  const maxZ = boundsBox.max.z;
  const guard = 0.01;
  const minXi = minX + guard;
  const maxXi = maxX - guard;
  const minYi = minY + guard;
  const maxYi = maxY - guard;
  const minZi = minZ + guard;
  const maxZi = maxZ - guard;
  const pushOut = 0.0025;

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (pinnedFlags[vertex]) continue;

    const base = vertex * 3;
    const px = positions[base];
    const py = positions[base + 1];
    const pz = positions[base + 2];

    if (px <= minXi || px >= maxXi || py <= minYi || py >= maxYi || pz <= minZi || pz >= maxZi) {
      continue;
    }

    const dMinX = Math.abs(px - minXi);
    const dMaxX = Math.abs(maxXi - px);
    const dMinY = Math.abs(py - minYi);
    const dMaxY = Math.abs(maxYi - py);
    const dMinZ = Math.abs(pz - minZi);
    const dMaxZ = Math.abs(maxZi - pz);

    let nx = -1;
    let ny = 0;
    let nz = 0;
    let nearest = dMinX;

    if (dMaxX < nearest) { nearest = dMaxX; nx = 1; ny = 0; nz = 0; }
    if (dMinY < nearest) { nearest = dMinY; nx = 0; ny = -1; nz = 0; }
    if (dMaxY < nearest) { nearest = dMaxY; nx = 0; ny = 1; nz = 0; }
    if (dMinZ < nearest) { nearest = dMinZ; nx = 0; ny = 0; nz = -1; }
    if (dMaxZ < nearest) { nearest = dMaxZ; nx = 0; ny = 0; nz = 1; }

    const amount = Math.min(0.0045, Math.max(pushOut, nearest * 0.25 + pushOut));
    positions[base] += nx * amount;
    positions[base + 1] += ny * amount;
    positions[base + 2] += nz * amount;

    const vn = velocities[base] * nx + velocities[base + 1] * ny + velocities[base + 2] * nz;
    if (vn < 0) {
      velocities[base] -= vn * nx;
      velocities[base + 1] -= vn * ny;
      velocities[base + 2] -= vn * nz;
    }
  }
}

function applyBodyGhostGuardCollision(positions, velocities, pinnedFlags, vertexCount, boundsBox) {
  if (!boundsBox) return;

  // Guard band keeps this from over-correcting surface-near vertices.
  const guard = 0.01;
  const minX = boundsBox.min.x + guard;
  const maxX = boundsBox.max.x - guard;
  const minY = boundsBox.min.y + guard;
  const maxY = boundsBox.max.y - guard;
  const minZ = boundsBox.min.z + guard;
  const maxZ = boundsBox.max.z - guard;

  if (minX >= maxX || minY >= maxY || minZ >= maxZ) return;

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (pinnedFlags[vertex]) continue;

    const base = vertex * 3;
    const px = positions[base];
    const py = positions[base + 1];
    const pz = positions[base + 2];

    if (px <= minX || px >= maxX || py <= minY || py >= maxY || pz <= minZ || pz >= maxZ) {
      continue;
    }

    const dMinX = Math.abs(px - minX);
    const dMaxX = Math.abs(maxX - px);
    const dMinY = Math.abs(py - minY);
    const dMaxY = Math.abs(maxY - py);
    const dMinZ = Math.abs(pz - minZ);
    const dMaxZ = Math.abs(maxZ - pz);

    let nx = -1;
    let ny = 0;
    let nz = 0;
    let push = dMinX;

    if (dMaxX < push) { push = dMaxX; nx = 1; ny = 0; nz = 0; }
    if (dMinY < push) { push = dMinY; nx = 0; ny = -1; nz = 0; }
    if (dMaxY < push) { push = dMaxY; nx = 0; ny = 1; nz = 0; }
    if (dMinZ < push) { push = dMinZ; nx = 0; ny = 0; nz = -1; }
    if (dMaxZ < push) { push = dMaxZ; nx = 0; ny = 0; nz = 1; }

    const outPush = Math.min(0.01, Math.max(0.002, push + 0.004));
    positions[base] += nx * outPush;
    positions[base + 1] += ny * outPush;
    positions[base + 2] += nz * outPush;

    const vn = velocities[base] * nx + velocities[base + 1] * ny + velocities[base + 2] * nz;
    if (vn < 0) {
      velocities[base] -= vn * nx;
      velocities[base + 1] -= vn * ny;
      velocities[base + 2] -= vn * nz;
    }
  }
}

function applyHardWorldContainmentCollision(positions, velocities, pinnedFlags, vertexCount, currentModel, simulationMesh) {
  if (!THREE_LIB || !currentModel || !simulationMesh?.matrixWorld) return 0;

  const worldBounds = new THREE_LIB.Box3().setFromObject(currentModel);
  if (worldBounds.isEmpty()) return 0;

  const invWorld = new THREE_LIB.Matrix4().copy(simulationMesh.matrixWorld).invert();
  const pWorld = new THREE_LIB.Vector3();
  const pLocal = new THREE_LIB.Vector3();

  const guard = 0.012;
  const minX = worldBounds.min.x + guard;
  const maxX = worldBounds.max.x - guard;
  const minY = worldBounds.min.y + guard;
  const maxY = worldBounds.max.y - guard;
  const minZ = worldBounds.min.z + guard;
  const maxZ = worldBounds.max.z - guard;

  if (minX >= maxX || minY >= maxY || minZ >= maxZ) return 0;

  let contacts = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (pinnedFlags[vertex]) continue;

    const base = vertex * 3;
    pWorld.set(positions[base], positions[base + 1], positions[base + 2]).applyMatrix4(simulationMesh.matrixWorld);

    if (pWorld.x <= minX || pWorld.x >= maxX || pWorld.y <= minY || pWorld.y >= maxY || pWorld.z <= minZ || pWorld.z >= maxZ) {
      continue;
    }

    const dMinX = Math.abs(pWorld.x - minX);
    const dMaxX = Math.abs(maxX - pWorld.x);
    const dMinY = Math.abs(pWorld.y - minY);
    const dMaxY = Math.abs(maxY - pWorld.y);
    const dMinZ = Math.abs(pWorld.z - minZ);
    const dMaxZ = Math.abs(maxZ - pWorld.z);

    let nx = -1;
    let ny = 0;
    let nz = 0;
    let nearest = dMinX;

    if (dMaxX < nearest) { nearest = dMaxX; nx = 1; ny = 0; nz = 0; }
    if (dMinY < nearest) { nearest = dMinY; nx = 0; ny = -1; nz = 0; }
    if (dMaxY < nearest) { nearest = dMaxY; nx = 0; ny = 1; nz = 0; }
    if (dMinZ < nearest) { nearest = dMinZ; nx = 0; ny = 0; nz = -1; }
    if (dMaxZ < nearest) { nearest = dMaxZ; nx = 0; ny = 0; nz = 1; }

    const amount = Math.min(0.012, Math.max(0.004, nearest + 0.004));
    pWorld.x += nx * amount;
    pWorld.y += ny * amount;
    pWorld.z += nz * amount;

    pLocal.copy(pWorld).applyMatrix4(invWorld);
    positions[base] = pLocal.x;
    positions[base + 1] = pLocal.y;
    positions[base + 2] = pLocal.z;

    const vn = velocities[base] * nx + velocities[base + 1] * ny + velocities[base + 2] * nz;
    if (vn < 0) {
      velocities[base] -= vn * nx;
      velocities[base + 1] -= vn * ny;
      velocities[base + 2] -= vn * nz;
    }
    contacts += 1;
  }

  return contacts;
}

function applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, cloud, garmentType, surfaceSides = null) {
  if (!cloud || !Number.isFinite(cloud.mnX) || !Number.isFinite(cloud.mxX)) return 0;
  if (!isLowerBodyCollisionGarment(garmentType)) return 0;

  const minX = cloud.mnX;
  const maxX = cloud.mxX;
  const minY = cloud.mnY;
  const maxY = cloud.mxY;
  const minZ = cloud.mnZ;
  const maxZ = cloud.mxZ;

  const bodyWidth = Math.max(0.05, maxX - minX);
  const bodyDepth = Math.max(0.04, maxZ - minZ);
  const bodyHeight = Math.max(0.2, maxY - minY);

  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const hipY = minY + bodyHeight * 0.78;
  const ankleY = minY + bodyHeight * 0.04;
  const segmentY = hipY - ankleY;
  if (segmentY <= 1e-5) return 0;

  // Estimate left/right leg centerlines from lower-body collider triangles when available.
  let leftCenterX = centerX - bodyWidth * 0.14;
  let rightCenterX = centerX + bodyWidth * 0.14;
  let leftCenterZ = centerZ;
  let rightCenterZ = centerZ;
  if (cloud.triAx && cloud.triAy && cloud.triAz && cloud.triangleCount) {
    let lCount = 0;
    let rCount = 0;
    let lSumX = 0;
    let rSumX = 0;
    let lSumZ = 0;
    let rSumZ = 0;
    const yMinBand = minY + bodyHeight * 0.12;
    const yMaxBand = minY + bodyHeight * 0.64;

    for (let tri = 0; tri < cloud.triangleCount; tri += 1) {
      const cx = (cloud.triAx[tri] + cloud.triBx[tri] + cloud.triCx[tri]) / 3;
      const cy = (cloud.triAy[tri] + cloud.triBy[tri] + cloud.triCy[tri]) / 3;
      const cz = (cloud.triAz[tri] + cloud.triBz[tri] + cloud.triCz[tri]) / 3;
      if (cy < yMinBand || cy > yMaxBand) continue;

      if (cx < centerX) {
        lSumX += cx;
        lSumZ += cz;
        lCount += 1;
      } else {
        rSumX += cx;
        rSumZ += cz;
        rCount += 1;
      }
    }

    if (lCount >= 10) {
      leftCenterX = lSumX / lCount;
      leftCenterZ = lSumZ / lCount;
    }
    if (rCount >= 10) {
      rightCenterX = rSumX / rCount;
      rightCenterZ = rSumZ / rCount;
    }
  }

  // Keep leg axes stable and symmetric to prevent one-side ballooning from noisy sampling.
  const estLeftGap = Math.max(0, centerX - leftCenterX);
  const estRightGap = Math.max(0, rightCenterX - centerX);
  const symmetricGap = Math.max(bodyWidth * 0.11, Math.min(bodyWidth * 0.2, (estLeftGap + estRightGap) * 0.5));
  leftCenterX = centerX - symmetricGap;
  rightCenterX = centerX + symmetricGap;

  const maxZOffset = bodyDepth * 0.12;
  leftCenterZ = centerZ + Math.max(-maxZOffset, Math.min(maxZOffset, leftCenterZ - centerZ));
  rightCenterZ = centerZ + Math.max(-maxZOffset, Math.min(maxZOffset, rightCenterZ - centerZ));
  const avgCenterZ = (leftCenterZ + rightCenterZ) * 0.5;
  leftCenterZ = avgCenterZ;
  rightCenterZ = avgCenterZ;

  const legRadius = Math.max(0.022, Math.min(bodyWidth * 0.092, bodyDepth * 0.29));
  const maxInfluence = legRadius + 0.02;
  const centerNoPushBand = bodyWidth * 0.012;

  const capsuleDistance = (vx, vy, vz, capsuleX, capsuleZ) => {
    const t = Math.max(0, Math.min(1, (vy - ankleY) / segmentY));
    const py = ankleY + segmentY * t;
    const dx = vx - capsuleX;
    const dy = vy - py;
    const dz = vz - capsuleZ;
    const radialSq = dx * dx + dz * dz;
    const radial = Math.sqrt(Math.max(1e-12, radialSq));
    return { radial, dx, dy, dz };
  };

  let contacts = 0;

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const pinScale = pinnedFlags[vertex] ? 0.35 : 1.0;
    const index = vertex * 3;
    const vx = positions[index];
    const vy = positions[index + 1];
    const vz = positions[index + 2];

    if (vy > hipY + 0.1 || vy < ankleY - 0.06) continue;

    const left = capsuleDistance(vx, vy, vz, leftCenterX, leftCenterZ);
    const right = capsuleDistance(vx, vy, vz, rightCenterX, rightCenterZ);
    const best = left.radial < right.radial ? left : right;

    // Keep a tiny no-push center band only to avoid seam blow-up; still allow contact around inner thighs.
    if (Math.abs(vx - centerX) < centerNoPushBand && best.radial > legRadius * 0.96) continue;
    if (best.radial >= maxInfluence) continue;

    const inv = 1 / Math.max(1e-6, best.radial);
    const penetration = legRadius - best.radial;
    const push = penetration > 0
      ? Math.min(0.0045, penetration * 0.62)
      : Math.min(0.0012, (maxInfluence - best.radial) * 0.2);
    const lateralScale = Math.abs(best.dx) > Math.abs(best.dz) * 1.5 ? 0.72 : 1.0;
    // Push in XZ only to avoid ballooning/lifting along Y.
    positions[index] += best.dx * inv * push * pinScale * lateralScale;
    positions[index + 2] += best.dz * inv * push * pinScale;

    // Preserve front/back shell thickness so lower-body garments don't collapse flat.
    if (surfaceSides && surfaceSides.length > vertex) {
      const sideValue = Number(surfaceSides[vertex]);
      if (Number.isFinite(sideValue)) {
        const sideSign = sideValue === 0 ? 1 : -1;
        const targetShell = Math.max(0.012, Math.min(0.03, legRadius * 0.55));
        const shellCenterZ = best === left ? leftCenterZ : rightCenterZ;
        const signedDepth = (positions[index + 2] - shellCenterZ) * sideSign;
        if (signedDepth < targetShell) {
          const missing = targetShell - signedDepth;
          positions[index + 2] += sideSign * Math.min(0.004, missing * 0.45) * pinScale;
        }
      }
    }
    contacts += 1;
  }

  // Waistband collision ring: keeps top of pants outside pelvis/waist volume.
  const waistCenterY = minY + bodyHeight * 0.62;
  const waistHalfBand = bodyHeight * 0.08;
  const waistRadiusX = Math.max(bodyWidth * 0.25, legRadius * 1.9);
  const waistRadiusZ = Math.max(bodyDepth * 0.36, legRadius * 1.7);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const pinScale = pinnedFlags[vertex] ? 0.35 : 1.0;
    const index = vertex * 3;
    const vx = positions[index];
    const vy = positions[index + 1];
    const vz = positions[index + 2];
    if (Math.abs(vy - waistCenterY) > waistHalfBand) continue;

    const dx = vx - centerX;
    const dz = vz - centerZ;
    const nx = dx / Math.max(1e-6, waistRadiusX);
    const nz = dz / Math.max(1e-6, waistRadiusZ);
    const d = Math.sqrt(nx * nx + nz * nz);
    if (d >= 1.0) continue;

    const invD = 1 / Math.max(1e-6, d);
    const radialX = nx * invD;
    const radialZ = nz * invD;
    const push = Math.min(0.004, (1.0 - d) * 0.018);
    positions[index] += radialX * push * waistRadiusX * pinScale;
    positions[index + 2] += radialZ * push * waistRadiusZ * pinScale;
    contacts += 1;
  }

  return contacts;
}

function mirrorPanelBehindBody(frontPanelMesh) {
  if (!THREE_LIB || !frontPanelMesh) return null;
  
  const backPanelMesh = frontPanelMesh.clone();
  backPanelMesh.scale.x *= -1;
  backPanelMesh.position.z = -0.1;
  
  return backPanelMesh;
}

function checkCollisionWithBody(rayOrigin, rayDirection, bodyMesh) {
  if (!THREE_LIB || !bodyMesh) return null;
  
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.copy(rayOrigin);
  raycaster.ray.direction.copy(rayDirection).normalize();
  
  const intersections = raycaster.intersectObject(bodyMesh, true);
  
  if (intersections.length > 0) {
    return {
      distance: intersections[0].distance,
      point: intersections[0].point,
      normal: intersections[0].face.normal
    };
  }
  
  return null;
}

function updateSeamConstraints(deltaTime, bodyMesh) {
  if (!seamConstraints.length || !bodyMesh) return;
  
  for (const seam of seamConstraints) {
    if (seam.isFrozen) continue;
    
    const panelA = garmentPanels[seam.panelA];
    const panelB = garmentPanels[seam.panelB];
    if (!panelA?.geometry || !panelB?.geometry) continue;
    
    const positionsA = panelA.geometry.attributes.position.array;
    const positionsB = panelB.geometry.attributes.position.array;
    
    for (let i = 0; i < seam.vertexIndicesA.length; i++) {
      const idxA = seam.vertexIndicesA[i];
      const idxB = seam.vertexIndicesB[i];
      
      const vA = new THREE.Vector3(
        positionsA[idxA * 3],
        positionsA[idxA * 3 + 1],
        positionsA[idxA * 3 + 2]
      ).applyMatrix4(panelA.matrixWorld);
      
      const vB = new THREE.Vector3(
        positionsB[idxB * 3],
        positionsB[idxB * 3 + 1],
        positionsB[idxB * 3 + 2]
      ).applyMatrix4(panelB.matrixWorld);
      
      const seamGap = vA.clone().sub(vB);
      const gapDistance = seamGap.length();
      
      if (gapDistance < 0.001) continue;
      
      const midpoint = vA.clone().add(vB).multiplyScalar(0.5);
      const closingDirection = seamGap.normalize();
      
      const collision = checkCollisionWithBody(midpoint, closingDirection, bodyMesh);
      
      if (collision) {
        seam.collisionDistances[i] = collision.distance;
        seam.isFrozen = true;
        continue;
      }
      
      const originalEdgeLength = seam.originalEdgeLengths?.[i] || gapDistance;
      const currentPull = (originalEdgeLength - gapDistance) / originalEdgeLength;
      
      if (currentPull >= seam.maxContraction) {
        seam.isFrozen = true;
        seam.currentContraction = seam.maxContraction;
        continue;
      }
      
      const pullStrength = 0.1 * deltaTime;
      const pullVec = seamGap.clone().multiplyScalar(pullStrength * 0.5);
      vA.sub(pullVec);
      vB.add(pullVec);
    }
  }
  
  if (garmentPanels.front?.geometry) {
    garmentPanels.front.geometry.attributes.position.needsUpdate = true;
  }
  if (garmentPanels.back?.geometry) {
    garmentPanels.back.geometry.attributes.position.needsUpdate = true;
  }
}

function recalculateSeamFeasibility() {
  // Called when garment is dragged—check if frozen seams can resume
  for (const seam of seamConstraints) {
    if (!seam.isFrozen) continue;
    
    let canResume = false;
    const panelA = garmentPanels[seam.panelA];
    const panelB = garmentPanels[seam.panelB];
    
    if (panelA?.geometry && panelB?.geometry) {
      const positionsA = panelA.geometry.attributes.position.array;
      const positionsB = panelB.geometry.attributes.position.array;
      
      for (let i = 0; i < seam.vertexIndicesA.length; i++) {
        const idxA = seam.vertexIndicesA[i];
        const idxB = seam.vertexIndicesB[i];
        
        const vA = new THREE.Vector3(
          positionsA[idxA * 3],
          positionsA[idxA * 3 + 1],
          positionsA[idxA * 3 + 2]
        ).applyMatrix4(panelA.matrixWorld);
        
        const vB = new THREE.Vector3(
          positionsB[idxB * 3],
          positionsB[idxB * 3 + 1],
          positionsB[idxB * 3 + 2]
        ).applyMatrix4(panelB.matrixWorld);
        
        const collision = checkCollisionWithBody(
          vA.clone().add(vB).multiplyScalar(0.5),
          vA.clone().sub(vB).normalize(),
          currentModel
        );
        
        if (!collision) {
          canResume = true;
          break;
        }
      }
    }
    
    if (canResume) {
      seam.isFrozen = false;
    }
  }
}

function stepGarmentSimulation(deltaSeconds) {
  if (!THREE_LIB || !garmentSimulationState || !generatedGarmentMesh || !currentModel) {
    garmentSimulationState = null;
    return;
  }

  const state = garmentSimulationState;
  const {
    simulationMesh,
    seamMaterial,
    geometry,
    positionAttr,
    positions,
    basePositions,
    velocities,
    vertexCount,
    pinnedFlags,
    structuralPairs,
    structuralRestLengths,
    bendPairs,
    bendRestLengths,
    stitchPairs,
    restLengths,
    selfCollisionPairs,
    stitchPairKeySet,
    collisionSideFlags,
    surfaceSides,
    seamVertexFlags,
    garmentType,
    stitchPairPhase,
    stitchAccumDeltaX,
    stitchAccumDeltaY,
    stitchAccumDeltaZ,
    stitchAccumWeight,
    stitchTouchedVertices,
    maxPinnedY,
  } = state;

  // Debug: Log average seam distance
  if (stitchPairs.length > 1) {
    let seamDistSum = 0, seamDistCount = 0;
    for (let pair = 0; pair < stitchPairs.length - 1; pair += 2) {
      const first = Number(stitchPairs[pair]);
      const second = Number(stitchPairs[pair + 1]);
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;
      const fi = first * 3, si = second * 3;
      const dx = positions[fi] - positions[si];
      const dy = positions[fi + 1] - positions[si + 1];
      const dz = positions[fi + 2] - positions[si + 2];
      seamDistSum += Math.sqrt(dx * dx + dy * dy + dz * dz);
      seamDistCount++;
    }
    if (seamDistCount > 0 && state.frame % 30 === 0) {
      console.log('[DEBUG] Avg seam distance:', (seamDistSum / seamDistCount).toFixed(5));
    }
  }

  const currentGarmentWorldMatrix = simulationMesh?.matrixWorld?.elements;
  if (state.lastGarmentWorldMatrix && currentGarmentWorldMatrix && currentGarmentWorldMatrix.length === 16) {
    let hasTransformDrift = false;
    for (let i = 0; i < 16; i += 1) {
      if (Math.abs(Number(currentGarmentWorldMatrix[i]) - Number(state.lastGarmentWorldMatrix[i])) > 1e-4) {
        hasTransformDrift = true;
        break;
      }
    }
    if (hasTransformDrift) {
      for (let i = 0; i < 16; i += 1) {
        state.lastGarmentWorldMatrix[i] = Number(currentGarmentWorldMatrix[i]);
      }
      state.bodyCloud = null;
    }
  }

  // Build body-mesh collision cloud and retry until successful.
  // If this build fails once (timing/load order), collisions would otherwise appear "off" forever.
  if (!state.bodyCloud || !state.bodyCloud.triangleCount) {
    currentModel.updateMatrixWorld(true);
    simulationMesh.updateMatrixWorld(true);
    state.bodyCloud = buildBodyCollisionCloud(currentModel, simulationMesh, generatedGarmentMesh);

    if (!state.bodyCloud || !state.bodyCloud.triangleCount) {
      if (!state.lastBodyCloudBuildFailureFrame || state.frame - state.lastBodyCloudBuildFailureFrame > 30) {
        state.lastBodyCloudBuildFailureFrame = state.frame;
        updateDebugPanel('[COLLISION CLOUD FAIL] Body collision mesh build failed; retrying next frame.', {
          frame: state.frame,
          currentModel: !!currentModel,
          simulationMesh: !!simulationMesh,
          generatedGarmentMesh: !!generatedGarmentMesh,
        });
      }
    } else {
      updateDebugPanel('[COLLISION CLOUD OK] Body collision mesh built.', {
        triangles: state.bodyCloud.triangleCount,
        cellSize: Number(state.bodyCloud.cs.toFixed(4)),
        grid: `${state.bodyCloud.gW}x${state.bodyCloud.gH}x${state.bodyCloud.gD}`,
        droppedCellRefs: state.bodyCloud.droppedCellRefs,
        frame: state.frame,
      });
    }
  }

  // If avatar is skinned/posed, periodically refresh cloud so collision matches current body pose.
  if (state.bodyCloud?.hasSkinnedMesh && (state.frame % 48 === 0)) {
    currentModel.updateMatrixWorld(true);
    simulationMesh.updateMatrixWorld(true);
    const refreshedCloud = buildBodyCollisionCloud(currentModel, simulationMesh, generatedGarmentMesh);
    if (refreshedCloud) {
      state.bodyCloud = refreshedCloud;
    }
  }
  const bodyCloud = state.bodyCloud;

  if (!simulationModelBoundsBox) simulationModelBoundsBox = new THREE_LIB.Box3();
  if (bodyCloud && Number.isFinite(bodyCloud.mnX) && Number.isFinite(bodyCloud.mxX)) {
    simulationModelBoundsBox.min.set(bodyCloud.mnX, bodyCloud.mnY, bodyCloud.mnZ);
    simulationModelBoundsBox.max.set(bodyCloud.mxX, bodyCloud.mxY, bodyCloud.mxZ);
  } else {
    computeBoundsExcludingRoot(currentModel, generatedGarmentMesh, simulationModelBoundsBox, simulationMesh);
  }

  if (simulationModelBoundsBox.isEmpty()) {
    garmentSimulationState = null;
    return;
  }

  const isInteractiveSolve = Boolean(isDraggingPreviewGarment);
  const largeMesh = vertexCount >= 18000;
  const veryLargeMesh = vertexCount >= 28000;
  const isLowerBodyGarment = isLowerBodyCollisionGarment(garmentType);
  const isTopGarment = !isLowerBodyGarment;

  const substeps = isInteractiveSolve ? 1 : (isLowerBodyGarment ? 1 : (veryLargeMesh ? 1 : 2));
  const deltaScale = (deltaSeconds * 60) / substeps;
  const gravity = -0.00085 * deltaScale;
  const damping = Math.pow(0.965, deltaScale);
  // Small memory term to damp drift without flattening wrapped cloth.
  const memory = Math.min(0.012, 0.003 * deltaScale);

  const stretchIterations = isInteractiveSolve ? 2 : (largeMesh ? 3 : 4);
  const bendIterations = isInteractiveSolve ? 1 : 2;
  const stitchIterations = isInteractiveSolve
    ? 12
    : (isLowerBodyGarment ? (veryLargeMesh ? 12 : (largeMesh ? 16 : 22)) : (veryLargeMesh ? 22 : (largeMesh ? 32 : 44)));
  const selfCollisionIterations = isInteractiveSolve ? 1 : (isLowerBodyGarment ? 1 : (largeMesh ? 2 : 3));
  const coupledTerminalIterations = isInteractiveSolve
    ? 7
    : (isLowerBodyGarment ? (veryLargeMesh ? 6 : (largeMesh ? 8 : 12)) : (veryLargeMesh ? 16 : (largeMesh ? 22 : 28)));

  const applyActiveBodyCollision = (isFinalPass = false) => {
    if (!ENABLE_BODY_COLLISION_IN_FIT_PREVIEW) return;
    const hasMeshCloud = Boolean(bodyCloud && bodyCloud.triangleCount);
    let meshHitCount = 0;
    const meshPasses = hasMeshCloud ? (isFinalPass && isTopGarment ? 3 : 1) : 0;
    if (hasMeshCloud) {
      for (let pass = 0; pass < meshPasses; pass += 1) {
        const hits = applyBodyMeshCollision(positions, velocities, pinnedFlags, vertexCount, bodyCloud) || 0;
        meshHitCount += hits;
        if (hits <= 0) break;
      }
    } else {
      applyBodyBoundsFallbackCollision(positions, velocities, pinnedFlags, vertexCount, simulationModelBoundsBox);
    }

    // Keep ghost guard as a last-resort only when mesh cloud is unavailable.
    if (isFinalPass && !hasMeshCloud) {
      applyBodyGhostGuardCollision(positions, velocities, pinnedFlags, vertexCount, simulationModelBoundsBox);
    }

    if (!hasMeshCloud) {
      if (state.frame % 30 === 0) {
        updateDebugPanel('[COLLISION CLOUD MISSING] meshCloud missing or empty during collision pass!', {
          meshCloudCollision: false,
          fallbackCollision: true,
          frame: state.frame,
        });
      }
    } else if (state.frame % 120 === 0) {
      updateDebugPanel('[COLLISION CLOUD USED] Collision pass active.', {
        meshCloudCollision: true,
        fallbackCollision: false,
        meshCollisionHits: meshHitCount,
        frame: state.frame,
      });
    }
  };

  const solveDistancePairs = (pairs, pairRestLengths, stiffness, pairOffset = 0) => {
    const pairCount = Math.floor(pairs.length / 2);
    if (pairCount <= 0) return;
    const normalizedOffset = ((pairOffset % pairCount) + pairCount) % pairCount;

    for (let pairOrder = 0; pairOrder < pairCount; pairOrder += 1) {
      const pair = ((pairOrder + normalizedOffset) % pairCount) * 2;
      const first = Number(pairs[pair]);
      const second = Number(pairs[pair + 1]);
      const restLength = pairRestLengths[pair / 2] ?? 0;
      if (restLength < 0) continue;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;

      const firstIndex = first * 3;
      const secondIndex = second * 3;

      const dx = positions[firstIndex] - positions[secondIndex];
      const dy = positions[firstIndex + 1] - positions[secondIndex + 1];
      const dz = positions[firstIndex + 2] - positions[secondIndex + 2];
      const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength < 1e-6) continue;

      // Seam-adjacent edges stretch more so seam vertices can travel around the body without snapping back.
      const isSeamEdge = seamVertexFlags[first] || seamVertexFlags[second];
      const minLength = restLength * (isTopGarment ? 0.75 : 0.90);
      const maxLength = restLength * (isTopGarment ? (isSeamEdge ? 4.0 : 1.35) : (isSeamEdge ? 2.5 : 1.12));
      const targetLength = Math.max(minLength, Math.min(maxLength, currentLength));
      const correction = ((currentLength - targetLength) / currentLength) * stiffness;
      const correctionX = dx * correction;
      const correctionY = dy * correction;
      const correctionZ = dz * correction;

      const firstMovable = pinnedFlags[first] ? 0 : 1;
      const secondMovable = pinnedFlags[second] ? 0 : 1;
      const movableSum = firstMovable + secondMovable;
      if (movableSum <= 0) continue;

      const firstShare = firstMovable / movableSum;
      const secondShare = secondMovable / movableSum;

      if (firstMovable) {
        positions[firstIndex] -= correctionX * firstShare;
        positions[firstIndex + 1] -= correctionY * firstShare;
        positions[firstIndex + 2] -= correctionZ * firstShare;
      }
      if (secondMovable) {
        positions[secondIndex] += correctionX * secondShare;
        positions[secondIndex + 1] += correctionY * secondShare;
        positions[secondIndex + 2] += correctionZ * secondShare;
      }
    }
  };

  const solveStitchPairsGlobal = (stiffness = 1.0, pairOffset = 0) => {
    const pairCount = Math.floor(stitchPairs.length / 2);
    if (pairCount <= 0) return;
    const normalizedOffset = ((pairOffset % pairCount) + pairCount) % pairCount;
    let touchedCount = 0;

    for (let pairOrder = 0; pairOrder < pairCount; pairOrder += 1) {
      const pair = ((pairOrder + normalizedOffset) % pairCount) * 2;
      const first = Number(stitchPairs[pair]);
      const second = Number(stitchPairs[pair + 1]);
      const restLength = restLengths[pair / 2] ?? 0;
      if (restLength < 0) continue;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;

      const firstIndex = first * 3;
      const secondIndex = second * 3;

      const dx = positions[firstIndex] - positions[secondIndex];
      const dy = positions[firstIndex + 1] - positions[secondIndex + 1];
      const dz = positions[firstIndex + 2] - positions[secondIndex + 2];
      const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength < 1e-6) continue;

      const correction = ((currentLength - restLength) / currentLength) * stiffness;
      const correctionX = dx * correction;
      const correctionY = dy * correction;
      const seamZWeight = isLowerBodyGarment ? 0.38 : 1.0;
      const correctionZ = dz * correction * seamZWeight;

      const firstMovable = pinnedFlags[first] ? 0 : 1;
      const secondMovable = pinnedFlags[second] ? 0 : 1;
      const movableSum = firstMovable + secondMovable;
      if (movableSum <= 0) continue;

      const firstShare = firstMovable / movableSum;
      const secondShare = secondMovable / movableSum;

      if (firstMovable) {
        if (stitchAccumWeight[first] === 0) {
          stitchTouchedVertices[touchedCount] = first;
          touchedCount += 1;
        }
        stitchAccumDeltaX[first] -= correctionX * firstShare;
        stitchAccumDeltaY[first] -= correctionY * firstShare;
        stitchAccumDeltaZ[first] -= correctionZ * firstShare;
        stitchAccumWeight[first] += firstShare;
      }

      if (secondMovable) {
        if (stitchAccumWeight[second] === 0) {
          stitchTouchedVertices[touchedCount] = second;
          touchedCount += 1;
        }
        stitchAccumDeltaX[second] += correctionX * secondShare;
        stitchAccumDeltaY[second] += correctionY * secondShare;
        stitchAccumDeltaZ[second] += correctionZ * secondShare;
        stitchAccumWeight[second] += secondShare;
      }
    }

    for (let touched = 0; touched < touchedCount; touched += 1) {
      const vertex = stitchTouchedVertices[touched];
      const weight = stitchAccumWeight[vertex];
      if (weight <= 0) continue;

      const index = vertex * 3;
      const invWeight = 1 / weight;
      positions[index] += stitchAccumDeltaX[vertex] * invWeight;
      positions[index + 1] += stitchAccumDeltaY[vertex] * invWeight;
      positions[index + 2] += stitchAccumDeltaZ[vertex] * invWeight;

      stitchAccumDeltaX[vertex] = 0;
      stitchAccumDeltaY[vertex] = 0;
      stitchAccumDeltaZ[vertex] = 0;
      stitchAccumWeight[vertex] = 0;
      stitchTouchedVertices[touched] = 0;
    }
  };

  // Cheap bbox check — tells stitch solver to reduce Z-pull when near the body
  const getPointCollisionPenetration = (vertex, x, y, z) => {
    if (!bodyCloud) return 0;
    if (x < bodyCloud.mnX - 0.04 || x > bodyCloud.mxX + 0.04) return 0;
    if (y < bodyCloud.mnY - 0.04 || y > bodyCloud.mxY + 0.04) return 0;
    if (z < bodyCloud.mnZ - 0.04 || z > bodyCloud.mxZ + 0.04) return 0;
    return 0.001;
  };

  const solveStitchPairsAroundCollisionBody = (stiffness = 1.0, zWeightNearCollision = 0.22, zWeightFree = 1.0, pairOffset = 0) => {
    const pairCount = Math.floor(stitchPairs.length / 2);
    if (pairCount <= 0) return;
    const normalizedOffset = ((pairOffset % pairCount) + pairCount) % pairCount;

    for (let pairOrder = 0; pairOrder < pairCount; pairOrder += 1) {
      const pair = ((pairOrder + normalizedOffset) % pairCount) * 2;
      const first = Number(stitchPairs[pair]);
      const second = Number(stitchPairs[pair + 1]);
      const restLength = restLengths[pair / 2] ?? 0;
      if (restLength < 0) continue;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;

      const firstIndex = first * 3;
      const secondIndex = second * 3;

      const dx = positions[firstIndex] - positions[secondIndex];
      const dy = positions[firstIndex + 1] - positions[secondIndex + 1];
      const dz = positions[firstIndex + 2] - positions[secondIndex + 2];

      const firstPenetration = getPointCollisionPenetration(
        first,
        positions[firstIndex],
        positions[firstIndex + 1],
        positions[firstIndex + 2]
      );
      const secondPenetration = getPointCollisionPenetration(
        second,
        positions[secondIndex],
        positions[secondIndex + 1],
        positions[secondIndex + 2]
      );
      const blockedByCollision = firstPenetration > 0.0005 || secondPenetration > 0.0005;
      const zWeight = blockedByCollision ? zWeightNearCollision : zWeightFree;
      const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength < 1e-6) continue;
      if (currentLength <= restLength) continue;

      const correction = ((currentLength - restLength) / currentLength) * stiffness;
      const correctionX = dx * correction;
      const correctionY = dy * correction;
      const seamZWeight = isLowerBodyGarment ? 0.45 : 1.0;
      const correctionZ = dz * correction * seamZWeight * zWeight;

      const firstMovable = pinnedFlags[first] ? 0 : 1;
      const secondMovable = pinnedFlags[second] ? 0 : 1;
      const movableSum = firstMovable + secondMovable;
      if (movableSum <= 0) continue;

      const firstShare = firstMovable / movableSum;
      const secondShare = secondMovable / movableSum;

      if (firstMovable) {
        positions[firstIndex] -= correctionX * firstShare;
        positions[firstIndex + 1] -= correctionY * firstShare;
        positions[firstIndex + 2] -= correctionZ * firstShare;
      }
      if (secondMovable) {
        positions[secondIndex] += correctionX * secondShare;
        positions[secondIndex + 1] += correctionY * secondShare;
        positions[secondIndex + 2] += correctionZ * secondShare;
      }
    }
  };

  const holdClosedSeams = () => {
    const pairCount = Math.floor(stitchPairs.length / 2);
    if (pairCount <= 0) return;
    const holdDistance = isLowerBodyGarment ? 0.014 : 0.018;
    const holdBlend = isLowerBodyGarment ? 0.55 : 0.68;

    for (let pair = 0; pair < stitchPairs.length - 1; pair += 2) {
      const first = Number(stitchPairs[pair]);
      const second = Number(stitchPairs[pair + 1]);
      if (!Number.isInteger(first) || !Number.isInteger(second)) continue;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;

      const firstIndex = first * 3;
      const secondIndex = second * 3;
      const dx = positions[firstIndex] - positions[secondIndex];
      const dy = positions[firstIndex + 1] - positions[secondIndex + 1];
      const dz = positions[firstIndex + 2] - positions[secondIndex + 2];
      const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength > holdDistance) continue;

      const midX = (positions[firstIndex] + positions[secondIndex]) * 0.5;
      const midY = (positions[firstIndex + 1] + positions[secondIndex + 1]) * 0.5;
      const midZ = (positions[firstIndex + 2] + positions[secondIndex + 2]) * 0.5;

      if (!pinnedFlags[first]) {
        positions[firstIndex] += (midX - positions[firstIndex]) * holdBlend;
        positions[firstIndex + 1] += (midY - positions[firstIndex + 1]) * holdBlend;
        positions[firstIndex + 2] += (midZ - positions[firstIndex + 2]) * holdBlend;
      }
      if (!pinnedFlags[second]) {
        positions[secondIndex] += (midX - positions[secondIndex]) * holdBlend;
        positions[secondIndex + 1] += (midY - positions[secondIndex + 1]) * holdBlend;
        positions[secondIndex + 2] += (midZ - positions[secondIndex + 2]) * holdBlend;
      }

      // Dampen relative seam velocity so closed seams stay closed.
      const invLength = 1 / Math.max(1e-6, currentLength);
      const dirX = dx * invLength;
      const dirY = dy * invLength;
      const dirZ = dz * invLength;
      const relVx = velocities[firstIndex] - velocities[secondIndex];
      const relVy = velocities[firstIndex + 1] - velocities[secondIndex + 1];
      const relVz = velocities[firstIndex + 2] - velocities[secondIndex + 2];
      const seamRelVel = relVx * dirX + relVy * dirY + relVz * dirZ;
      if (seamRelVel > 0) {
        const damp = Math.min(0.75, seamRelVel * 0.5);
        if (!pinnedFlags[first]) {
          velocities[firstIndex] -= dirX * damp;
          velocities[firstIndex + 1] -= dirY * damp;
          velocities[firstIndex + 2] -= dirZ * damp;
        }
        if (!pinnedFlags[second]) {
          velocities[secondIndex] += dirX * damp;
          velocities[secondIndex + 1] += dirY * damp;
          velocities[secondIndex + 2] += dirZ * damp;
        }
      }
    }
  };

  const stitchPairCount = Math.floor(stitchPairs.length / 2);
  let maxSeamStretchRatio = 0;
  let currentStitchPairPhase = stitchPairCount > 0
    ? (((Number(stitchPairPhase) || 0) % stitchPairCount) + stitchPairCount) % stitchPairCount
    : 0;

  for (let substep = 0; substep < substeps; substep += 1) {
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (pinnedFlags[vertex]) continue;

      const index = vertex * 3;

      velocities[index + 1] += gravity;
      velocities[index] *= damping;
      velocities[index + 1] *= damping;
      velocities[index + 2] *= damping;

      const maxVelocity = 0.05;
      velocities[index] = Math.max(-maxVelocity, Math.min(maxVelocity, velocities[index]));
      velocities[index + 1] = Math.max(-maxVelocity, Math.min(maxVelocity, velocities[index + 1]));
      velocities[index + 2] = Math.max(-maxVelocity, Math.min(maxVelocity, velocities[index + 2]));

      positions[index] += velocities[index];
      positions[index + 1] += velocities[index + 1];
      positions[index + 2] += velocities[index + 2];

      // Remove memory term for seam vertices entirely: let stitch forces pull seam vertices as far as possible.
      if (!seamVertexFlags[vertex]) {
        positions[index] += (basePositions[index] - positions[index]) * memory;
        positions[index + 1] += (basePositions[index + 1] - positions[index + 1]) * memory;
        positions[index + 2] += (basePositions[index + 2] - positions[index + 2]) * (memory * 0.45);
      }

      const dxFromBase = positions[index] - basePositions[index];
      const dyFromBase = positions[index + 1] - basePositions[index + 1];
      const dzFromBase = positions[index + 2] - basePositions[index + 2];
      const displacement = Math.sqrt(dxFromBase * dxFromBase + dyFromBase * dyFromBase + dzFromBase * dzFromBase);
      // Seam vertices need much more range to travel around the body; non-seam vertices stay tightly anchored.
      const maxDisplacement = seamVertexFlags[vertex] ? 0.55 : 0.20;
      if (displacement > maxDisplacement) {
        const pullback = maxDisplacement / Math.max(1e-5, displacement);
        positions[index] = basePositions[index] + dxFromBase * pullback;
        positions[index + 1] = basePositions[index + 1] + dyFromBase * pullback;
        positions[index + 2] = basePositions[index + 2] + dzFromBase * pullback;
        velocities[index] *= 0.5;
        velocities[index + 1] *= 0.5;
        velocities[index + 2] *= 0.5;
      }
    }

    // Spring seam forces pull stitched panel edges together while preserving natural motion.
    const seamSpringStiffness = 6.0 * deltaScale;
    const seamSpringDamping = 1.2;
    for (let pairOrder = 0; pairOrder < stitchPairCount; pairOrder += 1) {
      const pair = ((pairOrder + currentStitchPairPhase) % stitchPairCount) * 2;
      const first = Number(stitchPairs[pair]);
      const second = Number(stitchPairs[pair + 1]);
      const restLength = restLengths[pair / 2] || 0;
      if (restLength < 0) continue;
      if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;

      const firstIndex = first * 3;
      const secondIndex = second * 3;
      const dx = positions[firstIndex] - positions[secondIndex];
      const dy = positions[firstIndex + 1] - positions[secondIndex + 1];
      const dz = positions[firstIndex + 2] - positions[secondIndex + 2];
      const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (currentLength < 1e-5) continue;

      const invLength = 1 / currentLength;
      const dirX = dx * invLength;
      const dirY = dy * invLength;
      const dirZ = dz * invLength;

      const relVx = velocities[firstIndex] - velocities[secondIndex];
      const relVy = velocities[firstIndex + 1] - velocities[secondIndex + 1];
      const relVz = velocities[firstIndex + 2] - velocities[secondIndex + 2];
      const seamRelativeVelocity = relVx * dirX + relVy * dirY + relVz * dirZ;

      const stretch = currentLength - restLength;
      if (restLength > 1e-5 && stretch > 0) {
        const stretchRatio = stretch / restLength;
        if (stretchRatio > maxSeamStretchRatio) maxSeamStretchRatio = stretchRatio;
      }
      const seamImpulse = stretch * seamSpringStiffness + seamRelativeVelocity * seamSpringDamping;
      const impulseX = dirX * seamImpulse;
      const impulseY = dirY * seamImpulse;
      const impulseZ = dirZ * seamImpulse;

      const firstMovable = pinnedFlags[first] ? 0 : 1;
      const secondMovable = pinnedFlags[second] ? 0 : 1;
      const movableSum = firstMovable + secondMovable;
      if (movableSum <= 0) continue;

      const firstShare = firstMovable / movableSum;
      const secondShare = secondMovable / movableSum;

      if (firstMovable) {
        velocities[firstIndex] -= impulseX * firstShare;
        velocities[firstIndex + 1] -= impulseY * firstShare;
        velocities[firstIndex + 2] -= impulseZ * firstShare;
      }
      if (secondMovable) {
        velocities[secondIndex] += impulseX * secondShare;
        velocities[secondIndex + 1] += impulseY * secondShare;
        velocities[secondIndex + 2] += impulseZ * secondShare;
      }
    }

    // One collision pass before constraint solving — prevents cloth starting inside body
    applyActiveBodyCollision(false);
    if (isLowerBodyGarment) {
      applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
    }

    for (let iteration = 0; iteration < stretchIterations; iteration += 1) {
      solveDistancePairs(structuralPairs, structuralRestLengths, 0.72);
    }
    for (let iteration = 0; iteration < bendIterations; iteration += 1) {
      solveDistancePairs(bendPairs, bendRestLengths, 0.32);
    }
    for (let iteration = 0; iteration < stitchIterations * 2; iteration += 1) {
      solveStitchPairsGlobal(1.0, currentStitchPairPhase + iteration);
      // For top garments, interleave body collision every 8 stitch iterations so the stitch
      // can dominate and pull seams together unless truly blocked by the body.
      if (isTopGarment && bodyCloud && iteration % 8 === 7) {
        applyBodyMeshCollision(positions, velocities, pinnedFlags, vertexCount, bodyCloud);
      }
    }

    // Multi-pass collision flush after stitch block: for tops use 3 passes (same as final),
    // for lower-body use 1.  This catches any residual penetration before self-collision runs.
    applyActiveBodyCollision(isTopGarment);
    if (isLowerBodyGarment) {
      applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
    }

    const minSeparation = 0.012;
    for (let iteration = 0; iteration < selfCollisionIterations; iteration += 1) {
      for (let pair = 0; pair < selfCollisionPairs.length - 1; pair += 2) {
        const first = Number(selfCollisionPairs[pair]);
        const second = Number(selfCollisionPairs[pair + 1]);
        if (!Number.isInteger(first) || !Number.isInteger(second)) continue;
        if (first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;
        const stitchKey = `${Math.min(first, second)}:${Math.max(first, second)}`;
        if (stitchPairKeySet && stitchPairKeySet.has(stitchKey)) continue;

        const firstIndex = first * 3;
        const secondIndex = second * 3;

        let dx = positions[firstIndex] - positions[secondIndex];
        let dy = positions[firstIndex + 1] - positions[secondIndex + 1];
        let dz = positions[firstIndex + 2] - positions[secondIndex + 2];
        let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (distance < 1e-5) {
          const sideFirst = collisionSideFlags && Number.isFinite(Number(collisionSideFlags[first])) ? Number(collisionSideFlags[first]) : 0;
          const sideSecond = collisionSideFlags && Number.isFinite(Number(collisionSideFlags[second])) ? Number(collisionSideFlags[second]) : 1;
          dz = sideFirst === sideSecond ? 0.001 : (sideFirst < sideSecond ? 1 : -1) * 0.001;
          dx = 0;
          dy = 0;
          distance = Math.abs(dz);
        }

        if (distance >= minSeparation) continue;

        const correction = (minSeparation - distance) / distance;
        const pushX = dx * correction * 0.28;
        const pushY = dy * correction * 0.28;
        const pushZ = dz * correction * (isLowerBodyGarment ? 0.32 : 0.45);

        if (!pinnedFlags[first]) {
          positions[firstIndex] += pushX;
          positions[firstIndex + 1] += pushY;
          positions[firstIndex + 2] += pushZ;
        }
        if (!pinnedFlags[second]) {
          positions[secondIndex] -= pushX;
          positions[secondIndex + 1] -= pushY;
          positions[secondIndex + 2] -= pushZ;
        }
      }

    }

    // Self-collision can push vertices into the body; resolve immediately before seam coupling.
    applyActiveBodyCollision(false);
    if (isLowerBodyGarment) {
      applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
    }

    // Couple seam pull and collision in the same terminal loop so both effects happen simultaneously.
    // Near the body the Z-weight is nearly zeroed (0.08) so stitch force acts almost purely in X/Y —
    // this forces the seam to travel AROUND the body sides rather than tunnel straight through it.
    for (let iteration = 0; iteration < coupledTerminalIterations * 2; iteration += 1) {
      // Use a higher Z-weight near collision so seam can still pull panels together even if close to the body.
      solveStitchPairsAroundCollisionBody(2.0, 0.35, 1.0, currentStitchPairPhase + iteration);
      applyActiveBodyCollision(false);
      if (isLowerBodyGarment) {
        applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
      }
    }

    // Hard seam midpoint projection: run multiple iterations to pull seam pairs as close as
    // possible, interleaved with collision so they stop AT the body surface and stay there.
    for (let iteration = 0; iteration < 6; iteration += 1) {
      for (let pair = 0; pair < stitchPairs.length - 1; pair += 2) {
        const first = Number(stitchPairs[pair]);
        const second = Number(stitchPairs[pair + 1]);
        if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || second < 0 || first >= vertexCount || second >= vertexCount) continue;
        if (pinnedFlags[first] && pinnedFlags[second]) continue;
        const fi = first * 3, si = second * 3;
        const midX = (positions[fi]     + positions[si])     * 0.5;
        const midY = (positions[fi + 1] + positions[si + 1]) * 0.5;
        const midZ = (positions[fi + 2] + positions[si + 2]) * 0.5;
        // Strong blend: pull hard toward midpoint each iteration.
        const blend = 0.82;
        if (!pinnedFlags[first]) {
          positions[fi]     += (midX - positions[fi])     * blend;
          positions[fi + 1] += (midY - positions[fi + 1]) * blend;
          positions[fi + 2] += (midZ - positions[fi + 2]) * blend;
        }
        if (!pinnedFlags[second]) {
          positions[si]     += (midX - positions[si])     * blend;
          positions[si + 1] += (midY - positions[si + 1]) * blend;
          positions[si + 2] += (midZ - positions[si + 2]) * blend;
        }
      }
      // Interleave collision every 2 iterations so seam stops at body surface.
      if (iteration % 2 === 1) {
        applyActiveBodyCollision(false);
        if (isLowerBodyGarment) {
          applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
        }
      }
    }

    holdClosedSeams();

    // Final collision pass after all constraints + seam solving.
    applyActiveBodyCollision(true);
    if (isLowerBodyGarment) {
      applyLowerBodyLegCapsuleCollision(positions, pinnedFlags, vertexCount, bodyCloud, garmentType, surfaceSides);
    }

    // For top garments: hard clamp so no free vertex can rise above the shoulder/collar line.
    // This stops the fabric from drifting up over the head ("consuming the head").
    if (isTopGarment && Number.isFinite(maxPinnedY)) {
      const headCap = maxPinnedY + 0.008;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        if (pinnedFlags[vertex]) continue;
        const vi = vertex * 3 + 1;
        if (positions[vi] > headCap) {
          positions[vi] = headCap;
          if (velocities[vi] > 0) velocities[vi] = 0;
        }
      }
    }

    if (stitchPairCount > 0) {
      currentStitchPairPhase = (currentStitchPairPhase + 1) % stitchPairCount;
    }
  }

  if (garmentPanels.front && garmentPanels.back && seamConstraints.length > 0) {
    updateSeamConstraints(deltaSeconds, currentModel);
  }

  positionAttr.needsUpdate = true;

  state.stitchPairPhase = currentStitchPairPhase;
  if (seamMaterial?.isMaterial) {
    const threshold = 0.2;
    const full = 0.55;
    const normalized = Math.max(0, Math.min(1, (maxSeamStretchRatio - threshold) / Math.max(1e-5, full - threshold)));
    const smooth = state.seamStretchVisual * 0.72 + normalized * 0.28;
    state.seamStretchVisual = smooth;
    if (seamMaterial.emissive && typeof seamMaterial.emissive.setRGB === 'function') {
      seamMaterial.emissive.setRGB(0.95 * smooth, 0.12 * smooth, 0.06 * smooth);
      seamMaterial.emissiveIntensity = 0.25 + smooth * 0.95;
    }
    if (seamMaterial.color && typeof seamMaterial.color.setRGB === 'function') {
      seamMaterial.color.setRGB(0.56 + smooth * 0.36, 0.56 - smooth * 0.2, 0.6 - smooth * 0.36);
    }
  }
  state.frame += 1;
  const normalRecomputeInterval = isInteractiveSolve ? 6 : (largeMesh ? 4 : 3);
  if (state.frame % normalRecomputeInterval === 0) {
    geometry.computeVertexNormals();
  }
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
      generatedGarmentMesh.userData.garmentPayload = modelPayload;
      generatedGarmentMesh.name = 'GeneratedGarmentGLB';
      generatedGarmentMesh.position.set(0, 0, 0);
      const glbGarmentType = String(modelPayload.garmentType || getSelectedGarmentType() || '').toLowerCase();
      const ignoreAlphaForTop = glbGarmentType === 'shirt'
        || glbGarmentType === 'tshirt'
        || glbGarmentType === 'blouse'
        || glbGarmentType === 'jacket'
        || glbGarmentType === 'hoodie'
        || glbGarmentType === 'sweater'
        || glbGarmentType === 'coat'
        || glbGarmentType === 'suit';
      generatedGarmentMesh.traverse((child) => {
        if (!child?.isMesh) return;
        if (!child.material) {
          child.material = createGarmentMaterial(modelPayload.textureDataUrl || null);
        }
        if (Array.isArray(child.material)) {
          child.material.forEach((material) => {
            if (!material) return;
            material.side = THREE_LIB.DoubleSide;
            if (ignoreAlphaForTop && material.map) {
              material.alphaMap = null;
              material.transparent = false;
              material.alphaTest = 0;
            } else if (material.map) {
              material.transparent = true;
              material.alphaTest = 0.01;
            } else {
              material.transparent = false;
              material.alphaTest = 0;
            }
            material.opacity = 1;
            material.depthWrite = true;
          });
          return;
        }
        child.material.side = THREE_LIB.DoubleSide;
        if (ignoreAlphaForTop && child.material.map) {
          child.material.alphaMap = null;
          child.material.transparent = false;
          child.material.alphaTest = 0;
        } else if (child.material.map) {
          child.material.transparent = true;
          child.material.alphaTest = 0.01;
        } else {
          child.material.transparent = false;
          child.material.alphaTest = 0;
        }
        child.material.opacity = 1;
        child.material.depthWrite = true;
      });

      const bounds = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
      const size = bounds.getSize(new THREE_LIB.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
      generatedGarmentBaseScale = 1.5 / maxDimension;
      generatedGarmentMesh.scale.setScalar(generatedGarmentBaseScale);

      scene.add(generatedGarmentMesh);
      if (currentModel) alignGarmentToCurrentModel();
      startGarmentSimulation(modelPayload);
      if (!currentModel) fitModelToView(generatedGarmentMesh);
      if (clothingOverlay) {
        clothingOverlay.hidden = true;
      }
      currentGarmentCutout = null;
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
      if (clothingOverlay) {
        clothingOverlay.hidden = false;
      }
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
  geometry.clearGroups();
  geometry.computeVertexNormals();

  const garmentColor = modelPayload.garmentColor;
  const seamColor = garmentColor
    ? ((Number(garmentColor.r) & 0xff) << 16) | ((Number(garmentColor.g) & 0xff) << 8) | (Number(garmentColor.b) & 0xff)
    : 0x8a8f99;
  const garmentType = String(modelPayload.garmentType || getSelectedGarmentType() || '').toLowerCase();
  const ignoreAlphaForTop = garmentType === 'shirt'
    || garmentType === 'tshirt'
    || garmentType === 'blouse'
    || garmentType === 'jacket'
    || garmentType === 'hoodie'
    || garmentType === 'sweater'
    || garmentType === 'coat'
    || garmentType === 'suit';
  const mainMaterial = createGarmentMaterial(modelPayload.textureDataUrl || null);
  if (mainMaterial?.isMeshStandardMaterial) {
    if (ignoreAlphaForTop && mainMaterial.map) {
      mainMaterial.alphaMap = null;
      mainMaterial.transparent = false;
      mainMaterial.alphaTest = 0;
    } else if (mainMaterial.map) {
      mainMaterial.transparent = true;
      mainMaterial.alphaTest = 0.01;
    } else {
      mainMaterial.transparent = false;
      mainMaterial.alphaTest = 0;
    }
    mainMaterial.opacity = 1;
    mainMaterial.depthWrite = true;
  }
  const seamMaterial = createGarmentMaterial(null, { color: seamColor, useTexture: false });
  seamMaterial.roughness = 0.92;
  seamMaterial.metalness = 0.01;

  const groupInfo = modelPayload.geometryGroups || null;
  const totalIndexCount = Array.isArray(modelPayload.indices) ? modelPayload.indices.length : 0;
  const mainIndexCount = Math.max(0, Math.min(totalIndexCount, Number(groupInfo?.mainIndexCount) || totalIndexCount));
  const seamWallIndexCount = Math.max(0, Math.min(totalIndexCount - mainIndexCount, Number(groupInfo?.seamWallIndexCount) || 0));

  if (mainIndexCount > 0) {
    geometry.addGroup(0, mainIndexCount, 0);
  }
  if (seamWallIndexCount > 0) {
    geometry.addGroup(mainIndexCount, seamWallIndexCount, 1);
  }
  if (mainIndexCount === 0 && totalIndexCount > 0) {
    geometry.addGroup(0, totalIndexCount, 0);
  }

  generatedGarmentMesh = new THREE_LIB.Mesh(geometry, seamWallIndexCount > 0 ? [mainMaterial, seamMaterial] : mainMaterial);
  generatedGarmentMesh.userData.garmentPayload = modelPayload;
  if (seamWallIndexCount > 0) {
    generatedGarmentMesh.userData.seamMaterial = seamMaterial;
  }
  generatedGarmentMesh.name = 'GeneratedGarmentMesh';
  generatedGarmentMesh.position.set(0, 0, 0);

  const bounds = new THREE_LIB.Box3().setFromObject(generatedGarmentMesh);
  const size = bounds.getSize(new THREE_LIB.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  generatedGarmentBaseScale = 1.5 / maxDimension;
  generatedGarmentMesh.scale.setScalar(generatedGarmentBaseScale);

  scene.add(generatedGarmentMesh);
  if (currentModel) alignGarmentToCurrentModel();
  startGarmentSimulation(modelPayload);
  if (!currentModel) fitModelToView(generatedGarmentMesh);
  if (clothingOverlay) {
    clothingOverlay.hidden = true;
  }
  currentGarmentCutout = null;
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

function inferGarmentTypeFromFileName(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (!name) return null;

  const checks = [
    { type: 'pants', tokens: ['jean', 'denim', 'trouser', 'pants', 'pant', 'jogger', 'legging', 'slack'] },
    { type: 'shorts', tokens: ['shorts', 'short'] },
    { type: 'skirt', tokens: ['skirt'] },
    { type: 'dress', tokens: ['dress', 'gown'] },
    { type: 'jacket', tokens: ['jacket', 'coat', 'blazer'] },
    { type: 'hoodie', tokens: ['hoodie', 'sweatshirt'] },
    { type: 'sweater', tokens: ['sweater', 'jumper', 'pullover'] },
    { type: 'romper', tokens: ['romper', 'jumpsuit'] },
    { type: 'shirt', tokens: ['shirt', 'tee', 'tshirt', 'top', 'blouse'] },
  ];

  for (const rule of checks) {
    for (const token of rule.tokens) {
      if (name.includes(token)) {
        return rule.type;
      }
    }
  }

  return null;
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

  // Prefer body-length style measurements, but never let sleeve/neck/shoulder drive
  // overall size representation for tops.
  const preferredBodyLength = list.find((entry) => {
    const type = String(entry.measurementType || '').toUpperCase();
    const isAux = type.includes('SLEEVE') || type.includes('ARMHOLE') || type.includes('SHOULDER') || type.includes('NECK');
    if (isAux) return false;
    return type.includes('BODY LENGTH') || type.includes('TOTAL LENGTH') || type.includes('LENGTH') || type.includes('INSEAM');
  });
  if (preferredBodyLength) {
    return preferredBodyLength;
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
        // Without an avatar, preserve size-driven garment reshaping on selection.
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

  // Do not auto-apply a size. Keep the generated outline-driven mesh unchanged
  // until the user explicitly chooses a size to avoid involuntary bloating.
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
      const currentType = getSelectedGarmentType();
      const inferredType = inferGarmentTypeFromFileName(file.name);
      if (garmentTypeSelect && currentType === 'shirt' && inferredType && inferredType !== currentType) {
        garmentTypeSelect.value = inferredType;
      }

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

  const cacheBust = Date.now();
  const response = await fetch(`${BACKEND_URL}/analyze-image?cb=${cacheBust}`, {
    method: 'POST',
    body: formData,
    cache: 'no-store',
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
    if (!isDraggingPreviewGarment) {
      return;
    }
    isDraggingPreviewGarment = false;
    // NEW: Recalculate seams when garment movement stops
    needsSeamRecalculation = true;
    recalculateSeamFeasibility();
  });
}

if (analyzeButton) {
  analyzeButton.addEventListener('click', async () => {
    const requestId = ++analyzeRequestId;
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
      const clothingResult = await analyzeImages(clothingFile, 'clothing', garmentType);
      cachedClothingAnalysisKey = analysisKey;
      cachedClothingResult = clothingResult;

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
      } else if (clothingResult.processedImageUrl) {
        clearGeneratedGarmentMesh();
        setCutoutOverlay(clothingResult.processedImageUrl, clothingResult.cutout);
      } else {
        clearGeneratedGarmentMesh();
        currentGarmentCutout = null;
        setClothingOverlay(clothingFile);
        updateDebugPanel('Fallback to original clothing overlay (no generated model).');
      }

      analysisResults.innerHTML = `
        <div>
          <h4>Clothing Image Analysis</h4>
          <pre>${formatAnalysis('Clothing Image', clothingResult.analysis)}</pre>
        </div>
      `;

      if (sizeGuideFiles.length > 0) {
        analyzeStatus.textContent = 'Garment preview ready. Processing size guide in background...';

        (async () => {
          try {
            const sizeGuideResult = await analyzeImages(sizeGuideFiles, 'sizeGuide', garmentType);
            if (requestId !== analyzeRequestId) return;

            const sizeGuideAnalyses = sizeGuideResult.sizeGuideEntries
              ? sizeGuideResult.sizeGuideEntries.map((entry) => entry.analysis)
              : (sizeGuideResult.analyses || (sizeGuideResult.analysis ? [sizeGuideResult.analysis] : []));
            const mergedSizes = sizeGuideResult.sizes || sortSizes(dedupeSizes(sizeGuideResult.rawSizeEntries || []));

            if (sizeGuideAnalyses.length > 0) {
              analysisResults.innerHTML += sizeGuideAnalyses
                .map((analysis, index) => `
                  <div style="margin-top: 1.25rem;">
                    <h4>Size Guide Analysis ${sizeGuideAnalyses.length > 1 ? `(${index + 1})` : ''}</h4>
                    <pre>${formatAnalysis('Size Guide Image', analysis)}</pre>
                  </div>
                `)
                .join('');
            }

            console.log('About to render sizes:', mergedSizes);
            renderSizeButtons(mergedSizes);
            analyzeStatus.textContent = 'Analysis complete.';
          } catch (sizeGuideError) {
            if (requestId !== analyzeRequestId) return;
            analyzeStatus.textContent = `Garment preview ready. Size guide parsing failed: ${sizeGuideError.message}`;
            if (sizeButtons) {
              sizeButtons.innerHTML = '';
            }
          }
        })();
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
