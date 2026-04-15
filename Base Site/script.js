const navToggle = document.getElementById('navToggle');
const siteNav = document.getElementById('siteNav');
const contactForm = document.getElementById('contactForm');
const formStatus = document.getElementById('formStatus');

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
const analyzeButton = document.getElementById('analyzeButton');
const analysisResults = document.getElementById('analysisResults');
const analyzeStatus = document.getElementById('analyzeStatus');
const modelContainer = document.getElementById('modelContainer');
const clothingOverlay = document.getElementById('clothingOverlay');
const sizeButtons = document.getElementById('sizeButtons');
const previewHint = document.getElementById('previewHint');
const BACKEND_URL = 'http://localhost:4000';

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let currentModel = null;
let clothingPreviewJobId = 0;
let currentClothingSizeValue = null;
let currentGarmentCutout = null;
let cachedClothingAnalysisKey = null;
let cachedClothingResult = null;

function initModelViewer() {
  if (!modelContainer) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b13);

  const width = modelContainer.clientWidth;
  const height = Math.max(modelContainer.clientHeight, 300);

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(0, 1.5, 5);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 10, 7);
  scene.add(light);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

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
  if (currentModel) {
    currentModel.rotation.y += 0.003;
  }
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function fitModelToView(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
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
  // Convert inches to pixels relative to the preview window size
  if (!modelContainer) return 200; // Fallback if container not available
  
  const previewWidth = modelContainer.clientWidth;
  const previewHeight = modelContainer.clientHeight;
  const cutoutWidth = currentGarmentCutout?.width || clothingOverlay?.naturalWidth || 1;
  const cutoutHeight = currentGarmentCutout?.height || clothingOverlay?.naturalHeight || 1;
  const cutoutAspectRatio = cutoutWidth / Math.max(1, cutoutHeight);
  
  // Assume 20 inches is a reasonable reference width that should take up ~80% of preview
  // This makes smaller sizes (12-15") fit within the preview nicely
  const referenceWidth = 20;
  const fillPercentage = 0.8; // Allow some margin on sides
  
  const pixelsPerInch = (previewWidth * fillPercentage) / referenceWidth;
  const widthInPixels = Math.round(sizeValue * pixelsPerInch);
  
  // Constrain to reasonable bounds and keep the scaled cutout inside the preview height.
  const minWidth = 50;
  const maxWidthByContainer = Math.round(previewWidth * 0.95);
  const maxHeightByContainer = Math.round(previewHeight * 0.92);
  const maxWidthByCutoutHeight = Math.round(maxHeightByContainer * cutoutAspectRatio);
  const maxWidth = Math.max(minWidth, Math.min(maxWidthByContainer, maxWidthByCutoutHeight));
  const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, widthInPixels));
  
  console.log(
    `Size ${sizeValue}" in ${previewWidth}x${previewHeight}px preview with cutout ${cutoutWidth}x${cutoutHeight}px -> ${widthInPixels}px (constrained: ${constrainedWidth}px)`
  );
  return constrainedWidth;
}

function resizeClothingImage(sizeValue) {
  if (!clothingOverlay || clothingOverlay.hidden) return;
  
  const newWidth = calculateImageWidth(sizeValue);
  clothingOverlay.style.width = newWidth + 'px';
  clothingOverlay.style.height = 'auto';
  clothingOverlay.style.maxWidth = 'none';
  clothingOverlay.style.maxHeight = 'none';
}

function applySelectedClothingSize() {
  if (currentClothingSizeValue === null || currentClothingSizeValue === undefined) return;
  resizeClothingImage(currentClothingSizeValue);
}

function createSizeButton(size) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'size-button';
  button.textContent = `${size.label} (${size.value})`;
  button.dataset.sizeValue = size.value;
  button.addEventListener('click', () => {
    document.querySelectorAll('.size-button').forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    currentClothingSizeValue = size.value;
    analyzeStatus.textContent = `Selected ${size.label} — ${size.value}`;
    resizeClothingImage(size.value);
  });
  return button;
}

function renderSizeButtons(sizes) {
  if (!sizeButtons) return;
  sizeButtons.innerHTML = '';

  if (!sizes || sizes.length === 0) {
    sizeButtons.textContent = 'No sizes detected. Upload a clearer size guide image or rename the file to include size labels.';
    return;
  }

  sizes.forEach((size) => {
    if (size.label && typeof size.value !== 'undefined') {
      sizeButtons.appendChild(createSizeButton(size));
    }
  });
}

function loadScanFile(file) {
  if (!file) return;
  if (!modelContainer) return;

  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.glb') && !fileName.endsWith('.gltf')) {
    alert('Please upload a .glb or .gltf scan file');
    return;
  }

  if (!scene) {
    initModelViewer();
  }

  if (currentModel) {
    scene.remove(currentModel);
    currentModel = null;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    console.log('File loaded, processing...');
    const loader = new THREE.GLTFLoader();
    loader.parse(event.target.result, '', (gltf) => {
      currentModel = gltf.scene;
      // Traverse the model to ensure materials are visible
      currentModel.traverse((child) => {
        if (child.isMesh) {
          // Only replace material if it doesn't exist or is completely transparent
          if (!child.material || child.material.opacity === 0) {
            child.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.1 });
          }
          // Ensure both sides are visible
          if (child.material) {
            child.material.side = THREE.DoubleSide;
          }
        }
      });
      scene.add(currentModel);
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
      clothingPreviewJobId += 1;
      cachedClothingAnalysisKey = null;
      cachedClothingResult = null;
      currentGarmentCutout = null;
      setClothingOverlay(file);
      analyzeStatus.textContent = 'Clothing image ready. Press Analyze to process garment cutout.';
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

async function analyzeFile(file, type, garmentType = null) {
  const formData = new FormData();
  formData.append('image', file);
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

    const clothingFile = clothingUpload?.files[0];
    const sizeGuideFile = sizeGuideUpload?.files[0];
    const garmentType = getSelectedGarmentType();
    const analysisKey = getClothingAnalysisKey(clothingFile, garmentType);

    if (!clothingFile || !sizeGuideFile) {
      analyzeStatus.textContent = 'Please upload both a clothing image and a size guide image.';
      return;
    }

    analyzeStatus.textContent = 'Analyzing images...';

    try {
      let clothingResult = cachedClothingResult;
      if (!clothingResult || analysisKey !== cachedClothingAnalysisKey) {
        clothingResult = await analyzeFile(clothingFile, 'clothing', garmentType);
        cachedClothingAnalysisKey = analysisKey;
        cachedClothingResult = clothingResult;
      }

      const sizeGuideResult = await analyzeFile(sizeGuideFile, 'sizeGuide');

      console.log('Clothing result:', clothingResult);
      console.log('Size guide result:', sizeGuideResult);

      if (clothingResult.processedImageUrl) {
        setCutoutOverlay(clothingResult.processedImageUrl, clothingResult.cutout);
      } else {
        currentGarmentCutout = null;
        setClothingOverlay(clothingFile);
      }

      analysisResults.innerHTML = `
        <div>
          <h4>Clothing Image Analysis</h4>
          <pre>${formatAnalysis('Clothing Image', clothingResult.analysis)}</pre>
        </div>
        <div style="margin-top: 1.25rem;">
          <h4>Size Guide Analysis</h4>
          <pre>${formatAnalysis('Size Guide Image', sizeGuideResult.analysis)}</pre>
        </div>
      `;

      console.log('About to render sizes:', sizeGuideResult.sizes);
      renderSizeButtons(sizeGuideResult.sizes || []);
      analyzeStatus.textContent = 'Analysis complete.';
    } catch (error) {
      analyzeStatus.textContent = error.message;
      analysisResults.textContent = '';
      if (sizeButtons) {
        sizeButtons.innerHTML = '';
      }
    }
  });
}
