import ffmpeg from 'fluent-ffmpeg';
import path from 'path';

export function isFfmpegAvailable() {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => resolve(!err));
  });
}

export function transcodeToMP4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // First attempt: stream-copy video + re-encode audio only (fast, no quality loss)
    ffmpeg(inputPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-movflags +faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', () => {
        // Fallback: full re-encode (slow but universal — only MKV remux with weird codecs hits this)
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

// Check if file needs any processing at all
export function needsTranscode(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext !== '.mp4' && ext !== '.m4v' && ext !== '.webm';
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
