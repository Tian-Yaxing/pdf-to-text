import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const execFileAsync = promisify(execFile);

// 获取临时目录路径（支持环境变量配置）
function getTempDir(subdir = '') {
  const baseDir = process.env.TEMP_DIR || process.env.TMPDIR || os.tmpdir();
  return subdir ? path.join(baseDir, 'pdf-to-text', subdir) : path.join(baseDir, 'pdf-to-text');
}

// Tesseract worker 缓存
const tesseractWorkers = new Map();

async function getTesseractWorker(lang) {
  if (!tesseractWorkers.has(lang)) {
    console.log(`初始化 Tesseract Worker (${lang})...`);
    const primaryLang = lang.split('+')[0];
    const worker = await Tesseract.createWorker(primaryLang, 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log(`  OCR 进度: ${(m.progress * 100).toFixed(1)}%`);
        }
      }
    });
    tesseractWorkers.set(lang, worker);
  }
  return tesseractWorkers.get(lang);
}

/**
 * 将 PDF 文件转换为文本（支持文本型和扫描型 PDF）
 */
export async function pdfToText(input, options = {}) {
  const { ocr = false, autoDetect = true, splitPages = false, lang = 'chi_sim+eng' } = options;

  let dataBuffer;
  let filePath = null;

  if (typeof input === 'string') {
    const absolutePath = path.resolve(input);
    filePath = absolutePath;
    dataBuffer = await fs.readFile(absolutePath);
  } else if (Buffer.isBuffer(input)) {
    dataBuffer = input;
    if (ocr || autoDetect) {
      const tempDir = getTempDir();
      await fs.mkdir(tempDir, { recursive: true });
      filePath = path.join(tempDir, `temp_${Date.now()}.pdf`);
      await fs.writeFile(filePath, dataBuffer);
    }
  } else {
    throw new Error('输入必须是文件路径字符串或 Buffer');
  }

  let textResult = null;
  let needsOCR = ocr;
  let pageTexts = [];
  let pageTextItems = []; // 保存每页的文本项（含位置信息）

  if (!ocr && autoDetect) {
    try {
      // 使用 pagerender 逐页提取文本，同时保存位置信息
      const pageTextsArr = [];
      const pageItemsArr = [];
      const data = await pdf(dataBuffer, {
        pagerender: async function(pageData) {
          const textContent = await pageData.getTextContent();
          const text = textContent.items.map(item => item.str).join('');
          pageTextsArr.push(text);
          // 保存每个文本项及其位置信息
          pageItemsArr.push(textContent.items.map(item => ({
            str: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height
          })));
          return text;
        }
      });
      textResult = data;
      pageTexts = pageTextsArr;
      pageTextItems = pageItemsArr;

      const textContent = data.text || '';
      const textLength = textContent.trim().length;
      const avgCharsPerPage = textLength / data.numpages;

      if (avgCharsPerPage < 50) {
        needsOCR = true;
        console.log(`检测到可能的扫描版 PDF（每页平均 ${avgCharsPerPage.toFixed(1)} 字符），启用 OCR...`);
      }
    } catch (e) {
      needsOCR = true;
      console.log('PDF 解析失败，启用 OCR...');
    }
  } else if (!ocr) {
    // 使用 pagerender 逐页提取文本，同时保存位置信息
    const pageTextsArr = [];
    const pageItemsArr = [];
    const data = await pdf(dataBuffer, {
      pagerender: async function(pageData) {
        const textContent = await pageData.getTextContent();
        const text = textContent.items.map(item => item.str).join('');
        pageTextsArr.push(text);
        pageItemsArr.push(textContent.items.map(item => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height
        })));
        return text;
      }
    });
    textResult = data;
    pageTexts = pageTextsArr;
    pageTextItems = pageItemsArr;
  }

  if (needsOCR) {
    console.log('正在使用 OCR 识别图片型 PDF...');
    const actualFilePath = filePath || await saveBufferToTemp(dataBuffer);
    const ocrResult = await performOCR(actualFilePath, lang);

    if (typeof input !== 'string') {
      try {
        if (filePath) await fs.unlink(filePath);
      } catch (e) {}
    }

    const result = {
      text: ocrResult.text,
      pages: ocrResult.pages,
      pageTexts: ocrResult.pageTexts,
      metadata: {
        info: textResult?.info || {},
        version: textResult?.version || 'unknown',
        ocrUsed: true,
        ocrLang: lang
      }
    };

    if (!splitPages) {
      delete result.pageTexts;
    }

    return result;
  }

  const result = {
    text: textResult.text,
    pages: textResult.numpages,
    pageTexts: pageTexts, // 直接使用 pagerender 提取的逐页文本
    pageTextItems: pageTextItems, // 包含位置信息的文本项数组
    metadata: {
      info: textResult.info,
      version: textResult.version,
      ocrUsed: false
    }
  };

  if (!splitPages) {
    delete result.pageTexts;
    delete result.pageTextItems;
  }

  return result;
}

/**
 * 提取 PDF 指定区域的文本（按页输出）
 */
export async function pdfRegionToText(input, region = {}, options = {}) {
  const { position = 'top-right', custom = null } = region;
  const { lang = 'chi_sim+eng' } = options;

  let filePath;

  if (typeof input === 'string') {
    filePath = path.resolve(input);
  } else if (Buffer.isBuffer(input)) {
    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });
    filePath = path.join(tempDir, `region_${Date.now()}.pdf`);
    await fs.writeFile(filePath, input);
  } else {
    throw new Error('输入必须是文件路径字符串或 Buffer');
  }

  console.log(`正在提取 PDF 区域文本，位置: ${position}`);

  const result = await extractRegionFromPages(filePath, position, custom, lang);

  // 清理临时文件
  if (Buffer.isBuffer(input)) {
    try {
      await fs.unlink(filePath);
    } catch (e) {}
  }

  return result;
}

/**
 * 提取 PDF 多个区域的文本（按页输出）
 * @param {string|Buffer} input - PDF 文件路径或 Buffer
 * @param {Array} regions - 区域配置数组 [{position, custom}, ...]
 * @param {object} options - 选项 {lang}
 */
export async function pdfMultiRegionToText(input, regions = [], options = {}) {
  const { lang = 'chi_sim+eng' } = options;

  let filePath;

  if (typeof input === 'string') {
    filePath = path.resolve(input);
  } else if (Buffer.isBuffer(input)) {
    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });
    filePath = path.join(tempDir, `multi_region_${Date.now()}.pdf`);
    await fs.writeFile(filePath, input);
  } else {
    throw new Error('输入必须是文件路径字符串或 Buffer');
  }

  if (!regions || regions.length === 0) {
    regions = [{ position: 'top-right', custom: null }];
  }

  console.log(`正在提取 PDF 多区域文本，共 ${regions.length} 个区域`);

  const pdfInfo = await getPdfInfo(filePath);
  const totalPages = pdfInfo.pages;

  const worker = await getTesseractWorker(lang);
  const tempDir = getTempDir('ocr');
  await fs.mkdir(tempDir, { recursive: true });

  const pageResults = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`处理第 ${pageNum}/${totalPages} 页...`);

    const pageRegions = [];

    try {
      // 先转换整页为图片
      const outputPath = path.join(tempDir, `multi_page_${pageNum}`);
      await execFileAsync('pdftoppm', [
        '-png',
        '-r', '150',
        '-f', String(pageNum),
        '-l', String(pageNum),
        filePath,
        outputPath
      ]);

      let pageImagePath = `${outputPath}-${String(pageNum).padStart(2, '0')}.png`;
      try {
        await fs.access(pageImagePath);
      } catch {
        pageImagePath = `${outputPath}-${pageNum}.png`;
        try {
          await fs.access(pageImagePath);
        } catch {
          throw new Error('PDF 页面转换失败');
        }
      }

      const meta = await sharp(pageImagePath).metadata();
      const width = meta.width;
      const height = meta.height;

      // 提取每个区域
      for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
        const region = regions[regionIdx];
        const { position, custom } = region;

        const cropRegion = calculateCropRegion(position, custom, width, height);
        console.log(`  区域 ${regionIdx + 1}: ${position}, x=${cropRegion.left}, y=${cropRegion.top}`);

        const regionImagePath = path.join(tempDir, `multi_region_${pageNum}_${regionIdx}_${Date.now()}.png`);
        await sharp(pageImagePath)
          .extract(cropRegion)
          .toFile(regionImagePath);

        const ocrResult = await worker.recognize(regionImagePath);

        pageRegions.push({
          regionIndex: regionIdx,
          position: position,
          text: ocrResult.data.text?.trim() || '',
          region: {
            position,
            pixels: cropRegion,
            percent: custom || getPositionPercent(position)
          }
        });

        try {
          await fs.unlink(regionImagePath);
        } catch (e) {}
      }

      // 清理页面图片
      try {
        await fs.unlink(pageImagePath);
      } catch (e) {}

      pageResults.push({
        page: pageNum,
        regions: pageRegions
      });

    } catch (e) {
      console.error(`第 ${pageNum} 页处理失败: ${e.message}`);
      pageResults.push({
        page: pageNum,
        regions: regions.map((r, idx) => ({
          regionIndex: idx,
          position: r.position,
          text: '',
          error: e.message
        }))
      });
    }
  }

  // 清理临时文件
  if (Buffer.isBuffer(input)) {
    try {
      await fs.unlink(filePath);
    } catch (e) {}
  }

  return {
    pages: totalPages,
    regions: regions,
    pageResults: pageResults
  };
}

/**
 * 保存 Buffer 到临时文件
 */
async function saveBufferToTemp(buffer) {
  const tempDir = getTempDir();
  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `temp_${Date.now()}.pdf`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * 从 PDF 各页提取指定区域的文本（使用 pdftoppm）
 */
async function extractRegionFromPages(filePath, position, custom, lang) {
  const tempDir = getTempDir('ocr');
  await fs.mkdir(tempDir, { recursive: true });

  // 获取 PDF 页数
  const pdfInfo = await getPdfInfo(filePath);
  const totalPages = pdfInfo.pages;

  console.log(`PDF 共 ${totalPages} 页，开始区域提取...`);

  // 初始化 Tesseract worker
  const worker = await getTesseractWorker(lang);

  const pageResults = [];

  // 对于底部表格，使用更高分辨率
  const dpi = position === 'bottom-table' ? 300 : 150;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`处理第 ${pageNum}/${totalPages} 页...`);

    try {
      // 使用 pdftoppm 将 PDF 页面转为图片
      const outputPath = path.join(tempDir, `page_${pageNum}`);
      await execFileAsync('pdftoppm', [
        '-png',
        '-r', String(dpi),
        '-f', String(pageNum),
        '-l', String(pageNum),
        filePath,
        outputPath
      ]);

      // pdftoppm 生成的文件名格式: page_1-01.png 或 page_1-1.png
      let pageImagePath = `${outputPath}-${String(pageNum).padStart(2, '0')}.png`;

      // 检查文件是否存在，尝试不同格式
      try {
        await fs.access(pageImagePath);
      } catch {
        // 尝试另一种格式
        pageImagePath = `${outputPath}-${pageNum}.png`;
        try {
          await fs.access(pageImagePath);
        } catch {
          throw new Error('PDF 页面转换失败');
        }
      }

      // 获取图片尺寸
      const meta = await sharp(pageImagePath).metadata();
      const width = meta.width;
      const height = meta.height;

      // 计算裁剪区域
      const cropRegion = calculateCropRegion(position, custom, width, height);
      console.log(`  裁剪区域: x=${cropRegion.left}, y=${cropRegion.top}, w=${cropRegion.width}, h=${cropRegion.height}`);

      // 裁剪图片
      const regionImagePath = path.join(tempDir, `region_${pageNum}_${Date.now()}.png`);
      await sharp(pageImagePath)
        .extract(cropRegion)
        .toFile(regionImagePath);

      // OCR 识别
      const ocrResult = await worker.recognize(regionImagePath);

      pageResults.push({
        page: pageNum,
        text: ocrResult.data.text?.trim() || '',
        region: {
          position,
          pixels: cropRegion,
          percent: custom || getPositionPercent(position)
        }
      });

      // 清理临时图片
      try {
        await fs.unlink(pageImagePath);
        await fs.unlink(regionImagePath);
      } catch (e) {}

    } catch (e) {
      console.error(`第 ${pageNum} 页处理失败: ${e.message}`);
      pageResults.push({
        page: pageNum,
        text: '',
        error: e.message
      });
    }
  }

  return {
    pages: totalPages,
    position: position,
    pageResults: pageResults,
    summary: pageResults.map(p => `第${p.page}页: ${p.text}`).join('\n')
  };
}

/**
 * 获取 PDF 信息
 */
async function getPdfInfo(filePath) {
  const dataBuffer = await fs.readFile(filePath);
  const data = await pdf(dataBuffer);
  return {
    pages: data.numpages,
    info: data.info
  };
}

/**
 * 计算 OCR 裁剪区域
 * @param {string} position - 预设位置
 * @param {object} custom - 自定义区域
 * @param {number} imageWidth - 图片宽度
 * @param {number} imageHeight - 图片高度
 * @param {object} margin - 边距（跳过边缘标记）百分比
 */
function calculateCropRegion(position, custom, imageWidth, imageHeight, margin = { top: 3, bottom: 3, left: 3, right: 3 }) {
  // 计算有效区域（去掉边缘标记）
  const effectiveLeft = Math.round(imageWidth * (margin.left || 0) / 100);
  const effectiveTop = Math.round(imageHeight * (margin.top || 0) / 100);
  const effectiveRight = Math.round(imageWidth * (100 - (margin.right || 0)) / 100);
  const effectiveBottom = Math.round(imageHeight * (100 - (margin.bottom || 0)) / 100);

  const effectiveWidth = effectiveRight - effectiveLeft;
  const effectiveHeight = effectiveBottom - effectiveTop;

  if (custom) {
    return {
      left: effectiveLeft + Math.round(custom.x * effectiveWidth / 100),
      top: effectiveTop + Math.round(custom.y * effectiveHeight / 100),
      width: Math.round(custom.width * effectiveWidth / 100),
      height: Math.round(custom.height * effectiveHeight / 100)
    };
  }

  const defaultWidthPercent = 30;
  const defaultHeightPercent = 20;

  const regionWidth = Math.round(effectiveWidth * defaultWidthPercent / 100);
  const regionHeight = Math.round(effectiveHeight * defaultHeightPercent / 100);

  switch (position) {
    case 'top-right':
      return {
        left: effectiveRight - regionWidth,
        top: effectiveTop,
        width: regionWidth,
        height: regionHeight
      };
    case 'top-right-small':
      // 右上角小区域，仅提取图纸编号（英文项目号）
      // 定位到项目号区域：右侧15-25%，顶部5-8%（对应"21212-DD"位置）
      const smallWidth = Math.round(effectiveWidth * 10 / 100);
      const smallHeight = Math.round(effectiveHeight * 3 / 100);
      return {
        left: effectiveRight - Math.round(effectiveWidth * 25 / 100),
        top: effectiveTop + Math.round(effectiveHeight * 5 / 100),
        width: smallWidth,
        height: smallHeight
      };
    case 'top-left':
      return {
        left: effectiveLeft,
        top: effectiveTop,
        width: regionWidth,
        height: regionHeight
      };
    case 'bottom-right':
      return {
        left: effectiveRight - regionWidth,
        top: effectiveBottom - regionHeight,
        width: regionWidth,
        height: regionHeight
      };
    case 'bottom-left':
      return {
        left: effectiveLeft,
        top: effectiveBottom - regionHeight,
        width: regionWidth,
        height: regionHeight
      };
    case 'center':
      return {
        left: effectiveLeft + Math.round((effectiveWidth - regionWidth) / 2),
        top: effectiveTop + Math.round((effectiveHeight - regionHeight) / 2),
        width: regionWidth,
        height: regionHeight
      };
    case 'bottom-center':
      // 底部居中，宽度更大（70%），高度10%，紧贴底部，底部不截取边距
      const bottomMargin = { top: 3, bottom: 0, left: 3, right: 3 };
      const bcEffectiveLeft = Math.round(imageWidth * (bottomMargin.left || 0) / 100);
      const bcEffectiveTop = Math.round(imageHeight * (bottomMargin.top || 0) / 100);
      const bcEffectiveRight = Math.round(imageWidth * (100 - (bottomMargin.right || 0)) / 100);
      const bcEffectiveBottom = Math.round(imageHeight * (100 - (bottomMargin.bottom || 0)) / 100);
      const bcEffectiveWidth = bcEffectiveRight - bcEffectiveLeft;
      const bcEffectiveHeight = bcEffectiveBottom - bcEffectiveTop;

      const bottomCenterWidth = Math.round(bcEffectiveWidth * 70 / 100);
      const bottomCenterHeight = Math.round(bcEffectiveHeight * 10 / 100);
      return {
        left: bcEffectiveLeft + Math.round((bcEffectiveWidth - bottomCenterWidth) / 2),
        top: bcEffectiveBottom - bottomCenterHeight,
        width: bottomCenterWidth,
        height: bottomCenterHeight
      };
    case 'bottom-table':
      // 底部表格区域，提取完整表格区域（包含值行+表头行）
      const tableMargin = { top: 3, bottom: 0, left: 3, right: 3 };
      const tableEffectiveLeft = Math.round(imageWidth * (tableMargin.left || 0) / 100);
      const tableEffectiveTop = Math.round(imageHeight * (tableMargin.top || 0) / 100);
      const tableEffectiveRight = Math.round(imageWidth * (100 - (tableMargin.right || 0)) / 100);
      const tableEffectiveBottom = Math.round(imageHeight * (100 - (tableMargin.bottom || 0)) / 100);
      const tableEffectiveWidth = tableEffectiveRight - tableEffectiveLeft;
      const tableEffectiveHeight = tableEffectiveBottom - tableEffectiveTop;

      // 提取底部 12% 区域（包含表格）
      const tableWidth = Math.round(tableEffectiveWidth * 94 / 100);
      const tableHeight = Math.round(tableEffectiveHeight * 12 / 100);
      return {
        left: tableEffectiveLeft + Math.round((tableEffectiveWidth - tableWidth) / 2),
        top: tableEffectiveBottom - tableHeight,
        width: tableWidth,
        height: tableHeight
      };
    default:
      return {
        left: effectiveRight - regionWidth,
        top: effectiveTop,
        width: regionWidth,
        height: regionHeight
      };
  }
}

/**
 * 获取预设位置的百分比定义
 */
function getPositionPercent(position) {
  const defaults = { width: 30, height: 20 };

  switch (position) {
    case 'top-right':
      return { x: 70, y: 0, ...defaults };
    case 'top-left':
      return { x: 0, y: 0, ...defaults };
    case 'bottom-right':
      return { x: 70, y: 80, ...defaults };
    case 'bottom-left':
      return { x: 0, y: 80, ...defaults };
    case 'bottom-center':
      return { x: 15, y: 87, width: 70, height: 10 };
    case 'bottom-table':
      // 底部表格区域，提取完整表格区域
      return { x: 3, y: 88, width: 94, height: 12 };
    case 'center':
      return { x: 35, y: 40, ...defaults };
    default:
      return { x: 70, y: 0, ...defaults };
  }
}

/**
 * 解析表格文本为键值对（基于位置信息提取）
 * 使用PDF文本项的x/y坐标定位各字段值
 * 当有多行数据时，只取最下面一行
 * @param {Array} textItems - PDF提取的文本项数组（含位置信息）
 * @returns {Array} - [{key: '管线号', value: '71-25-N7-UC4421-1A1N-N'}, ...]
 */
function parseTableText(textItems) {
  if (!textItems || textItems.length === 0) return [];

  // 先找出所有包含管线号的行（多行数据情况）
  const pipelineMatches = [];
  for (const item of textItems) {
    // 管线号格式：70-25-BS-47001-1A1B-C50 或类似
    if (item.str.match(/^70-\d+-[A-Z]+-\d+-[A-Z0-9]+-[A-Z0-9]+$/)) {
      pipelineMatches.push({ y: item.y, item });
    }
  }

  if (pipelineMatches.length === 0) return [];

  // 取最下面一行（y值最小的，PDF坐标y从上到下递减）
  const lowestMatch = pipelineMatches.reduce((min, curr) =>
    curr.y < min.y ? curr : min
  , pipelineMatches[0]);

  const dataLineY = lowestMatch.y;

  // 字段配置：基于实际表格布局，使用相对位置定位
  // 表格从左到右：尺寸、管线号、材料等级、管道级别、设计温度、操作温度、设计压力、操作压力、保温类型、保温厚度、刷漆
  const fieldConfigs = {
    '尺寸': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 80, maxX: 200 },
    '管线号': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 250, maxX: 450, pattern: /^70-\d+-[A-Z]+-\d+-[A-Z0-9]+-[A-Z0-9]+$/ },
    '材料等级': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 480, maxX: 520 },
    '管道级别': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 560, maxX: 600 },
    '设计温度': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 640, maxX: 700 },
    '操作温度': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 720, maxX: 780 },
    '设计压力': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 800, maxX: 860 },
    '操作压力': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 880, maxX: 940 },
    '保温类型': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 960, maxX: 1020 },
    '保温厚度': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 1040, maxX: 1100 },
    '刷漆': { minY: dataLineY - 5, maxY: dataLineY + 5, minX: 1120, maxX: 1200 },
    // 顶部区域字段（比例和图号）
    '比例': { minY: 28, maxY: 35, minX: 1200, maxX: 1260, excludePatterns: ['SCALE', '比例', 'N/A'] },
    '图号': { minY: 28, maxY: 35, minX: 1265, maxX: 1350, excludePatterns: ['DWG', '图号', 'N/A'] },
    // 右上角项目号区域
    '项目号': { minY: 90, maxY: 96, minX: 1580, maxX: 1610 }
  };

  const result = [];
  const fields = ['尺寸', '管线号', '材料等级', '管道级别', '设计温度', '操作温度',
                  '设计压力', '操作压力', '保温类型', '保温厚度', '刷漆', '比例', '图号', '项目号'];

  // 按字段提取值
  for (const field of fields) {
    const config = fieldConfigs[field];
    let value = '';

    // 找出符合位置条件的文本项
    const matchingItems = textItems.filter(item => {
      const yMatch = item.y >= config.minY && item.y <= config.maxY;
      const xMatch = item.x >= config.minX && item.x <= config.maxX;
      return yMatch && xMatch && item.str.trim().length > 0;
    });

    if (matchingItems.length > 0) {
      // 如果有pattern要求，优先匹配pattern
      if (config.pattern) {
        const patternMatch = matchingItems.find(item => item.str.match(config.pattern));
        if (patternMatch) {
          value = patternMatch.str.trim();
        } else {
          value = matchingItems[0].str.trim();
        }
      } else if (config.excludePatterns) {
        // 过滤掉排除模式（表头文本等）
        const filteredItems = matchingItems.filter(item =>
          !config.excludePatterns.some(pattern => item.str.includes(pattern))
        );
        if (filteredItems.length > 0) {
          // 对于图号，可能需要拼接多个文本项
          value = filteredItems.map(item => item.str.trim()).join('');
        }
      } else {
        // 取第一个匹配项作为值
        value = matchingItems[0].str.trim();
      }
    }

    // 过滤掉表头文本
    if (fields.includes(value)) {
      value = '';
    }

    result.push({
      key: field,
      value: value
    });
  }

  return result;
}

/**
 * 使用 OCR 处理扫描版 PDF（全页识别）
 */
async function performOCR(filePath, lang = 'chi_sim+eng') {
  const pdfInfo = await getPdfInfo(filePath);
  const totalPages = pdfInfo.pages;

  console.log(`PDF 共 ${totalPages} 页，开始 OCR 识别...`);

  const worker = await getTesseractWorker(lang);
  const tempDir = getTempDir('ocr');
  await fs.mkdir(tempDir, { recursive: true });

  const pageTexts = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`正在处理第 ${pageNum}/${totalPages} 页...`);

    try {
      const outputPath = path.join(tempDir, `fullpage_${pageNum}`);
      await execFileAsync('pdftoppm', [
        '-png',
        '-r', '150',
        '-f', String(pageNum),
        '-l', String(pageNum),
        filePath,
        outputPath
      ]);

      const pageImagePath = `${outputPath}-1.png`;

      const result = await worker.recognize(pageImagePath);
      pageTexts.push(result.data.text || '');

      // 清理
      try {
        await fs.unlink(pageImagePath);
      } catch (e) {}

    } catch (e) {
      console.error(`第 ${pageNum} 页处理失败: ${e.message}`);
      pageTexts.push('');
    }
  }

  return {
    text: pageTexts.join('\n\n'),
    pages: totalPages,
    pageTexts: pageTexts
  };
}

/**
 * 简单按页分割文本
 */
function splitTextByPages(text, totalPages) {
  const lines = text.split('\n');
  const linesPerPage = Math.ceil(lines.length / totalPages);
  const pages = [];

  for (let i = 0; i < totalPages; i++) {
    const start = i * linesPerPage;
    const end = start + linesPerPage;
    pages.push(lines.slice(start, end).join('\n'));
  }

  return pages;
}

export default pdfToText;

// 导出表格解析函数
export { parseTableText };