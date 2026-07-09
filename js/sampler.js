import { carveRoughDiamond } from './silhouette.js'; // The carving logic from earlier

const video = document.getElementById('scannedVideo');
const processingCanvas = document.createElement('canvas'); // Hidden processing canvas
const ctx = processingCanvas.getContext('2d');

/**
 * Main Controller: Extracts frames evenly and triggers chunked carving
 * @param {number} totalFramesToSample - How many silhouette angles to use (e.g., 36)
 */
async function processVideoEfficiently(totalFramesToSample = 36) {
    console.log("Starting efficient extraction pipeline...");
    
    processingCanvas.width = video.videoWidth;
    processingCanvas.height = video.videoHeight;
    
    const duration = video.duration;
    const interval = duration / totalFramesToSample;
    const extractedFrames = [];

    // 1. Step through the video timeline and capture snapshots
    for (let i = 0; i < totalFramesToSample; i++) {
        const targetTime = i * interval;
        
        // Seek to the precise timestamp
        video.currentTime = targetTime;
        
        // Wait for the video seek operation to complete safely
        await new Promise((resolve) => {
            video.onseeked = resolve;
        });

        // Draw current frame to hidden canvas
        ctx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
        
        // Create an offline Canvas element to preserve this specific frame's pixels
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = processingCanvas.width;
        frameCanvas.height = processingCanvas.height;
        frameCanvas.getContext('2d').drawImage(processingCanvas, 0, 0);

        // Map the video timeline progress to a 360-degree rotation angle (in radians)
        const currentAngle = (i / totalFramesToSample) * Math.PI * 2;

        extractedFrames.push({
            canvas: frameCanvas,
            angle: currentAngle
        });
    }

    console.log(`Successfully extracted ${extractedFrames.length} clean sample frames.`);
    console.log("Starting asynchronous voxel carving...");
    // 2. The carving function is now async and handles its own chunking.
    // We just need to await it and pass a progress handler.
    // NOTE: This assumes 'camera' is available in this scope from your main script.
    await carveRoughDiamond(extractedFrames, camera, updateProgressBar);
    console.log("Voxel carving finalized!");
}

function updateProgressBar(percentage) {
    // Basic DOM updating logic for a smooth loading bar
    const bar = document.getElementById('loadingBar');
    if (bar) bar.style.width = `${percentage}%`;
}