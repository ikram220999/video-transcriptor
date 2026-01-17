import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Download a YouTube video using yt-dlp CLI
 * @param {string} youtubeUrl - The YouTube video URL
 * @param {object} options - Download options
 * @param {string} options.outputDir - Directory to save the video (default: 'uploads')
 * @param {string} options.filename - Custom filename (without extension)
 * @param {function} options.onProgress - Progress callback (optional)
 * @returns {Promise<{videoPath: string, title: string, duration: number}>}
 */
export async function downloadYoutubeVideo(youtubeUrl, options = {}) {
  const {
    outputDir = path.join(__dirname, 'uploads'),
    filename = `yt-${Date.now()}`,
    onProgress = null,
  } = options;

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Clean the URL (remove playlist params if only downloading single video)
  const cleanUrl = cleanYoutubeUrl(youtubeUrl);

  console.log('\n' + '═'.repeat(60));
  console.log('📺 YOUTUBE VIDEO DOWNLOADER');
  console.log('═'.repeat(60));
  console.log(`🔗 URL: ${cleanUrl}`);
  console.log(`📁 Output: ${outputDir}`);

  // First, get video info
  if (onProgress) onProgress({ step: 'info', message: 'Fetching video info...' });
  const videoInfo = await getVideoInfo(cleanUrl);
  
  console.log(`📝 Title: ${videoInfo.title}`);
  console.log(`⏱️  Duration: ${videoInfo.duration}s`);

  // Check duration limit (60 seconds)
  if (videoInfo.duration > 1000) {
    throw new Error(`Video too long. Maximum duration is 60 seconds. This video is ${videoInfo.duration} seconds.`);
  }

  // Download the video
  if (onProgress) onProgress({ step: 'download', message: 'Downloading video...' });
  
  const outputPath = path.join(outputDir, `${filename}.mp4`);
  
  await downloadVideo(cleanUrl, outputPath, (progress) => {
    console.log(`   ⬇️  Download: ${progress}%`);
    if (onProgress) onProgress({ step: 'download', message: `Downloading: ${progress}%`, progress });
  });

  // Verify the file exists
  try {
    await fs.access(outputPath);
  } catch {
    throw new Error('Download failed - video file not found');
  }

  const stats = await fs.stat(outputPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`✅ Downloaded: ${outputPath}`);
  console.log(`📦 Size: ${sizeMB} MB`);
  console.log('═'.repeat(60) + '\n');

  // Check file size limit (30MB)
  if (stats.size > 300 * 1024 * 1024) {
    await fs.unlink(outputPath);
    throw new Error(`Downloaded video too large. Maximum size is 30MB. This video is ${sizeMB}MB.`);
  }

  return {
    videoPath: outputPath,
    title: videoInfo.title,
    duration: videoInfo.duration,
    sizeMB: parseFloat(sizeMB),
  };
}

/**
 * Get video information using yt-dlp
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      url,
    ];

    const ytdlp = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to get video info: ${stderr || 'Unknown error'}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'Unknown',
          duration: info.duration || 0,
          thumbnail: info.thumbnail || null,
          uploader: info.uploader || 'Unknown',
          viewCount: info.view_count || 0,
        });
      } catch (e) {
        reject(new Error('Failed to parse video info'));
      }
    });

    ytdlp.on('error', (err) => {
      reject(new Error(`yt-dlp not found. Please install it: ${err.message}`));
    });
  });
}

/**
 * Download video using yt-dlp
 */
function downloadVideo(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--newline', // For progress parsing
      '-o', outputPath,
      url,
    ];

    const ytdlp = spawn('yt-dlp', args);
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      // Parse progress from yt-dlp output
      const match = output.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        onProgress(parseFloat(match[1]));
      }
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
      // yt-dlp sometimes outputs progress to stderr
      const match = data.toString().match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        onProgress(parseFloat(match[1]));
      }
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Download failed: ${stderr || 'Unknown error'}`));
        return;
      }
      resolve();
    });

    ytdlp.on('error', (err) => {
      reject(new Error(`yt-dlp not found. Please install yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Clean YouTube URL - remove playlist parameters for single video download
 */
function cleanYoutubeUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // Keep only the 'v' parameter for youtube.com/watch URLs
    if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    
    // For youtu.be short URLs, return as-is
    if (urlObj.hostname === 'youtu.be') {
      return `https://youtu.be${urlObj.pathname}`;
    }
    
    return url;
  } catch {
    return url;
  }
}

/**
 * Validate if URL is a valid YouTube URL
 */
export function isValidYoutubeUrl(url) {
  try {
    const urlObj = new URL(url);
    const validHosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'];
    return validHosts.some(host => urlObj.hostname === host || urlObj.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

// CLI support for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const testUrl = process.argv[2];
  if (!testUrl) {
    console.log('Usage: node youtubeVideoDownloader.js <youtube-url>');
    process.exit(1);
  }

  downloadYoutubeVideo(testUrl, {
    onProgress: (p) => console.log(`Progress: ${JSON.stringify(p)}`),
  })
    .then((result) => {
      console.log('Download complete:', result);
    })
    .catch((err) => {
      console.error('Download failed:', err.message);
      process.exit(1);
    });
}
