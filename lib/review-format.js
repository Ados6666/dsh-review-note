/**
 * Wire format shared by the Host half and its tests.
 *
 * Two machine-readable envelopes travel as HTML comments so that a transcript
 * renderer hides them:
 *
 *   request:  <!--dsh-review:v1 <base64(JSON meta)>-->  + "\n\n" + detail
 *   answer:   <!--dsh-review-answer:v1 <base64(JSON payload)>--> + "\n\n" + markdown
 *
 * Base64 avoids both the HTML-comment terminator (`-->` inside a note quote)
 * and Markdown reflow damage. The Markdown after the envelope exists only for
 * human reading in the transcript; the Host parses the envelope.
 */

export const REQUEST_MARKER = 'dsh-review:v1';
export const ANSWER_MARKER = 'dsh-review-answer:v1';

const REQUEST_RE = /^<!--dsh-review:v1\s+([A-Za-z0-9+/=]+)\s*-->\s*/;
const ANSWER_RE = /<!--dsh-review-answer:v1\s+([A-Za-z0-9+/=]+)\s*-->/;

/** Encode a UTF-8 JSON value as base64. */
export function encodeBase64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** Decode a base64 JSON value; returns null when the payload is not JSON. */
export function decodeBase64(text) {
  try {
    return JSON.parse(Buffer.from(String(text), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Render the request envelope that prefixes `detail`. */
export function encodeRequest(meta) {
  return `<!--${REQUEST_MARKER} ${encodeBase64(meta)}-->`;
}

/**
 * Read the request envelope from a question detail.
 * @param {string} detail
 * @returns {{ meta: object, body: string } | null}
 */
export function decodeRequest(detail) {
  if (typeof detail !== 'string') return null;
  const match = REQUEST_RE.exec(detail);
  if (match === null) return null;
  const meta = decodeBase64(match[1]);
  if (meta === null || typeof meta !== 'object') return null;
  return { meta, body: detail.slice(match[0].length) };
}

/** Assemble the user-visible answer text. */
export function encodeAnswer(payload, markdown) {
  return `<!--${ANSWER_MARKER} ${encodeBase64(payload)}-->\n\n${markdown}`;
}

/**
 * Read the answer envelope out of a `custom` answer string.
 * @param {string} custom
 * @returns {object | null}
 */
export function decodeAnswer(custom) {
  if (typeof custom !== 'string') return null;
  const match = ANSWER_RE.exec(custom);
  if (match === null) return null;
  return decodeBase64(match[1]);
}

/**
 * Normalize model-supplied review items into the wire shape.
 * @param {Array<object>|undefined} items
 * @param {number} maxItems
 * @returns {Array<object>}
 */
export function normalizeItems(items, maxItems) {
  const input = Array.isArray(items) ? items : [];
  if (input.length > maxItems) {
    throw new Error(`items 最多 ${maxItems} 条，收到 ${input.length} 条`);
  }
  const seen = new Set();
  return input.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`items[${index}] 必须是对象`);
    const prompt = String(item.prompt ?? '').trim();
    if (prompt === '') throw new Error(`items[${index}].prompt 不能为空`);
    let id = String(item.id ?? '').trim() || `i${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const options = Array.isArray(item.options) && item.options.length > 0
      ? item.options.map((option, optionIndex) => {
          const label = String(option?.label ?? '').trim();
          if (label === '') throw new Error(`items[${index}].options[${optionIndex}].label 不能为空`);
          const description = typeof option?.description === 'string' ? option.description : undefined;
          return description === undefined ? { label } : { label, description };
        })
      : [{ label: '确认' }, { label: '需修改' }];
    let recommended = typeof item.recommended === 'string' ? item.recommended : undefined;
    if (recommended !== undefined && !options.some((option) => option.label === recommended)) {
      recommended = undefined;
    }
    const quote = typeof item.quote === 'string' && item.quote.trim() !== '' ? item.quote : undefined;
    return {
      id,
      prompt,
      ...(quote === undefined ? {} : { quote }),
      options,
      ...(recommended === undefined ? {} : { recommended }),
      ...(item.multi_select === true ? { multiSelect: true } : {}),
    };
  });
}

/**
 * Turn a finished answer into the model-facing result.
 * @param {{ answers: Array<{ id: string, selected: string[], custom?: string }> }} answer
 * @param {object} meta
 * @returns {object}
 */
export function parseAnswer(answer, meta) {
  const list = Array.isArray(answer?.answers) ? answer.answers : [];
  const item = list.find((entry) => entry.id === 'review') ?? list[0];
  const selected = Array.isArray(item?.selected) ? item.selected : [];
  const custom = typeof item?.custom === 'string' ? item.custom : '';
  const payload = decodeAnswer(custom);
  const promptById = new Map((meta.items ?? []).map((entry) => [entry.id, entry.prompt]));

  if (payload !== null) {
    const annotations = (Array.isArray(payload.annotations) ? payload.annotations : []).map((entry) => ({
      id: String(entry?.id ?? ''),
      prompt: promptById.get(entry?.id) ?? '',
      action: String(entry?.action ?? 'comment'),
      quote: String(entry?.quote ?? ''),
      note: String(entry?.note ?? ''),
    }));
    return {
      decision: payload.decision === 'approved' ? 'approved' : 'changes_requested',
      review_id: meta.reviewId,
      annotations,
      note: typeof payload.note === 'string' ? payload.note : '',
    };
  }

  if (custom.trim() === '' && selected.includes(meta.approve)) {
    return { decision: 'approved', review_id: meta.reviewId, annotations: [], note: '' };
  }
  return {
    decision: 'changes_requested',
    review_id: meta.reviewId,
    annotations: [],
    note: custom.trim() === '' ? selected.join(', ') : custom.trim(),
  };
}

/** Human-readable summary carried in the tool transcript card. */
export function summarize(result) {
  if (result.decision === 'approved') return '交付评审通过。';
  if (result.decision === 'dismissed') return '用户关闭了交付评审（未作答）。';
  if (result.decision === 'unavailable') return result.note || '交付评审在子代理中不可用。';
  const lines = [`用户提交了 ${result.annotations.length} 条批注：`];
  for (const entry of result.annotations) {
    const label = entry.prompt === '' ? entry.id : entry.prompt;
    const quote = entry.quote === '' ? '' : ` | 原文：${entry.quote}`;
    lines.push(`- [${entry.id}] ${label}${quote} → ${entry.note}`);
  }
  if (result.note !== '') lines.push(`整体意见：${result.note}`);
  return lines.join('\n');
}
