// UNM Accessibility Audit Engine — Vercel Serverless Function
// Mirrors the Python audit_engine.py logic for PDF, DOCX, and PPTX files
// Libraries used: pdf-parse (PDF). DOCX/PPTX arrive pre-extracted from the
// browser (JSZip runs client-side) so this function never sees embedded
// images/video/audio — only the small XML text it actually needs.

const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

// ── Bad link text patterns ──
const BAD_LINK = /^(click here|here|read more|more|link|this|download|view|see more|learn more|this link|click|url|www\.|http)$/i;
const isBadLink = t => BAD_LINK.test(t.trim()) || t.trim().length < 3;

// ── WCAG contrast ratio ──
function relativeLuminance(r, g, b) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(...rgb1), l2 = relativeLuminance(...rgb2);
  const light = Math.max(l1, l2), dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length !== 6) return null;
  return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
}
function passesContrastAA(fg, bg, large = false) {
  return contrastRatio(fg, bg) >= (large ? 3.0 : 4.5);
}

// ── Result builder ──
function makeResult(fileName, fileType) {
  const issues = [], passed = [];
  return {
    fileName, fileType, issues, passed,
    addIssue(severity, rule, description, location, howToFix, wcagRef = '') {
      issues.push({ severity, rule, description, location, howToFix, wcagRef });
    },
    addPass(check) { passed.push(check); },
    summary() {
      const criticals = issues.filter(i => i.severity === 'critical');
      const majors    = issues.filter(i => i.severity === 'major');
      const minors    = issues.filter(i => i.severity === 'minor');
      return {
        fileName, fileType,
        critical: criticals.length, major: majors.length, minor: minors.length,
        total: issues.length, passed: passed.length,
        issues: [...issues].sort((a,b) => ({critical:0,major:1,minor:2}[a.severity] - ({critical:0,major:1,minor:2}[b.severity]))),
      };
    }
  };
}

// ─────────────────────────────────────────────
// PDF Auditor
// ─────────────────────────────────────────────
async function auditPDF(buffer, fileName) {
  const result = makeResult(fileName, 'pdf');
  let data;

  try {
    data = await pdfParse(buffer);
  } catch(e) {
    result.addIssue('critical','unreadable-file',`Could not open PDF: ${e.message}`,'file',
      'Ensure the PDF is not corrupted or password-protected.','WCAG 1.1.1');
    return result;
  }

  const text = data.text || '';
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const pageCount = data.numpages || 1;
  const wordsPerPage = wordCount / pageCount;

  if (wordsPerPage < 10) {
    result.addIssue('critical','scanned-image-pages',
      `This PDF appears to be a scanned image — little to no extractable text found (avg ${Math.round(wordsPerPage)} words/page).`,
      'entire document',
      'Replace with a text-based PDF. If you only have a scan, use Acrobat Pro: Tools → Scan & OCR → Recognize Text.',
      'WCAG 1.4.5');
  } else {
    result.addPass(`Text is extractable (avg ${Math.round(wordsPerPage)} words/page)`);
  }

  const info = data.info || {};
  if (!info.Title || !info.Title.trim()) {
    result.addIssue('major','missing-title-metadata','PDF has no Title in document properties.','document metadata',
      'In Word before exporting: File → Info → Properties → Title. In Acrobat: File → Properties → Description → Title.',
      'WCAG 2.4.2');
  } else {
    result.addPass(`Document title set: "${info.Title}"`);
  }

  if (!info.Language && !info.Lang) {
    result.addIssue('major','missing-language','PDF language is not set — screen readers may mispronounce content.','document metadata',
      'In Acrobat: File → Properties → Advanced → Reading Options → Language. Set to "en-US".',
      'WCAG 3.1.1');
  } else {
    result.addPass('Document language is set');
  }

  const clickHereMatches = (text.match(/click here|read more|learn more/gi) || []).length;
  if (clickHereMatches > 0) {
    result.addIssue('major','non-descriptive-link-text',
      `Found ${clickHereMatches} instance(s) of non-descriptive link text ("click here", "read more", etc.).`,
      'document body',
      'Replace vague link text with descriptive text explaining the destination, e.g. "UNM Disability Services website".',
      'WCAG 2.4.4');
  } else {
    result.addPass('No obvious non-descriptive link text found');
  }

  const lines = text.split('\n').filter(l => l.trim());
  const shortUpperLines = lines.filter(l => l.trim().length < 60 && l.trim() === l.trim().toUpperCase() && l.trim().length > 3);
  if (shortUpperLines.length === 0) {
    result.addIssue('minor','verify-heading-structure',
      'No obvious heading structure detected. Verify the PDF has tagged headings.',
      'entire document',
      'In Acrobat Pro: Tools → Accessibility → Full Check. Ensure heading tags (H1, H2 etc.) are applied.',
      'WCAG 1.3.1');
  } else {
    result.addPass('Document appears to have heading-like structure');
  }

  result.addIssue('minor','verify-reading-order',
    'Reading order and tab order cannot be fully verified programmatically — manual check recommended.',
    'entire document',
    'In Acrobat Pro: Tools → Accessibility → Reading Order → verify the numbered order matches the visual layout. Also run Full Check.',
    'WCAG 1.3.2');

  result.addPass(`Document has ${pageCount} page(s) — text extraction successful`);

  return result;
}

// ─────────────────────────────────────────────
// DOCX Auditor
// ─────────────────────────────────────────────
async function auditDOCX(extracted, fileName) {
  const result = makeResult(fileName, 'docx');

  if (!extracted || !extracted.documentXml) {
    result.addIssue('critical','unreadable-file','Could not read Word document content.','file',
      'Ensure the file is a valid .docx file.','WCAG 1.1.1');
    return result;
  }

  const docXmlRaw   = extracted.documentXml || '';
  const stylesXml   = extracted.stylesXml   || '';
  const settingsXml = extracted.settingsXml || '';
  const coreXml     = extracted.coreXml     || '';

  const titleMatch = coreXml.match(/<dc:title>([^<]+)<\/dc:title>/);
  if (!titleMatch || !titleMatch[1].trim()) {
    result.addIssue('major','missing-title-metadata','Document Title property is not set.','document properties',
      'File → Info → Properties → Title → enter a descriptive document title.','WCAG 2.4.2');
  } else {
    result.addPass(`Document title set: "${titleMatch[1]}"`);
  }

  const langInSettings = settingsXml.includes('w:lang') || stylesXml.includes('w:lang');
  if (!langInSettings) {
    result.addIssue('minor','missing-language','Document language may not be explicitly set.',
      'document settings','File → Options → Language → set Editing Language to English (United States).','WCAG 3.1.1');
  } else {
    result.addPass('Document language is set');
  }

  const headingRefs = (docXmlRaw.match(/<w:pStyle w:val="Heading\d"/g) || []);

  if (headingRefs.length === 0) {
    result.addIssue('major','no-heading-structure',
      'Document uses no Heading styles — screen readers cannot navigate by section.',
      'entire document',
      'Use Word\'s built-in Heading 1, Heading 2 styles (Home tab → Styles). Never simulate headings with bold/large text.',
      'WCAG 1.3.1');
  } else {
    const levels = headingRefs.map(m => parseInt(m.match(/Heading(\d)/)[1])).sort((a,b)=>a-b);
    const skipped = [];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i-1] > 1) skipped.push(`H${levels[i-1]}→H${levels[i]}`);
    }
    if (skipped.length > 0) {
      result.addIssue('major','skipped-heading-levels',
        `Heading levels are skipped: ${skipped.join(', ')}. Screen readers announce skips as navigation errors.`,
        'multiple sections',
        'Ensure headings follow a logical hierarchy: H1 → H2 → H3. Never skip a level.',
        'WCAG 1.3.1');
    } else {
      result.addPass(`Heading structure is logical (${headingRefs.length} headings found)`);
    }
  }

  const imageRels = extracted.mediaFiles || [];
  const docPrMatches = docXmlRaw.match(/<wp:docPr[^>]*>/g) || [];
  const missingAlt = docPrMatches.filter(m => !m.includes('descr=') || m.match(/descr=""/));

  if (imageRels.length > 0) {
    if (missingAlt.length > 0) {
      result.addIssue('critical','missing-alt-text',
        `${missingAlt.length} image(s) may be missing alternative text.`,
        'multiple locations',
        'Right-click each image → Edit Alt Text → describe what the image shows. For decorative images, check "Mark as decorative".',
        'WCAG 1.1.1');
    } else {
      result.addPass(`All ${imageRels.length} image(s) appear to have alt text`);
    }
  } else {
    result.addPass('No images detected requiring alt text');
  }

  const tableCount = (docXmlRaw.match(/<w:tbl>/g) || []).length;
  const headerRowCount = (docXmlRaw.match(/<w:tblHeader\/>/g) || []).length;
  if (tableCount > 0) {
    const missing = tableCount - headerRowCount;
    if (missing > 0) {
      result.addIssue('major','table-missing-header-row',
        `${missing} of ${tableCount} table(s) have no designated header row.`,
        'tables in document',
        'Select the top row of each table → Table Design tab → check "Header Row". Also right-click → Table Properties → Row → check "Repeat as header row at the top of each page".',
        'WCAG 1.3.1');
    } else {
      result.addPass(`All ${tableCount} table(s) have header rows`);
    }
  }

  const hyperlinkTexts = [];
  const hlRegex = /<w:hyperlink[^>]*>([\s\S]*?)<\/w:hyperlink>/g;
  let hlMatch;
  while ((hlMatch = hlRegex.exec(docXmlRaw)) !== null) {
    const textInLink = (hlMatch[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
      .map(t => t.replace(/<[^>]+>/g, '')).join('');
    if (isBadLink(textInLink)) hyperlinkTexts.push(textInLink || '(empty)');
  }
  if (hyperlinkTexts.length > 0) {
    result.addIssue('major','non-descriptive-link-text',
      `${hyperlinkTexts.length} hyperlink(s) have non-descriptive text: "${hyperlinkTexts.slice(0,3).join('", "')}"${hyperlinkTexts.length > 3 ? '...' : ''}`,
      'multiple paragraphs',
      'Replace vague link text like "click here" with descriptive text that explains the destination, e.g. "UNM Disability Services website".',
      'WCAG 2.4.4');
  } else {
    result.addPass('All hyperlinks use descriptive text');
  }

  const coloredRuns = (docXmlRaw.match(/<w:color w:val="(?!auto|000000|FFFFFF)[A-Fa-f0-9]{6}"\/>/g) || []).length;
  if (coloredRuns > 8) {
    result.addIssue('minor','color-only-formatting',
      `Document uses colored text in ${coloredRuns} places — verify color is not the only way meaning is conveyed.`,
      'multiple paragraphs',
      'Never rely on color alone to convey information. Pair color with bold, underline, or a text label.',
      'WCAG 1.4.1');
  } else {
    result.addPass('Color use appears supplementary to other formatting');
  }

  const blankParas = (docXmlRaw.match(/<w:p><\/w:p>|<w:p\/>/g) || []).length +
                     (docXmlRaw.match(/<w:p><w:pPr><w:pStyle w:val="Normal"\/><\/w:pPr><\/w:p>/g) || []).length;
  if (blankParas > 8) {
    result.addIssue('minor','blank-paragraphs-for-spacing',
      `${blankParas} blank paragraphs detected — these create screen reader noise.`,
      'throughout document',
      'Remove blank paragraphs. Use paragraph spacing instead: Home → Paragraph → Spacing Before/After.',
      'WCAG 1.3.1');
  } else {
    result.addPass('No excessive blank paragraph spacing detected');
  }

  return result;
}

// ─────────────────────────────────────────────
// PPTX Auditor
// ─────────────────────────────────────────────
async function auditPPTX(extracted, fileName) {
  const result = makeResult(fileName, 'pptx');

  if (!extracted || !Array.isArray(extracted.slides)) {
    result.addIssue('critical','unreadable-file','Could not read PowerPoint content.','file',
      'Ensure the file is a valid .pptx file.','WCAG 1.1.1');
    return result;
  }

  const slideFiles = extracted.slides; // [{ num, xml, notesXml }, ...], already sorted by slide number

  const totalSlides = slideFiles.length;
  if (totalSlides === 0) {
    result.addIssue('critical','no-slides-found','No slides found in this file.','file',
      'Ensure the file is a valid .pptx file.','');
    return result;
  }

  result.addPass(`Presentation has ${totalSlides} slide(s)`);

  const slidesMissingTitles  = [];
  const slidesDuplicateTitles= [];
  const shapesMissingAlt     = [];
  const slidesNeedingNotes   = [];
  const contrastIssues       = [];
  const badLinks             = [];
  const animatedSlides       = [];
  const mediaSlides          = [];
  const titlesSeen           = {};

  for (let i = 0; i < slideFiles.length; i++) {
    const slideNum = slideFiles[i].num;
    const slideXml = slideFiles[i].xml || '';

    const titlePlaceholders = slideXml.match(/<p:ph[^>]*type="(?:title|ctrTitle)"[^>]*\/?>/g) || [];
    let titleText = '';
    if (titlePlaceholders.length > 0) {
      const spBlocks = slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
      for (const sp of spBlocks) {
        if (sp.includes('type="title"') || sp.includes('type="ctrTitle"')) {
          const texts = sp.match(/<a:t>([^<]*)<\/a:t>/g) || [];
          titleText = texts.map(t => t.replace(/<[^>]+>/g,'')).join(' ').trim();
          break;
        }
      }
    }

    if (!titleText) {
      slidesMissingTitles.push(slideNum);
    } else {
      const tLower = titleText.toLowerCase();
      if (titlesSeen[tLower]) {
        slidesDuplicateTitles.push(slideNum);
      }
      titlesSeen[tLower] = true;
    }

    const picBlocks = slideXml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || [];

    for (const pic of picBlocks) {
      const cNvPr = pic.match(/<p:cNvPr[^>]*>/);
      if (cNvPr) {
        const hasDescr = cNvPr[0].includes('descr="') && !cNvPr[0].includes('descr=""');
        const isDecorative = pic.includes('isDecorative="1"');
        if (!hasDescr && !isDecorative) {
          const nameMatch = cNvPr[0].match(/name="([^"]+)"/);
          shapesMissingAlt.push(`Slide ${slideNum}: "${nameMatch ? nameMatch[1] : 'image'}"`);
        }
      }
    }

    const hasNotes = !!slideFiles[i].notesXml;
    if (hasNotes) {
      const notesXml = slideFiles[i].notesXml || '';
      const notesText = (notesXml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
        .map(t=>t.replace(/<[^>]+>/g,'')).join(' ').trim();
      const shapeCount = (slideXml.match(/<p:sp>/g) || []).length;
      if (shapeCount > 3 && notesText.length < 10) {
        slidesNeedingNotes.push(slideNum);
      }
    } else {
      const shapeCount = (slideXml.match(/<p:sp>/g) || []).length;
      if (shapeCount > 3) slidesNeedingNotes.push(slideNum);
    }

    const runMatches = slideXml.match(/<a:r>[\s\S]*?<\/a:r>/g) || [];
    for (const run of runMatches) {
      const textMatch = run.match(/<a:t>([^<]+)<\/a:t>/);
      if (!textMatch || !textMatch[1].trim()) continue;
      const solidFill = run.match(/<a:solidFill>[\s\S]*?<a:srgbClr val="([A-Fa-f0-9]{6})"[\s\S]*?<\/a:solidFill>/);
      if (solidFill) {
        const fg = hexToRgb(solidFill[1]);
        const bg = [255, 255, 255];
        if (fg && !passesContrastAA(fg, bg)) {
          const ratio = Math.round(contrastRatio(fg, bg) * 10) / 10;
          contrastIssues.push(`Slide ${slideNum}: "${textMatch[1].slice(0,30)}" — ratio ${ratio}:1`);
        }
      }
    }

    if (slideXml.includes('<p:timing>') && slideXml.includes('<p:seq>')) {
      animatedSlides.push(slideNum);
    }

    const rBlocks = slideXml.match(/<a:r>[\s\S]*?<\/a:r>/g) || [];
    for (const r of rBlocks) {
      if (r.includes('hlinkClick') || r.includes('r:id')) {
        const t = (r.match(/<a:t>([^<]*)<\/a:t>/) || [])[1] || '';
        if (isBadLink(t)) badLinks.push(`Slide ${slideNum}: "${t}"`);
      }
    }

    if (slideXml.includes('<p:video>') || slideXml.includes('<p:audio>') || slideXml.includes('audio/') || slideXml.includes('video/')) {
      mediaSlides.push(slideNum);
    }
  }

  if (slidesMissingTitles.length > 0) {
    result.addIssue('critical','slides-missing-titles',
      `${slidesMissingTitles.length} slide(s) have no title: slides ${slidesMissingTitles.slice(0,10).join(', ')}${slidesMissingTitles.length > 10 ? '...' : ''}`,
      `slides ${slidesMissingTitles.join(', ')}`,
      'Every slide needs a unique title for screen reader navigation. Click the title placeholder and add text. For visually hidden titles, use View → Outline View.',
      'WCAG 2.4.2');
  } else {
    result.addPass(`All ${totalSlides} slides have titles`);
  }

  if (slidesDuplicateTitles.length > 0) {
    result.addIssue('minor','duplicate-slide-titles',
      `${slidesDuplicateTitles.length} slide(s) share duplicate titles — screen reader users cannot distinguish them.`,
      `slides ${slidesDuplicateTitles.join(', ')}`,
      'Give each slide a unique, descriptive title.','WCAG 2.4.6');
  }

  if (shapesMissingAlt.length > 0) {
    result.addIssue('critical','missing-alt-text',
      `${shapesMissingAlt.length} image(s) are missing alt text: ${shapesMissingAlt.slice(0,3).join('; ')}${shapesMissingAlt.length > 3 ? '...' : ''}`,
      'multiple slides',
      'Right-click each image → Edit Alt Text → describe what the image shows. For decorative images, check "Mark as decorative".',
      'WCAG 1.1.1');
  } else {
    result.addPass('All images appear to have alt text');
  }

  if (slidesNeedingNotes.length > 0) {
    result.addIssue('minor','complex-slides-lack-notes',
      `${slidesNeedingNotes.length} content-heavy slide(s) have no speaker notes: slides ${slidesNeedingNotes.slice(0,10).join(', ')}`,
      `slides ${slidesNeedingNotes.join(', ')}`,
      'Add speaker notes (View → Notes) to slides with charts, images, or complex layouts to provide additional context.',
      'WCAG 1.1.1');
  } else {
    result.addPass('Content slides include speaker notes');
  }

  if (contrastIssues.length > 0) {
    result.addIssue('major','insufficient-color-contrast',
      `${contrastIssues.length} text run(s) may fail WCAG contrast (need 4.5:1): ${contrastIssues.slice(0,2).join('; ')}${contrastIssues.length > 2 ? '...' : ''}`,
      'multiple slides',
      'Select the text → Home → Font Color → choose a darker color. Use WebAIM Contrast Checker (webaim.org/resources/contrastchecker/) to verify.',
      'WCAG 1.4.3');
  } else {
    result.addPass('Text contrast appears to meet WCAG AA requirements');
  }

  if (animatedSlides.length > 0) {
    result.addIssue('minor','animations-present',
      `${animatedSlides.length} slide(s) use animations — ensure animated content is accessible if animations are disabled.`,
      `slides ${animatedSlides.slice(0,10).join(', ')}`,
      'Avoid using animations to reveal essential content. All content should be readable with animations turned off.',
      'WCAG 2.2.2');
  }

  if (badLinks.length > 0) {
    result.addIssue('major','non-descriptive-link-text',
      `${badLinks.length} hyperlink(s) have non-descriptive text: ${badLinks.slice(0,3).join('; ')}`,
      'multiple slides',
      'Select the link → Insert → Link → change Display Text to describe the destination.',
      'WCAG 2.4.4');
  } else {
    result.addPass('All hyperlinks use descriptive text');
  }

  if (mediaSlides.length > 0) {
    result.addIssue('critical','embedded-media-needs-captions',
      `${mediaSlides.length} slide(s) contain embedded media — verify captions are provided.`,
      `slides ${mediaSlides.join(', ')}`,
      'Embedded videos must have accurate closed captions. Auto-generated captions require human review. Provide a transcript for audio.',
      'WCAG 1.2.2');
  }

  result.addIssue('major','verify-reading-order',
    'Reading order must be manually verified for slides with multiple overlapping shapes.',
    'all slides',
    'In PowerPoint: Home → Arrange → Selection Pane. Items are read BOTTOM to TOP. Drag to set correct order (title first, then content).',
    'WCAG 1.3.2');

  return result;
}

// ─────────────────────────────────────────────
// Vercel serverless handler
// (req.body is auto-parsed JSON by Vercel when Content-Type: application/json)
//
// DOCX/PPTX: browser sends pre-extracted XML text (via `extracted`), not the
// raw file — this keeps the request body tiny regardless of embedded media.
// PDF: browser still sends the raw base64 file (via `fileData`), since text
// extraction there requires the actual PDF bytes.
// ─────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { fileName, fileType, fileData, extracted } = req.body || {};

    if (!fileName || !fileType) {
      res.status(400).json({ error: 'Missing file data' });
      return;
    }

    let result;

    if (fileType === 'pdf') {
      if (!fileData) { res.status(400).json({ error: 'Missing file data' }); return; }
      const buffer = Buffer.from(fileData, 'base64');
      result = await auditPDF(buffer, fileName);
    } else if (fileType === 'docx') {
      if (!extracted) { res.status(400).json({ error: 'Missing extracted content' }); return; }
      result = await auditDOCX(extracted, fileName);
    } else if (fileType === 'pptx') {
      if (!extracted) { res.status(400).json({ error: 'Missing extracted content' }); return; }
      result = await auditPPTX(extracted, fileName);
    } else {
      res.status(400).json({ error: `Unsupported file type: ${fileType}` });
      return;
    }

    res.status(200).json(result.summary());

  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: err.message });
  }
};
