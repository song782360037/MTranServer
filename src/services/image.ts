import * as logger from '@/logger/index.js';
import { recognizeImage, OCRResult } from '@/ocr/tesseract.js';
import { renderTranslatedImageSimple, TranslatedBlock, RenderOptions } from '@/ocr/renderer.js';
import { translateWithPivot } from './engine.js';
import { detectLanguage } from './detector.js';

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

  // Step 1: Detect source language if auto
  let effectiveFromLang = fromLang;
  if (fromLang === 'auto') {
    // Do a quick OCR to detect language
    const quickOcr = await recognizeImage(imageBuffer, 'eng');
    if (quickOcr.text.trim()) {
      effectiveFromLang = await detectLanguage(quickOcr.text);
      logger.info(`Auto-detected source language: ${effectiveFromLang}`);
    } else {
      effectiveFromLang = 'en';
      logger.info(`No text detected, defaulting to: ${effectiveFromLang}`);
    }
  }

  // Step 2: Perform OCR with detected/specified language
  logger.info(`Performing OCR with language: ${effectiveFromLang}`);
  const ocrResult = await recognizeImage(imageBuffer, effectiveFromLang);

  if (ocrResult.blocks.length === 0) {
    logger.info('No text blocks found in image');
    return {
      image: imageBuffer,
      ocrResult,
      translations: [],
    };
  }

  logger.info(`Found ${ocrResult.blocks.length} text blocks to translate`);

  // Step 3: Translate each text block
  const translatedBlocks: TranslatedBlock[] = [];
  const translations: Array<{ original: string; translated: string }> = [];

  for (const block of ocrResult.blocks) {
    try {
      const translated = await translateWithPivot(
        effectiveFromLang,
        toLang,
        block.text,
        false
      );

      translatedBlocks.push({
        ...block,
        translatedText: translated,
      });

      translations.push({
        original: block.text,
        translated,
      });

      logger.debug(`Translated: "${block.text}" -> "${translated}"`);
    } catch (error) {
      logger.warn(`Failed to translate block: ${error}`);
      // Keep original text on error
      translatedBlocks.push({
        ...block,
        translatedText: block.text,
      });
    }
  }

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
