/**
 * dsh-review-note — Host half.
 *
 * Registers one model-facing tool, `request_review`, which presents a
 * checkpoint deliverable for item-by-item human annotation. The tool blocks on
 * the ordinary user-questions channel (`ctx.userQuestions.ask`), so the Web
 * client's answer card is the same pending interaction every other question
 * uses; the Client half of this bundle takes that card over when it sees the
 * request envelope in `detail`.
 *
 * The tool definition is built by hand instead of importing `defineTool` from
 * `@deepseek-ai/dsh-tools`: a directory-linked bundle resolves bare imports from
 * its own real path, where the Harness installation's packages are not
 * reachable. Only relative and Node built-in imports remain, so the Host half
 * loads from any checkout.
 *
 * @module dsh-review-note
 */

import { randomUUID } from 'node:crypto';
import {
  encodeRequest,
  normalizeItems,
  parseAnswer,
  summarize,
} from './review-format.js';

const DEFAULTS = {
  promptSection: true,
  maxDetailChars: 40000,
  maxItems: 20,
  maxFiles: 4,
  // 交付件自动验收：present 成功后自动发起一次「文件级」评审。
  autoReviewPresent: true,
  autoReviewMinFiles: 1,
  autoReviewCooldownMs: 120000,
};

/** Last auto-review timestamp per session, so two deliveries in one turn do not stack panels. */
const lastReviewAt = new Map();

const SECTION_TEXT = `## 阶段交付评审
当阶段性成果需要用户逐条确认时（方案定稿、报告章节、测算口径、批量改动清单、交付件验收等），
调用 request_review：detail 放交付正文，items 放需要确认的点位，一次提交。
- 确认点 ≥2 个时不要连续调用 ask_user_question，合并成一次 request_review。
- 用户返回 changes_requested 时，按 annotations 逐条修改，再发起下一轮；不要另行复述问题。
- 单纯二选一、缺信息、权限确认仍用 ask_user_question。
- 子代理里不要调用 request_review（只能由主代理发起）。`;

const TOOL_DESCRIPTION = `Present a checkpoint deliverable for item-by-item human review.

Use it when a stage deliverable needs the user's confirmation: a finalized plan, a report section, calculation conventions, a batch of file changes, an acceptance checklist. Put the deliverable body in \`detail\` and every point that needs a decision in \`items\`. The user annotates each item in place and either approves the whole review or returns structured per-item notes.

When to use it:
- Two or more independent confirmation points arrived at the same checkpoint.
- The confirmation is about a body of content, not a single yes/no question.
Prefer the ordinary ask_user_question tool for a single binary choice, missing information, or permission.

Rules:
- \`detail\` is Markdown shown to the user; keep it self-contained (they may not re-read the chat).
- Each item gets a stable \`id\`; \`quote\` optionally pins it to an exact passage of \`detail\`.
- On \`changes_requested\`, apply every annotation, then call request_review again with the revised body.
- Do not repeat the questions as chat text; the annotations are the answer.
- This tool needs the live root agent; a subagent must report the question in its final result instead.`;

const STRING = (description) => ({ type: 'string', description });
const STRING_ARRAY = (description) => ({ type: 'array', description, items: { type: 'string' } });

const PARAMETERS = {
  type: 'object',
  properties: {
    title: STRING('Short user-facing title of this review checkpoint, e.g. "募投方案 · 第二节口径确认".'),
    detail: STRING('The deliverable body as Markdown. This is what the user reads and annotates.'),
    items: {
      type: 'array',
      description: 'Points that need a decision. Each becomes one annotatable card. Prefer 1-12 items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: STRING('Stable id echoed in the result; auto-assigned when omitted.'),
          prompt: STRING('The confirmation point, in user-facing terms.'),
          quote: STRING('Optional exact passage of detail this item is about; used for highlighting.'),
          options: {
            type: 'array',
            description: 'Optional choices; default is 确认 / 需修改.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: STRING('Short option label.'),
                description: STRING('One sentence explaining the tradeoff.'),
              },
              required: ['label'],
            },
          },
          recommended: STRING('Optional default option label.'),
          multi_select: { type: 'boolean', description: 'Allow more than one option.' },
        },
        required: ['prompt'],
      },
    },
    files: STRING_ARRAY('Optional deliverable paths to show as file chips (they are not opened automatically).'),
    approve_label: STRING('Approve button label; default 通过.'),
    decline_label: STRING('Annotate/submit button label; default 提交批注.'),
  },
  required: ['title', 'detail'],
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: {
      type: 'string',
      enum: ['approved', 'changes_requested', 'dismissed', 'unavailable'],
      description: 'approved: user accepted the checkpoint. changes_requested: read annotations. dismissed: user closed the panel without answering. unavailable: human review cannot run here.',
    },
    review_id: { type: 'string' },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          action: { type: 'string' },
          quote: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'prompt', 'action', 'quote', 'note'],
      },
    },
    note: { type: 'string' },
  },
  required: ['decision', 'review_id', 'annotations', 'note'],
};

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}


/** Compose the single review question the Client half renders. */
function buildQuestion(meta, detail) {
  return {
    id: 'review',
    header: meta.title.length > 60 ? `${meta.title.slice(0, 59)}…` : meta.title,
    question: '请审阅以下交付内容；需要修改的地方逐条批注，无批注可直接通过。',
    detail: `${encodeRequest(meta)}\n\n${detail}`,
    options: [
      { label: meta.approve, description: '接受这份交付，继续下一步。' },
      { label: meta.decline, description: '退回修改；逐条批注会作为修改依据。' },
    ],
  };
}

/** Render the auto-review body: one line per delivered file. */
function renderFileDetail(files) {
  const lines = ['### 本次交付文件', ''];
  files.forEach((file, index) => {
    const description = typeof file.description === 'string' && file.description.trim() !== ''
      ? ` — ${file.description.trim()}`
      : '';
    lines.push(`${index + 1}. \`${file.path}\`${description}`);
  });
  lines.push('', '> 在右侧面板逐条确认；需要修改的条目直接写批注。');
  return lines.join('\n');
}

/** Read `files` from present arguments without trusting their shape. */
function presentFilesOf(args) {
  const input = args && Array.isArray(args.files) ? args.files : [];
  return input
    .map((file) => (file && typeof file.path === 'string' ? {
      path: file.path,
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
    } : null))
    .filter((file) => file !== null);
}

/** Last path segment, accepting both POSIX ("a/b.docx") and Windows ("C:\\d\\b.docx") input. */
function baseName(filePath) {
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] || String(filePath);
}

/** Feedback block appended to the present tool result after an automatic review. */
function renderReviewFeedback(result) {
  if (result.decision === 'approved') return '\n\n[交付件验收] 用户已确认全部文件通过。';
  if (result.decision === 'dismissed') return '\n\n[交付件验收] 用户关闭了验收面板，未确认；不要视为通过。';
  if (result.decision === 'unavailable') return '\n\n[交付件验收] 当前没有可用的用户交互通道，已跳过验收。';
  const lines = [`\n\n[交付件验收] 用户提交了 ${result.annotations.length} 条批注：`];
  result.annotations.forEach((entry) => {
    const quote = entry.quote === '' ? '' : ` | 原文：${entry.quote}`;
    lines.push(`- [${entry.id}] ${entry.prompt}${quote} → ${entry.note || entry.action}`);
  });
  if (result.note !== '') lines.push(`整体意见：${result.note}`);
  return lines.join('\n');
}

export const inject = ['tools', 'userQuestions', 'systemPrompt'];

/** Exposed for tests only; the loader does not read this. */
export const internal = { baseName, renderFileDetail };

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };

  ctx.systemPrompt.section({
    name: 'review:policy',
    order: 45,
    text: () => (cfg.promptSection === false ? '' : SECTION_TEXT),
  });

  ctx.tools.register({
    name: 'request_review',
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    async execute(args, exec) {
      const title = asString(args?.title).trim();
      const detail = asString(args?.detail);
      if (title === '') throw new Error('request_review: title 不能为空');
      if (detail.trim() === '') throw new Error('request_review: detail 不能为空');
      if (detail.length > cfg.maxDetailChars) {
        throw new Error(`request_review: detail 超过上限（${detail.length} > ${cfg.maxDetailChars} 字符），请拆分或精简`);
      }
      const items = normalizeItems(args?.items, cfg.maxItems);
      const files = Array.isArray(args?.files)
        ? args.files.map((entry) => String(entry)).filter((entry) => entry.trim() !== '')
        : [];
      if (files.length > cfg.maxFiles) {
        throw new Error(`request_review: files 最多 ${cfg.maxFiles} 个，收到 ${files.length} 个`);
      }
      const approve = asString(args?.approve_label).trim() || '通过';
      const decline = asString(args?.decline_label).trim() || '提交批注';
      if (approve === decline) throw new Error('request_review: approve_label 与 decline_label 不能相同');

      const meta = {
        v: 1,
        reviewId: `rv_${randomUUID().slice(0, 8)}`,
        title,
        approve,
        decline,
        items,
        files,
        createdAt: Date.now(),
      };

      const question = {
        id: 'review',
        header: title.length > 60 ? `${title.slice(0, 59)}…` : title,
        question: '请审阅以下交付内容；需要修改的地方逐条批注，无批注可直接通过。',
        detail: `${encodeRequest(meta)}\n\n${detail}`,
        options: [
          { label: approve, description: '接受这份交付，继续下一步。' },
          { label: decline, description: '退回修改；逐条批注会作为修改依据。' },
        ],
      };

      let answer;
      try {
        answer = await ctx.userQuestions.ask({
          questions: [question],
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          signal: exec.signal,
        });
      } catch (error) {
        if (error?.code === 'ASK_CANCELLED') {
          try {
            exec.concludeTurn();
          } catch {
            /* older kernels may not expose concludeTurn; the tool result still ends the call */
          }
          return { decision: 'dismissed', review_id: meta.reviewId, annotations: [], note: '用户关闭了评审面板。' };
        }
        if (error?.code === 'DELEGATED_CALLER') {
          return {
            decision: 'unavailable',
            review_id: meta.reviewId,
            annotations: [],
            note: '交付评审只能由主代理发起；请把需要确认的内容写进你的最终结果，由主代理汇总后再发起。',
          };
        }
        if (error?.code === 'NO_PROVIDER') {
          return {
            decision: 'unavailable',
            review_id: meta.reviewId,
            annotations: [],
            note: '当前没有可用的用户交互通道（没有打开的 Web 客户端）。',
          };
        }
        throw error;
      }

      return parseAnswer(answer, meta);
    },
  });

  // 交付件自动验收：present 成功即发起一次文件级评审，无需用户下指令。
  // 失败、子代理、冷却期内一律放行，绝不因为验收不可用而破坏 present 的结果。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    try {
      if (cfg.autoReviewPresent === false) return downstream;
      if (exec?.name !== 'present' || exec.agent === undefined) return downstream;
      if (result?.isError === true || downstream.kind === 'block') return downstream;
      const files = presentFilesOf(exec.arguments);
      const minFiles = Math.max(1, Number(cfg.autoReviewMinFiles) || 1);
      if (files.length < minFiles) return downstream;

      const sessionId = String(exec.agent?.session?.id ?? '');
      const now = Date.now();
      const cooldown = Math.max(0, Number(cfg.autoReviewCooldownMs) || 0);
      if (now - (lastReviewAt.get(sessionId) ?? 0) < cooldown) return downstream;
      lastReviewAt.set(sessionId, now);

      const meta = {
        v: 1,
        reviewId: `rv_${randomUUID().slice(0, 8)}`,
        title: `交付件验收 · ${files.length} 个文件`,
        approve: '全部通过',
        decline: '提交批注',
        items: files.map((file, index) => ({
          id: `f${index + 1}`,
          prompt: `「${baseName(file.path)}」是否达到交付要求？`,
          options: [{ label: '确认' }, { label: '需修改' }],
        })),
        files: files.map((file) => file.path),
        createdAt: now,
      };

      const content = Array.isArray(downstream.content)
        ? downstream.content
        : Array.isArray(result.content) ? result.content : [];

      let answer;
      try {
        answer = await ctx.userQuestions.ask({
          questions: [buildQuestion(meta, renderFileDetail(files))],
          agent: exec.agent,
          signal: exec.signal,
        });
      } catch (error) {
        if (error?.code === 'ASK_CANCELLED') {
          return {
            ...downstream,
            content: [...content, { type: 'text', text: renderReviewFeedback({ decision: 'dismissed', annotations: [], note: '' }) }],
          };
        }
        return downstream;
      }

      lastReviewAt.set(sessionId, Date.now());
      const parsed = parseAnswer(answer, meta);
      return { ...downstream, content: [...content, { type: 'text', text: renderReviewFeedback(parsed) }] };
    } catch (error) {
      return downstream;
    }
  });
}
