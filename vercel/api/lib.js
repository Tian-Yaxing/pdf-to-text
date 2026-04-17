import pdfParse from 'pdf-parse';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = pdfParse.default || pdfParse;

// OCR.space API (免费，响应快，无需注册)
const OCR_SPACE_API_KEY = process.env.OCR_API_KEY || 'helloworld'; // 免费测试 key

/**
 * 使用 OCR.space API 直接 OCR PDF
 */
export async function ocrPdf(pdfBuffer, lang = 'eng') {
  const formData = new FormData();
  formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'document.pdf');
  formData.append('language', lang === 'chi_sim+eng' ? 'chseng' : lang === 'chi_sim' ? 'chs' : lang === 'chi_tra' ? 'cht' : 'eng');
  formData.append('isOverlayRequired', 'false');
  formData.append('OCREngine', '2'); // Engine 2 更快

  try {
    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        'apikey': OCR_SPACE_API_KEY
      },
      body: formData
    });

    const result = await response.json();

    if (result.OCRExitCode === 1 && result.ParsedResults?.length > 0) {
      return result.ParsedResults.map(p => p.ParsedText.trim()).join('\n\n');
    }

    throw new Error(result.ErrorMessage || 'OCR failed');
  } catch (error) {
    console.error('OCR.space error:', error);
    throw error;
  }
}

/**
 * Vercel 轻量版 PDF 转文本（无 OCR）
 * 只支持文本型 PDF，不支持扫描版
 */
export async function pdfToTextLight(input, options = {}) {
  const { splitPages = false } = options;

  let dataBuffer;
  if (Buffer.isBuffer(input)) {
    dataBuffer = input;
  } else {
    const fs = await import('fs/promises');
    dataBuffer = await fs.readFile(input);
  }

  const pageTexts = [];
  const pageTextItems = [];
  let fullText = '';

  const result = await pdf(dataBuffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent();
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ');

      pageTexts.push(pageText);
      fullText += pageText + '\n\n';

      // 保存位置信息用于表格解析
      pageTextItems.push(textContent.items.map(item => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height
      })));

      return pageText;
    }
  });

  return {
    pages: result.numpages,
    text: fullText.trim(),
    pageTexts: splitPages ? pageTexts : undefined,
    pageTextItems: pageTextItems,
    metadata: {
      info: result.info,
      version: result.version,
      ocrUsed: false
    }
  };
}

/**
 * 基于位置的表格文本解析
 */
export function parseTableText(textItems) {
  const results = [];

  const fieldConfigs = {
    '管线号': { minY: 50, maxY: 60, minX: 250, maxX: 450, pattern: /^71-\d+-N7-UC\d+-[A-Z0-9]+-N$/ },
    '材料等级': { minY: 50, maxY: 60, minX: 480, maxX: 520 },
    '管道级别': { minY: 50, maxY: 60, minX: 560, maxX: 600, pattern: /^GC\d$/ },
    '设计温度': { minY: 50, maxY: 60, minX: 640, maxX: 680 },
    '操作温度': { minY: 50, maxY: 60, minX: 720, maxX: 760 },
    '设计压力': { minY: 50, maxY: 60, minX: 800, maxX: 860 },
    '操作压力': { minY: 50, maxY: 60, minX: 880, maxX: 920 },
    '保温类型': { minY: 50, maxY: 60, minX: 940, maxX: 1000 },
    '保温厚度': { minY: 50, maxY: 60, minX: 1020, maxX: 1080 },
    '刷漆': { minY: 50, maxY: 60, minX: 1100, maxX: 1160 },
    '比例': { minY: 28, maxY: 35, minX: 1200, maxX: 1260, excludePatterns: ['SCALE', '比例', 'N/A'] },
    '图号': { minY: 28, maxY: 35, minX: 1265, maxX: 1350, excludePatterns: ['DWG', '图号', 'N/A'] },
    '项目号': { minY: 90, maxY: 96, minX: 1580, maxX: 1610 }
  };

  for (const [key, config] of Object.entries(fieldConfigs)) {
    const matchingItems = textItems.filter(item => {
      if (item.y < config.minY || item.y > config.maxY) return false;
      if (config.minX !== undefined && item.x < config.minX) return false;
      if (config.maxX !== undefined && item.x > config.maxX) return false;
      if (config.excludePatterns && config.excludePatterns.some(p => item.str.includes(p))) return false;
      if (config.pattern && !config.pattern.test(item.str)) return false;
      return item.str.trim().length > 0;
    });

    if (matchingItems.length > 0) {
      const value = matchingItems[0].str.trim();
      results.push({ key, value, x: matchingItems[0].x, y: matchingItems[0].y });
    }
  }

  return results;
}