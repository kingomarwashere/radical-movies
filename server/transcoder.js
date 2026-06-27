import ffmpeg from 'fluent-ffmpeg';
import path from 'path';

export function isFfmpegAvailable() {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => resolve(!err));
  });
}

export function transcodeToMP4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Try stream-copy first (fast — no re-encode)
    ffmpeg(inputPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-movflags +faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', () => {
        // Fall back to full re-encode if codec copy fails
        ffmpeg(inputPath)
          .outputOptions([
            '-c:v libx264', '-crf 20', '-preset fast',
            '-c:a aac', '-b:a 192k', '-movflags +faststart',
          ])
          .output(outputPath)
          .on('end', () => resolve(outputPath))
          .on('error', reject)
          .run();
      })
      .run();
  });
}

export function fastStartMP4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-c copy', '-movflags +faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

export function getExt(filePath) {
  return path.extname(filePath).toLowerCase();
}
