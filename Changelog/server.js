require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');

// Corporate SSL inspection proxies present a self-signed cert in the chain.
// Both Jira (axios) and Anthropic SDK calls need SSL verification disabled.
// The Anthropic SDK accepts a custom fetch — we pass one backed by undici with
// rejectUnauthorized:false so it traverses the corporate proxy. Safe for local dev.
const { fetch: undiciFetch, Agent: UndiciAgent } = require('undici');
const insecureDispatcher = new UndiciAgent({ connect: { rejectUnauthorized: false } });
const insecureFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: insecureDispatcher });

const OpenAI = require('openai');
const jiraHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Validate required env vars on startup
const REQUIRED_VARS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OPENROUTER_API_KEY'];
const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

const JIRA_BASE_URL = process.env.JIRA_BASE_URL.replace(/\/$/, '');
const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const jiraHeaders = {
  Authorization: `Basic ${jiraAuth}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  fetch: insecureFetch,
});

// Cache the Changelog field metadata so we only look it up once
let changelogField = null;

async function getChangelogField() {
  if (changelogField) return changelogField;

  const { data } = await axios.get(`${JIRA_BASE_URL}/rest/api/3/field`, { headers: jiraHeaders, httpsAgent: jiraHttpsAgent });
  const field = data.find(f => f.name === 'Changelog');
  if (!field) throw new Error('No custom field named "Changelog" found in this Jira instance.');

  // Textarea-type custom fields require ADF format in Jira Cloud API v3.
  // Single-line textfield custom fields accept plain strings.
  const customType = field.schema?.custom || '';
  const isAdf = customType.includes('textarea') || customType.includes('paragraph');

  changelogField = { id: field.id, isAdf };
  return changelogField;
}

// --- ADF (Atlassian Document Format) helpers ---

function adfToText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;

  function walk(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return '\n';
    // inlineCard embeds a Jira issue link — extract the issue key from the URL
    // e.g. https://lansweeper.atlassian.net/browse/LAN-18137#icft=LAN-18137
    if (node.type === 'inlineCard') {
      const url = node.attrs?.url || '';
      const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
      return match ? match[1] : '';
    }
    const children = (node.content || []).map(walk).join('');
    if (node.type === 'paragraph') return children + '\n';
    if (node.type === 'listItem') return '* ' + children;
    return children;
  }

  return walk(value).trim();
}

function textToAdf(text) {
  const lines = (text || '').split('\n').filter(l => l.trim() !== '');
  const content = lines.length > 0
    ? lines.map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
    : [{ type: 'paragraph', content: [] }];
  return { version: 1, type: 'doc', content };
}

// --- System prompt: changelog rewriting rules ---

const SYSTEM_PROMPT = `You are helping write and polish changelog items for software releases. You will receive raw changelog entries plus optional context. You will rewrite each item into a clean, concise, customer-facing release note line.

Audience: IT admins and technically literate users, plus internal stakeholders.
Tone: Professional, clear, neutral, and concise (no marketing fluff).

FORMATTING & STRUCTURE
- Default language: English.
- Default format: Markdown (no special formatting in the actual changelog line).
- Each item always starts with:
  - A category keyword: Fixed:, Added:, or Changed:
  - A space
  - The issue key (e.g. LAN-12345)
  - A space
  - Then the sentence describing the change.
- One line per item. Do not merge or combine items unless explicitly asked.
- No bold, italic, emojis, or headings inside the final changelog line.
- Keep each line one sentence where possible; two is acceptable if genuinely needed.

Example pattern:
* Fixed: LAN-12345 X was not working correctly.
* Added: LAN-12346 Added X to allow Y.
* Changed: LAN-12347 X has been improved to Y.

CATEGORY-SPECIFIC RULES

Fixed items:
- Always clearly state what was wrong before the fix.
- Use one of these structures:
  - "X was not working …"
  - "X was failing …"
  - "X could happen …"
  - "X could cause Y …"
- Describe the problem, not the implementation detail.
Examples:
* Fixed: LAN-12345 Saving reports could fail with an error.
* Fixed: LAN-99999 The installer could sometimes crash during setup.

Added items:
- Use "Added X …" or "X has been added …"
- Explicitly mention the new capability and, if possible, its purpose in short.
Examples:
* Added: LAN-11111 A setting has been added to exclude specific hosts from scanning.
* Added: LAN-22222 Added support for SNMPv3 credentials in OT discovery.

Changed items:
- Use "X has been improved …", "X has been changed …", or "X has been updated …"
- Focus on user-visible behavior: performance, consistency, usability, recognition, etc.
Examples:
* Changed: LAN-33333 The Assets page loading performance has been improved.
* Changed: LAN-44444 OS detection for vendor X devices has been improved.

STYLE & WORDING
- Keep it short and precise: typically one clear sentence.
- Use present perfect ("has been improved", "has been added") or past ("was not working") consistently.
- Avoid internal code names, component names, or micro-level details unless they are user-facing.
- Avoid overly technical jargon; describe the effect.
- Avoid "we fixed", "we improved"; focus on the product feature itself.
- Prefer neutral wording: "could fail" instead of "completely broke", "not working correctly" instead of "totally wrong".

HANDLING CONTEXT
- If a raw changelog line is provided: rewrite it to match the patterns above.
- If extra context or a description is provided: use it only to clarify the user-visible impact. Do not mention internal systems unless told it is okay.
- If the changelog entry is empty: write a new entry based on the summary and description, following all rules above.

LENGTH
- Answer ONLY with the rewritten changelog line(s). Nothing else.
- No introductory phrases like "Here is your rewrite".
- Default: minimal but clear.`;

// --- Routes ---

// GET /api/health — verify Jira connectivity and field discovery
app.get('/api/health', async (req, res) => {
  try {
    const field = await getChangelogField();
    res.json({ ok: true, changelogFieldId: field.id, changelogFieldIsAdf: field.isAdf });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tickets?startAt=0&maxResults=50
app.get('/api/tickets', async (req, res) => {
  try {
    const field = await getChangelogField();
    const startAt = Math.max(0, parseInt(req.query.startAt) || 0);
    const maxResults = Math.min(100, Math.max(1, parseInt(req.query.maxResults) || 50));

    const jql = 'labels = TW ORDER BY updated DESC';
    const fields = `summary,description,${field.id},status,issuetype`;

    const { data } = await axios.get(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      headers: jiraHeaders,
      httpsAgent: jiraHttpsAgent,
      params: { jql, startAt, maxResults, fields },
    });

    const tickets = data.issues.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary || '',
      url: `${JIRA_BASE_URL}/browse/${issue.key}`,
      status: issue.fields.status?.name || '',
      issueType: issue.fields.issuetype?.name || '',
      changelog: adfToText(issue.fields[field.id]),
      description: adfToText(issue.fields.description),
    }));

    res.json({ tickets, total: data.total, startAt: data.startAt, maxResults });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('GET /api/tickets error:', detail);
    res.status(500).json({ error: err.message, detail });
  }
});

// POST /api/improve — rewrite a changelog entry with Claude
app.post('/api/improve', async (req, res) => {
  try {
    const { key, summary, changelog, description } = req.body;
    if (!key || !summary) {
      return res.status(400).json({ error: 'key and summary are required' });
    }

    const parts = [`Issue: ${key}`, `Summary: ${summary}`];
    if (description && description.trim()) {
      parts.push(`Description:\n${description.trim()}`);
    }
    parts.push(
      changelog && changelog.trim()
        ? `Current changelog entry:\n${changelog.trim()}`
        : 'Current changelog entry: (empty — please write a new entry based on the summary and description above)'
    );

    const completion = await openai.chat.completions.create({
      model: 'anthropic/claude-opus-4',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
      ],
    });

    res.json({ improved: completion.choices[0].message.content.trim() });
  } catch (err) {
    console.error('POST /api/improve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tickets/:key — write the approved changelog back to Jira
app.put('/api/tickets/:key', async (req, res) => {
  try {
    const field = await getChangelogField();
    const { changelog } = req.body;
    if (typeof changelog !== 'string') {
      return res.status(400).json({ error: 'changelog (string) is required' });
    }

    const fieldValue = field.isAdf ? textToAdf(changelog) : changelog;

    await axios.put(
      `${JIRA_BASE_URL}/rest/api/3/issue/${req.params.key}`,
      { fields: { [field.id]: fieldValue } },
      { headers: jiraHeaders, httpsAgent: jiraHttpsAgent }
    );

    res.json({ success: true });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`PUT /api/tickets/${req.params.key} error:`, detail);
    res.status(500).json({ error: err.message, detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Changelog Manager running at http://localhost:${PORT}`);
});
