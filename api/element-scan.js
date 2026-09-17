// api/element-scan.js
// Checks Syllabus / Course Map / Schedule against the 9 UNM Online Learning
// Excellence Framework elements that live in those documents (not Canvas).

const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const ELEMENT_RUBRIC = `You are reviewing UNM course documents (Syllabus, Course Map, and/or Course Schedule) against 9 elements of UNM's Online Learning Excellence Framework. For EACH element below, read the document text provided and decide:

- "fulfilled" — the document text clearly addresses this element
- "not_fulfilled" — the relevant document is present but does not address this element
- "not_verifiable" — this element also depends on Canvas-only content (Orientation Module, Home Page, Discussion Boards, Module pages, Announcements) not present in these documents, so no fair verdict can be given from text alone

ELEMENT 1 - Expanded Course Description: An expanded course description explains how the course contributes to students' education, fits their major/curriculum, or is relevant to their lives — not just a catalog blurb of topics covered.

ELEMENT 2 - Course Alignment: Student learning outcomes (CLOs) are clearly stated and their relationship to materials and assessments is communicated (commonly shown via a Course Map).

ELEMENT 3 - Assignment Criteria & Evaluation Guidelines: The syllabus provides an overview of major assignment categories and their evaluation criteria.

ELEMENT 4 - Scaffolding: The syllabus explains how coursework throughout the semester builds toward the final project/major assessment.

ELEMENT 5 - Practice and Application: The syllabus indicates students have consistent, recurring opportunities to apply what they're learning (not a one-time final only).

ELEMENT 13 - Instructor-Student Interactions: The syllabus states how/when students can reach the instructor (e.g. office hours, drop-in hours, response-time policy).

ELEMENT 15 - Student Support Services and Resources: The syllabus includes links/explanations of academic and non-academic support resources (advising, disability services, tutoring, counseling, tech support, etc.).

ELEMENT 18 - Required Course Information: The syllabus includes essential course information (grading policy, required materials, technology requirements, course policies).

ELEMENT THIRD-PARTY-TOOLS - Use of Third-Party Tools: If the course requires tools outside UNM's licensed platforms (e.g. Pearson, MyLab), the syllabus explains privacy/accessibility/support safeguards or an opt-out option. If no third-party tool is mentioned, mark "not_verifiable" rather than penalizing its absence.

Return ONLY a JSON array, one object per element, in this exact shape:
[{"element": "1 - Expanded Course Description", "status": "fulfilled|not_fulfilled|not_verifiable", "evidence": "short quote or paraphrase, or 'none found'", "recommendation": "what to add/fix, or 'none needed' if fulfilled"}, ...]
No text outside the JSON array.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { syllabus, courseMap, schedule } = req.body || {};

    if (!syllabus && !courseMap && !schedule) {
      res.status(400).json({ error: 'No documents provided' });
      return;
    }

        const extractText = async (doc) => {
      if (!doc || !doc.fileData) return null;
      const buffer = Buffer.from(doc.fileData, 'base64');
      if (doc.fileType === 'pdf') {
        const data = await pdfParse(buffer);
        return data.text || '';
      }
      const { value } = await mammoth.extractRawText({ buffer });
      return value;
    };

    const [syllabusText, mapText, scheduleText] = await Promise.all([
      extractText(syllabus), extractText(courseMap), extractText(schedule)
    ]);

    const docSection = `
SYLLABUS:
${syllabusText || '(not provided)'}

COURSE MAP:
${mapText || '(not provided)'}

COURSE SCHEDULE:
${scheduleText || '(not provided)'}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'element fix 1.1 ',   // match the model string the notes-cleaner uses
        max_tokens: 2000,
        messages: [{ role: 'user', content: ELEMENT_RUBRIC + '\n\n' + docSection }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text || '[]';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const elementResults = JSON.parse(cleaned);

    res.status(200).json({ elements: elementResults });

  } catch (err) {
    console.error('Element scan error:', err);
    res.status(500).json({ error: err.message });
  }
};
