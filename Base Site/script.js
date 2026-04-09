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
const sizeGuideUpload = document.getElementById('sizeGuideUpload');
const analyzeButton = document.getElementById('analyzeButton');
const analysisResults = document.getElementById('analysisResults');
const analyzeStatus = document.getElementById('analyzeStatus');
const modelContainer = document.getElementById('modelContainer');
const BACKEND_URL = 'http://localhost:4000';

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let currentModel = null;

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

function loadScanFile(file) {
  if (!file) return;
  if (!modelContainer) return;

  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.glb') && !fileName.endsWith('.gltf') && !fileName.endsWith('.obj')) {
    alert('Please upload a .glb, .gltf, or .obj scan file');
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
    if (fileName.endsWith('.obj')) {
      const text = event.target.result;
      const loader = new THREE.OBJLoader();
      const object = loader.parse(text);
      object.traverse((child) => {
        if (child.isMesh) {
          child.material.side = THREE.DoubleSide;
        }
      });
      currentModel = object;
      scene.add(currentModel);
      fitModelToView(currentModel);
    } else {
      const loader = new THREE.GLTFLoader();
      loader.parse(event.target.result, '', (gltf) => {
        currentModel = gltf.scene;
        scene.add(currentModel);
        fitModelToView(currentModel);
      }, undefined, (error) => {
        console.error('GLTF parse error:', error);
        alert('Error loading scan. Make sure the file is a valid .glb or .gltf.');
      });
    }
  };

  if (fileName.endsWith('.obj')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}

if (scanUpload) {
  scanUpload.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      loadScanFile(file);
    }
  });
}

async function analyzeFile(file) {
  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch(`${BACKEND_URL}/analyze-image`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Image analyzer request failed.');
  }

  const result = await response.json();
  return result.analysis;
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

if (analyzeButton) {
  analyzeButton.addEventListener('click', async () => {
    analysisResults.innerHTML = '';
    analyzeStatus.textContent = '';

    const clothingFile = clothingUpload?.files[0];
    const sizeGuideFile = sizeGuideUpload?.files[0];

    if (!clothingFile || !sizeGuideFile) {
      analyzeStatus.textContent = 'Please upload both a clothing image and a size guide image.';
      return;
    }

    analyzeStatus.textContent = 'Analyzing images...';

    try {
      const [clothingAnalysis, sizeGuideAnalysis] = await Promise.all([
        analyzeFile(clothingFile),
        analyzeFile(sizeGuideFile),
      ]);

      analysisResults.innerHTML = `
        <div>
          <h4>Clothing Image Analysis</h4>
          <pre>${formatAnalysis('Clothing Image', clothingAnalysis)}</pre>
        </div>
        <div style="margin-top: 1.25rem;">
          <h4>Size Guide Analysis</h4>
          <pre>${formatAnalysis('Size Guide Image', sizeGuideAnalysis)}</pre>
        </div>
      `;
      analyzeStatus.textContent = 'Analysis complete.';
    } catch (error) {
      analyzeStatus.textContent = error.message;
      analysisResults.textContent = '';
    }
  });
}
