import * as logger from '@/logger/index.js';
import { recognizeImage, OCRResult, TextBlock } from '@/ocr/tesseract.js';
import { renderTranslatedImageSimple, TranslatedBlock, RenderOptions } from '@/ocr/renderer.js';
import { translateWithPivot } from './engine.js';
import { detectLanguage } from './detector.js';
import sharp from 'sharp';

// Max image dimension for OCR (larger images will be scaled down)
const MAX_IMAGE_DIMENSION = 2000;
// Max concurrent translations
const MAX_CONCURRENT_TRANSLATIONS = 10;

export interface ImageTranslateOptions {
  fromLang?: string;
  toLang: string;
  renderOptions?: RenderOptions;
}

export interface ImageTranslateResult {
  image: Buffer;
  ocrResult: OCRResult;
  translations: Array<{
    original: string;
    translated: string;
  }>;
}

/**
 * Translate text in an image
 */
export async function translateImage(
  imageBuffer: Buffer,
  options: ImageTranslateOptions
): Promise<ImageTranslateResult> {
  const { fromLang = 'auto', toLang, renderOptions } = options;

  logger.info(`Starting image translation: ${fromLang} -> ${toLang}`);

  // Step 0: Preprocess image (scale down if too large)
  const { processedBuffer, scale } = await preprocessImage(imageBuffer);
  
  // Step 1: Detect source language if auto
  let effectiveFromLang = fromLang;
  let ocrResult: OCRResult;
  
  if (fromLang === 'auto') {
    // Do a quick OCR with 'eng' to detect language
    const quickOcr = await recognizeImage(processedBuffer, 'eng');
    if (quickOcr.text.trim()) {
      effectiveFromLang = await detectLanguage(quickOcr.text);
      logger.info(`Auto-detected source language: ${effectiveFromLang}`);
      
      // Optimization: Reuse quickOcr result if detected language is English
      if (effectiveFromLang === 'en') {
        ocrResult = quickOcr;
        logger.info('Reusing English OCR result (avoiding duplicate OCR)');
      } else {
        // Need to re-OCR with correct language for better accuracy
        logger.info(`Performing OCR with language: ${effectiveFromLang}`);
        ocrResult = await recognizeImage(processedBuffer, effectiveFromLang);
      }
    } else {
      effectiveFromLang = 'en';
      logger.info(`No text detected, defaulting to: ${effectiveFromLang}`);
      ocrResult = quickOcr; // Reuse the empty result
    }
  } else {
    // Step 2: Perform OCR with specified language
    logger.info(`Performing OCR with language: ${effectiveFromLang}`);
    ocrResult = await recognizeImage(processedBuffer, effectiveFromLang);
  }

  if (ocrResult.blocks.length === 0) {
    logger.info('No text blocks found in image');
    return {
      image: imageBuffer,
      ocrResult,
      translations: [],
    };
  }

  logger.info(`Found ${ocrResult.blocks.length} text blocks to translate`);

  // Step 3: Translate text blocks in parallel batches
  const translatedBlocks = await translateBlocksParallel(
    ocrResult.blocks,
    effectiveFromLang,
    toLang,
    scale
  );

  const translations = translatedBlocks.map(b => ({
    original: b.text,
    translated: b.translatedText,
  }));

  // Step 4: Render translated text onto image
  logger.info('Rendering translated text onto image');
  const resultImage = await renderTranslatedImageSimple(
    imageBuffer,
    translatedBlocks,
    renderOptions
  );

  logger.info(`Image translation completed: ${translations.length} blocks translated`);

  return {
    image: resultImage,
    ocrResult,
    translations,
  };
}

/**
 * Extract text from image (OCR only, no translation)
 */
export async function extractTextFromImage(
  imageBuffer: Buffer,
  language: string = 'auto'
): Promise<OCRResult> {
  let effectiveLang = language;
  
  if (language === 'auto') {
    // Quick OCR to detect language
    const quickOcr = await recognizeImage(imageBuffer, 'eng');
    if (quickOcr.text.trim()) {
      effectiveLang = await detectLanguage(quickOcr.text);
    } else {
      effectiveLang = 'en';
    }
  }

  return recognizeImage(imageBuffer, effectiveLang);
}

/**
 * Preprocess image: scale down if too large
 */
async function preprocessImage(imageBuffer: Buffer): Promise<{ processedBuffer: Buffer; scale: number }> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  
  const maxDim = Math.max(width, height);
  
  if (maxDim <= MAX_IMAGE_DIMENSION) {
    return { processedBuffer: imageBuffer, scale: 1 };
  }
  
  const scale = MAX_IMAGE_DIMENSION / maxDim;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  
  logger.info(`Scaling image from ${width}x${height} to ${newWidth}x${newHeight} (scale: ${scale.toFixed(2)})`);
  
  const processedBuffer = await sharp(imageBuffer)
    .resize(newWidth, newHeight, { fit: 'inside' })
    .toBuffer();
  
  return { processedBuffer, scale };
}

/**
 * Translate text blocks in parallel batches
 */
async function translateBlocksParallel(
  blocks: TextBlock[],
  fromLang: string,
  toLang: string,
  scale: number
): Promise<TranslatedBlock[]> {
  const results: TranslatedBlock[] = [];
  
  // Process in batches for controlled parallelism
  for (let i = 0; i < blocks.length; i += MAX_CONCURRENT_TRANSLATIONS) {
    const batch = blocks.slice(i, i + MAX_CONCURRENT_TRANSLATIONS);
    
    const batchPromises = batch.map(async (block): Promise<TranslatedBlock> => {
      try {
        const translated = await translateWithPivot(fromLang, toLang, block.text, false);
        logger.debug(`Translated: "${block.text.substring(0, 30)}..." -> "${translated.substring(0, 30)}..."`);
        
        // Scale bbox back to original image coordinates if image was scaled
        const scaledBlock = scale !== 1 ? {
          ...block,
          bbox: {
            x0: Math.round(block.bbox.x0 / scale),
            y0: Math.round(block.bbox.y0 / scale),
            x1: Math.round(block.bbox.x1 / scale),
            y1: Math.round(block.bbox.y1 / scale),
          },
          fontSize: Math.round(block.fontSize / scale),
          lineHeight: Math.round(block.lineHeight / scale),
        } : block;
        
        return {
          ...scaledBlock,
          translatedText: translated,
        };
      } catch (error) {
        logger.warn(`Failed to translate block: ${error}`);
        return {
          ...block,
          translatedText: block.text,
        };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    if (i + MAX_CONCURRENT_TRANSLATIONS < blocks.length) {
      logger.debug(`Translated batch ${Math.floor(i / MAX_CONCURRENT_TRANSLATIONS) + 1}, ${results.length}/${blocks.length} done`);
    }
  }
  
  return results;
}
