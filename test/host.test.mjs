import assert from 'node:assert/strict';
import { apply, internal } from '../lib/index.js';
import { decodeRequest, encodeAnswer, encodeRequest } from '../lib/review-format.js';

function makeContext(initialAnswer) {
  const captured = { listeners: {} };
  let answer = initialAnswer;
  const ctx = {
    systemPrompt: { section(definition) { captured.section = definition; } },
    tools: { register(definition) { captured.tool = definition; } },
    on(event, handler) { captured.listeners[event] = handler; },
    userQuestions: {
      async ask(request) {
        captured.request = request;
        captured.askCount = (captured.askCount ?? 0) + 1;
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(request) : answer;
      },
    },
  };
  return { ctx, captured, setAnswer(next) { answer = next; } };
}

const exec = { agent: { id: 'a1' }, signal: undefined, concluded: false, concludeTurn() { this.concluded = true; } };

// The tool registers with the expected shape and blocks on userQuestions.
{
  const answer = {
    answers: [{
      id: 'review',
      selected: ['提交批注'],
      custom: encodeAnswer({
        v: 1,
        decision: 'changes_requested',
        annotations: [{ id: 'i1', action: '需修改', quote: '正文', note: '改成两套口径' }],
        note: '整体意见',
      }, '## 批注'),
    }],
  };
  const { ctx, captured } = makeContext(answer);
  apply(ctx, { promptSection: true });

  assert.equal(captured.tool.name, 'request_review');
  assert.equal(captured.tool.parameters.required.includes('title'), true);
  assert.equal(typeof captured.tool.output.render, 'function');
  assert.equal(captured.section.name, 'review:policy');
  assert.equal(typeof captured.section.text(), 'string');

  const result = await captured.tool.execute({
    title: '口径确认',
    detail: '# 正文\n研发投入按全费用化口径测算',
    items: [{ prompt: '研发投入是否按全费用化口径？', quote: '研发投入按全费用化口径测算' }],
  }, exec);

  assert.equal(result.decision, 'changes_requested');
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].id, 'i1');
  assert.equal(result.annotations[0].note, '改成两套口径');
  assert.equal(result.note, '整体意见');

  // The pending question carries the request envelope the Client half decodes.
  const question = captured.request.questions[0];
  assert.equal(question.id, 'review');
  assert.match(question.detail, /^<!--dsh-review:v1 [A-Za-z0-9+/=]+-->/);
  assert.deepEqual(question.options.map((option) => option.label), ['通过', '提交批注']);
  assert.equal(exec.agent, captured.request.agent);
}

// A plain approval answer needs no envelope.
{
  const { ctx, captured } = makeContext({ answers: [{ id: 'review', selected: ['通过'] }] });
  apply(ctx, {});
  const result = await captured.tool.execute({ title: 'T', detail: 'body' }, exec);
  assert.equal(result.decision, 'approved');
  assert.deepEqual(result.annotations, []);
}

// Closing the panel cancels the review and concludes the turn.
{
  const cancelled = Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' });
  const { ctx, captured } = makeContext(cancelled);
  apply(ctx, {});
  const result = await captured.tool.execute({ title: 'T', detail: 'body' }, exec);
  assert.equal(result.decision, 'dismissed');
  assert.equal(exec.concluded, true);
}

// A subagent cannot ask the human; the tool explains instead of throwing.
{
  const delegated = Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' });
  const { ctx, captured } = makeContext(delegated);
  apply(ctx, {});
  const result = await captured.tool.execute({ title: 'T', detail: 'body' }, exec);
  assert.equal(result.decision, 'unavailable');
  assert.match(result.note, /主代理/);
}

// Validation rejects empty content and oversized details.
{
  const { ctx, captured } = makeContext({ answers: [] });
  apply(ctx, { maxDetailChars: 10 });
  await assert.rejects(() => captured.tool.execute({ title: '', detail: 'x' }, exec), /title/);
  await assert.rejects(() => captured.tool.execute({ title: 'T', detail: '' }, exec), /detail/);
  await assert.rejects(() => captured.tool.execute({ title: 'T', detail: 'x'.repeat(11) }, exec), /上限/);
}

// The Client half's base64 decoder accepts the Host encoder's output.
{
  const meta = { v: 1, reviewId: 'rv_x', title: '中文标题', items: [], approve: '通过', decline: '提交批注' };
  const detail = `${encodeRequest(meta)}\n\n正文`;
  const match = /^<!--dsh-review:v1\s+([A-Za-z0-9+/=]+)\s*-->/.exec(detail);
  assert.ok(match);
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(decoded.title, '中文标题');
  assert.equal(detail.slice(match[0].length).trim(), '正文');
}


// The present hook opens an automatic review and appends its outcome to the tool result.
{
  const approved = { answers: [{ id: 'review', selected: ['全部通过'] }] };
  const { ctx, captured } = makeContext(approved);
  apply(ctx, {});
  assert.equal(typeof captured.listeners['tools/post-execute'], 'function');

  const exec = {
    name: 'present',
    agent: { id: 'a1', session: { id: 's1' } },
    arguments: { files: [{ path: '/tmp/a.docx', description: '报告底稿' }] },
    signal: undefined,
  };
  const result = { content: [{ type: 'text', text: 'presented' }] };
  const output = await captured.listeners['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }));
  assert.ok(Array.isArray(output.content));
  assert.match(output.content[output.content.length - 1].text, /交付件验收/);
  assert.match(output.content[output.content.length - 1].text, /确认全部文件通过/);
  assert.equal(captured.askCount, 1);
  assert.match(captured.request.questions[0].detail, /^<!--dsh-review:v1 /);
  assert.equal(captured.request.questions[0].options[0].label, '全部通过');

  // Cooldown: a second delivery in the same window does not stack another panel.
  captured.listenerAskCount = captured.askCount;
  const again = await captured.listeners['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }));
  assert.equal(captured.askCount, captured.listenerAskCount);
  assert.equal(again.content, undefined);
}

// A cancelled automatic review leaves the present result intact and never throws.
{
  const cancelled = Object.assign(new Error('cancel'), { code: 'ASK_CANCELLED' });
  const { ctx, captured } = makeContext(cancelled);
  apply(ctx, { autoReviewCooldownMs: 0 });
  const exec = {
    name: 'present',
    agent: { id: 'a1', session: { id: 's2' } },
    arguments: { files: [{ path: '/tmp/b.xlsx' }] },
    signal: undefined,
  };
  const result = { content: [{ type: 'text', text: 'presented' }] };
  const output = await captured.listeners['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }));
  assert.match(output.content[output.content.length - 1].text, /未确认/);
}

// Non-present tools and failed presents are passed through untouched.
{
  const { ctx, captured } = makeContext({ answers: [] });
  apply(ctx, {});
  const passthrough = async () => ({ kind: 'accept' });
  const unrelated = await captured.listeners['tools/post-execute'](
    { name: 'bash', agent: { id: 'a1', session: { id: 's3' } }, arguments: {}, signal: undefined },
    { content: [{ type: 'text', text: 'ok' }] },
    passthrough,
  );
  assert.equal(unrelated.content, undefined);
  const failed = await captured.listeners['tools/post-execute'](
    { name: 'present', agent: { id: 'a1', session: { id: 's4' } }, arguments: { files: [{ path: '/tmp/c' }] }, signal: undefined },
    { isError: true, content: [] },
    passthrough,
  );
  assert.equal(failed.content, undefined);
}

// Windows paths: the basename of a delivery file, and the auto-review prompt built from it.
{
  assert.equal(internal.baseName('C:\\Users\\me\\报告.docx'), '报告.docx');
  assert.equal(internal.baseName('C:/Users/me/report.docx'), 'report.docx');
  assert.equal(internal.baseName('/tmp/a.docx'), 'a.docx');
  assert.equal(internal.baseName('a.docx'), 'a.docx');
  assert.equal(internal.baseName('\\\\server\\share\\x.md'), 'x.md');

  const approved = { answers: [{ id: 'review', selected: ['全部通过'] }] };
  const { ctx, captured } = makeContext(approved);
  apply(ctx, {});
  const windowsExec = {
    name: 'present',
    agent: { id: 'a1', session: { id: 's-win' } },
    arguments: { files: [{ path: 'C:\\Users\\me\\out\\报告终稿.docx', description: '报告底稿' }] },
    signal: undefined,
  };
  await captured.listeners['tools/post-execute'](windowsExec, { content: [] }, async () => ({ kind: 'accept' }));
  const { meta } = decodeRequest(captured.request.questions[0].detail);
  assert.equal(meta.items[0].prompt, '「报告终稿.docx」是否达到交付要求？');
  assert.deepEqual(meta.files, ['C:\\Users\\me\\out\\报告终稿.docx']);
}

console.log('host: all assertions passed');
