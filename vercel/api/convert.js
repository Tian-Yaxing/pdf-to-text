import { pdfToTextLight, parseTableText, ocrPdf } from './lib.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 获取上传的文件
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (!buffer.length) {
      return res.status(400).json({ error: '请上传 PDF 文件' });
    }

    const splitPages = req.query.splitPages === 'true';
    const useOcr = req.query.ocr === 'true';
    const lang = req.query.lang || 'eng';

    // 如果需要 OCR，使用第三方 API
    if (useOcr) {
      console.log('Using OCR.space API...');
      const ocrText = await ocrPdf(buffer, lang);
      return res.json({
        success: true,
        pages: 1,
        text: ocrText,
        metadata: { ocrUsed: true, provider: 'ocr.space' }
      });
    }

    // 默认使用 PDF 原生文本提取
    const result = await pdfToTextLight(buffer, { splitPages });

    res.json({
      success: true,
      pages: result.pages,
      text: result.text,
      pageTexts: result.pageTexts,
      metadata: result.metadata
    });
  } catch (error) {
    console.error('Convert error:', error);
    res.status(500).json({ error: error.message });
  }
}