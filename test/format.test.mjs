import assert from 'node:assert/strict';
import {
  decodeAnswer,
  decodeRequest,
  encodeAnswer,
  encodeRequest,
  normalizeItems,
  parseAnswer,
  summarize,
} from '../lib/review-format.js';

const meta = {
  v: 1,
  reviewId: 'rv_test',
  title: '口径确认',
  approve: '通过',
  decline: '提交批注',
  items: [{ id: 'a', prompt: '研发投入是否按全费用化口径？', options: [{ label: '确认' }, { label: '需修改' }] }],
  files: [],
  createdAt: 1,
};

// Request envelope survives a round trip and keeps the body readable.
{
  const detail = `${encodeRequest(meta)}\n\n# 正文\n研发投入按全费用化口径测算`;
  const decoded = decodeRequest(detail);
  assert.ok(decoded);
  assert.equal(decoded.meta.reviewId, 'rv_test');
  assert.ok(decoded.body.startsWith('# 正文'));
}

// Answer envelope survives notes containing comment terminators.
{
  const payload = {
    v: 1,
    decision: 'changes_requested',
    annotations: [{ id: 'a', action: '需修改', quote: '研发投入', note: '改成两套口径 --> 并列' }],
    note: '整体: --> 同步',
  };
  const custom = encodeAnswer(payload, '## 批注');
  assert.equal(decodeAnswer(custom).annotations[0].note, '改成两套口径 --> 并列');
}

// Item normalization fills ids, defaults options, and rejects duplicates.
{
  const items = normalizeItems([{ prompt: '第一条' }, { prompt: '第二条', id: 'i1' }], 20);
  assert.equal(items[0].id, 'i1');
  assert.equal(items[1].id, 'i1-2');
  assert.deepEqual(items[0].options.map((o) => o.label), ['确认', '需修改']);
}

// Structured answer is mapped back onto item prompts.
{
  const answer = {
    answers: [{
      id: 'review',
      selected: ['提交批注'],
      custom: encodeAnswer({
        v: 1,
        decision: 'changes_requested',
        annotations: [{ id: 'a', action: '需修改', quote: '研发投入', note: '两套并列' }],
        note: '同步台账',
      }, ''),
    }],
  };
  const result = parseAnswer(answer, meta);
  assert.equal(result.decision, 'changes_requested');
  assert.equal(result.annotations[0].prompt, '研发投入是否按全费用化口径？');
  assert.equal(result.annotations[0].note, '两套并列');
  assert.equal(result.note, '同步台账');
  assert.ok(summarize(result).includes('两套并列'));
}

// Plain approval and free-form fallback.
{
  const approved = parseAnswer({ answers: [{ id: 'review', selected: ['通过'] }] }, meta);
  assert.equal(approved.decision, 'approved');
  const fallback = parseAnswer({ answers: [{ id: 'review', selected: ['提交批注'], custom: '请把口径改成两套' }] }, meta);
  assert.equal(fallback.decision, 'changes_requested');
  assert.equal(fallback.note, '请把口径改成两套');
}

console.log('review-format: all assertions passed');
