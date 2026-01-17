import sharp from 'sharp';
import * as logger from '@/logger/index.js';
import { TextBlock } from './tesseract.js';

export interface TranslatedBlock extends TextBlock {
  translatedText: string;
}

export interface RenderOptions {
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  padding?: number;
}

const DEFAULT_OPTIONS: RenderOptions = {
  backgroundColor: '#FFFFFF',
  textColor: '#000000',
  fontFamily: 'sans-serif',
  padding: 4,
};

/**
 * Renders translated text blocks onto the original image
 */
export async function renderTranslatedImage(
  imageBuffer: Buffer,
  blocks: TranslatedBlock[],
  options: RenderOptions = {}
): Promise<Buffer> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  logger.info(`Rendering ${blocks.length} translated blocks onto image`);

  // Get image metadata
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 600;

  // Generate SVG overlay with translated text
  const svgElements: string[] = [];

  for (const block of blocks) {
    if (!block.translatedText.trim()) continue;

    const { bbox, fontSize, translatedText } = block;
    const blockWidth = bbox.x1 - bbox.x0;
    const blockHeight = bbox.y1 - bbox.y0;

    // Create background rectangle to cover original text
    svgElements.push(`
      <rect 
        x="${bbox.x0}" 
        y="${bbox.y0}" 
        width="${blockWidth}" 
        height="${blockHeight}" 
        fill="${opts.backgroundColor}"
      />
    `);

    // Calculate font size to fit the text in the block
    const adjustedFontSize = calculateFontSize(translatedText, blockWidth, blockHeight, fontSize);

    // Add translated text
    // Use foreignObject for better text wrapping support
    svgElements.push(`
      <foreignObject 
        x="${bbox.x0 + opts.padding!}" 
        y="${bbox.y0}" 
        width="${blockWidth - opts.padding! * 2}" 
        height="${blockHeight}"
      >
        <div xmlns="http://www.w3.org/1999/xhtml" style="
          font-family: ${opts.fontFamily};
          font-size: ${adjustedFontSize}px;
          color: ${opts.textColor};
          line-height: ${blockHeight}px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        ">${escapeHtml(translatedText)}</div>
      </foreignObject>
    `);
  }

  const svgOverlay = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/1999/xhtml">
      ${svgElements.join('\n')}
    </svg>
  `;

  // Composite the SVG overlay onto the original image
  const result = await image
    .composite([
      {
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  logger.info(`Image rendering completed, output size: ${result.length} bytes`);

  return result;
}

/**
 * Simple rendering without SVG foreignObject (better compatibility)
 */
export async function renderTranslatedImageSimple(
  imageBuffer: Buffer,
  blocks: TranslatedBlock[],
  options: RenderOptions = {}
): Promise<Buffer> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  logger.info(`Rendering ${blocks.length} translated blocks (simple mode)`);

  let image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 600;

  // Create composite operations for each block
  const composites: sharp.OverlayOptions[] = [];

  for (const block of blocks) {
    if (!block.translatedText.trim()) continue;

    const { bbox, fontSize, translatedText } = block;
    const blockWidth = Math.max(1, bbox.x1 - bbox.x0);
    const blockHeight = Math.max(1, bbox.y1 - bbox.y0);

    // Calculate adjusted font size
    const adjustedFontSize = calculateFontSize(translatedText, blockWidth, blockHeight, fontSize);

    // Create SVG for this single block
    const blockSvg = `
      <svg width="${blockWidth}" height="${blockHeight}">
        <rect x="0" y="0" width="${blockWidth}" height="${blockHeight}" fill="${opts.backgroundColor}"/>
        <text 
          x="${opts.padding}" 
          y="${blockHeight * 0.75}" 
          font-family="${opts.fontFamily}" 
          font-size="${adjustedFontSize}"
          fill="${opts.textColor}"
        >${escapeHtml(truncateText(translatedText, blockWidth, adjustedFontSize))}</text>
      </svg>
    `;

    composites.push({
      input: Buffer.from(blockSvg),
      top: Math.round(bbox.y0),
      left: Math.round(bbox.x0),
    });
  }

  if (composites.length > 0) {
    image = image.composite(composites);
  }

  const result = await image.png().toBuffer();

  logger.info(`Simple rendering completed, output size: ${result.length} bytes`);

  return result;
}

/**
 * Calculate appropriate font size to fit text in given dimensions
 */
function calculateFontSize(
  text: string,
  maxWidth: number,
  maxHeight: number,
  originalFontSize: number
): number {
  // Estimate character width (rough approximation)
  const avgCharWidth = originalFontSize * 0.6;
  const estimatedWidth = text.length * avgCharWidth;
  
  // Scale down if text is too wide
  let fontSize = originalFontSize;
  if (estimatedWidth > maxWidth) {
    fontSize = Math.floor((maxWidth / estimatedWidth) * originalFontSize);
  }
  
  // Ensure font size doesn't exceed block height
  fontSize = Math.min(fontSize, maxHeight * 0.8);
  
  // Minimum font size
  return Math.max(8, fontSize);
}

/**
 * Truncate text to fit within given width
 */
function truncateText(text: string, maxWidth: number, fontSize: number): string {
  const avgCharWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidth / avgCharWidth);
  
  if (text.length <= maxChars) {
    return text;
  }
  
  return text.substring(0, maxChars - 1) + '…';
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Get image info
 */
export async function getImageInfo(imageBuffer: Buffer): Promise<{
  width: number;
  height: number;
  format: string;
}> {
  const metadata = await sharp(imageBuffer).metadata();
  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || 'unknown',
  };
}
