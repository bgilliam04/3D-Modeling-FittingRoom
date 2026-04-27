let removeBackgroundFn = null;

function getRemoveBackground() {
  if (!removeBackgroundFn) {
    ({ removeBackground: removeBackgroundFn } = require('@imgly/background-removal-node'));
  }

  return removeBackgroundFn;
}

async function run(message) {
  if (!message || typeof message.imageBase64 !== 'string' || !message.imageBase64) {
    throw new Error('Worker did not receive a valid image payload.');
  }

  const mimeType = typeof message.mimeType === 'string' && message.mimeType ? message.mimeType : 'image/png';
  const inputBuffer = Buffer.from(message.imageBase64, 'base64');
  const removeBackground = getRemoveBackground();
  const inputBlob = new Blob([inputBuffer], { type: mimeType });

  const outputBlob = await removeBackground(inputBlob, {
    model: 'medium',
    output: {
      quality: 0.8,
      format: 'image/png',
      type: 'foreground',
    },
  });

  const outputArrayBuffer = await outputBlob.arrayBuffer();
  const outputBuffer = Buffer.from(outputArrayBuffer);
  return outputBuffer.toString('base64');
}

process.on('message', async (message) => {
  try {
    const outputBase64 = await run(message);
    if (typeof process.send === 'function') {
      process.send({ ok: true, outputBase64 });
    }
    process.exit(0);
  } catch (error) {
    if (typeof process.send === 'function') {
      process.send({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown worker error',
      });
    }
    process.exit(1);
  }
});
