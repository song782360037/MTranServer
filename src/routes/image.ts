import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as logger from '@/logger/index.js';
import { translateImage, extractTextFromImage } from '@/services/image.js';
import { NormalizeLanguageCode } from '@/utils/index.js';
import { authMiddleware } from '@/middleware/auth.js';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${allowedMimes.join(', ')}`));
    }
  },
});

/**
 * @api {post} /image/translate Translate text in image
 * @apiName TranslateImage
 * @apiGroup Image
 * @apiDescription Upload an image and translate the text within it
 * 
 * @apiParam {File} image Image file (JPEG, PNG, GIF, WebP, BMP)
 * @apiParam {String} [from=auto] Source language code
 * @apiParam {String} to Target language code
 * @apiParam {String} [format=image] Response format: 'image' or 'json'
 * 
 * @apiSuccess {Buffer} image Translated image (when format=image)
 * @apiSuccess {Object} result Translation result (when format=json)
 */
router.post('/translate', authMiddleware, upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }

    const fromLang = req.body.from || 'auto';
    const toLang = req.body.to;
    const format = req.body.format || 'image';

    if (!toLang) {
      res.status(400).json({ error: 'Target language (to) is required' });
      return;
    }

    logger.info(`Image translate request: ${fromLang} -> ${toLang}, size: ${req.file.size} bytes`);

    const normalizedTo = NormalizeLanguageCode(toLang);
    const normalizedFrom = fromLang === 'auto' ? 'auto' : NormalizeLanguageCode(fromLang);

    const result = await translateImage(req.file.buffer, {
      fromLang: normalizedFrom,
      toLang: normalizedTo,
    });

    if (format === 'json') {
      res.json({
        success: true,
        translations: result.translations,
        confidence: result.ocrResult.confidence,
        detectedLanguage: result.ocrResult.language,
        // Include base64 encoded image
        image: result.image.toString('base64'),
      });
    } else {
      res.set('Content-Type', 'image/png');
      res.set('X-OCR-Confidence', String(result.ocrResult.confidence));
      res.set('X-Detected-Language', result.ocrResult.language);
      res.set('X-Translations-Count', String(result.translations.length));
      res.send(result.image);
    }
  } catch (error: any) {
    logger.error(`Image translation error: ${error.message}`);
    res.status(500).json({ error: error.message || 'Image translation failed' });
  }
});

/**
 * @api {post} /image/ocr Extract text from image (OCR only)
 * @apiName OCRImage
 * @apiGroup Image
 * @apiDescription Upload an image and extract text using OCR
 * 
 * @apiParam {File} image Image file (JPEG, PNG, GIF, WebP, BMP)
 * @apiParam {String} [lang=auto] Language code for OCR
 * 
 * @apiSuccess {String} text Extracted text
 * @apiSuccess {Array} blocks Text blocks with position info
 */
router.post('/ocr', authMiddleware, upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }

    const lang = req.body.lang || 'auto';

    logger.info(`OCR request: lang=${lang}, size: ${req.file.size} bytes`);

    const normalizedLang = lang === 'auto' ? 'auto' : NormalizeLanguageCode(lang);
    const result = await extractTextFromImage(req.file.buffer, normalizedLang);

    res.json({
      success: true,
      text: result.text,
      blocks: result.blocks,
      confidence: result.confidence,
      language: result.language,
    });
  } catch (error: any) {
    logger.error(`OCR error: ${error.message}`);
    res.status(500).json({ error: error.message || 'OCR failed' });
  }
});

export default router;
