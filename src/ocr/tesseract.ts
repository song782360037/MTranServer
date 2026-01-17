import { createWorker, Worker, RecognizeResult } from 'tesseract.js';
import * as logger from '@/logger/index.js';

export interface TextBlock {
  text: string;
  confidence: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  baseline: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  fontSize: number;
  lineHeight: number;
}

export interface OCRResult {
  text: string;
  blocks: TextBlock[];
  confidence: number;
  language: string;
}

let worker: Worker | null = null;
let currentLang: string = '';
let initPromise: Promise<void> | null = null;

const LANG_MAP: Record<string, string> = {
  'en': 'eng',
  'zh': 'chi_sim',
  'zh-Hans': 'chi_sim',
  'zh-Hant': 'chi_tra',
  'ja': 'jpn',
  'ko': 'kor',
  'fr': 'fra',
  'de': 'deu',
  'es': 'spa',
  'it': 'ita',
  'pt': 'por',
  'ru': 'rus',
  'ar': 'ara',
  'vi': 'vie',
  'th': 'tha',
};

function mapLanguage(lang: string): string {
  return LANG_MAP[lang] || 'eng';
}

async function initWorker(lang: string): Promise<void> {
  const tessLang = mapLanguage(lang);
  
  if (worker && currentLang === tessLang) {
    return;
  }

  if (initPromise) {
    await initPromise;
    if (currentLang === tessLang) return;
  }

  initPromise = (async () => {
    try {
      if (worker) {
        logger.info(`Terminating previous OCR worker (${currentLang})`);
        await worker.terminate();
        worker = null;
      }

      logger.info(`Initializing Tesseract OCR worker for language: ${tessLang}`);
      
      worker = await createWorker(tessLang, 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            logger.debug(`OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        },
        // Only set langPath, let tesseract.js use local worker/core from node_modules
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      });

      currentLang = tessLang;
      logger.info(`Tesseract OCR worker initialized for ${tessLang}`);
    } catch (error) {
      logger.error(`Failed to initialize Tesseract worker: ${error}`);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  await initPromise;
}

export async function recognizeImage(
  imageBuffer: Buffer,
  language: string = 'en'
): Promise<OCRResult> {
  await initWorker(language);

  if (!worker) {
    throw new Error('OCR worker not initialized');
  }

  logger.info(`Starting OCR recognition for ${imageBuffer.length} bytes image`);

  const result: RecognizeResult = await worker.recognize(imageBuffer);
  const blocks: TextBlock[] = [];

  // Extract text blocks with position info
  if (result.data.lines) {
    for (const line of result.data.lines) {
      if (!line.text.trim()) continue;

      const bbox = line.bbox;
      const lineHeight = bbox.y1 - bbox.y0;
      
      // Estimate font size from line height (rough approximation)
      const fontSize = Math.max(12, Math.round(lineHeight * 0.75));

      blocks.push({
        text: line.text.trim(),
        confidence: line.confidence / 100,
        bbox: {
          x0: bbox.x0,
          y0: bbox.y0,
          x1: bbox.x1,
          y1: bbox.y1,
        },
        baseline: {
          x0: line.baseline?.x0 ?? bbox.x0,
          y0: line.baseline?.y0 ?? bbox.y1,
          x1: line.baseline?.x1 ?? bbox.x1,
          y1: line.baseline?.y1 ?? bbox.y1,
        },
        fontSize,
        lineHeight,
      });
    }
  }

  logger.info(`OCR completed: ${blocks.length} text blocks found, overall confidence: ${result.data.confidence}%`);

  return {
    text: result.data.text,
    blocks,
    confidence: result.data.confidence / 100,
    language: currentLang,
  };
}

export async function terminateWorker(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    currentLang = '';
    logger.info('OCR worker terminated');
  }
}
