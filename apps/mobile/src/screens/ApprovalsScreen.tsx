import { useMemo, useState } from 'react'
import { Check, FileText, MessageCircleQuestion, Send, X } from 'lucide-react'

import { computeLineDiff } from '../lib/diff'
import { formatTime } from '../lib/format'
import type {
  MobileAskUserAnswers,
  MobilePendingQuestion,
  MobilePendingWrite,
  MobileSnapshot,
} from '../types'
import { DiffView } from './DiffView'

const FREE_OTHER = '__other__'

export function ApprovalsScreen({
  connected,
  busyId,
  snapshot,
  onWriteDecision,
  onQuestionAnswer,
}: {
  connected: boolean
  busyId: string | null
  snapshot: MobileSnapshot | null
  onWriteDecision: (id: string, action: 'approve' | 'reject') => void
  onQuestionAnswer: (id: string, answers: MobileAskUserAnswers) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, MobileAskUserAnswers>>({})

  if (!connected) {
    return <div className="empty-state">先在设置中配对桌面端。</div>
  }

  const writes = snapshot?.pendingWrites ?? []
  const questions = snapshot?.pendingQuestions ?? []

  return (
    <div className="screen-stack">
      <section className="card-list">
        <h2 className="section-title">
          <FileText className="section-icon" aria-hidden="true" />
          文件修改审批
        </h2>
        {writes.length > 0 ? (
          writes.map((write) => (
            <WriteApprovalCard
              key={write.id}
              write={write}
              busyId={busyId}
              onDecide={onWriteDecision}
            />
          ))
        ) : (
          <div className="empty-state">暂无待审批文件修改。</div>
        )}
      </section>

      <section className="card-list">
        <h2 className="section-title">
          <MessageCircleQuestion className="section-icon" aria-hidden="true" />
          Agent 提问
        </h2>
        {questions.length > 0 ? (
          questions.map((item) => {
            const draft = drafts[item.id] ?? emptyAnswers(item)
            const canSubmit = item.questions.every((question) => {
              const answer = draft[question.question]
              if (!answer) return false
              const labels = answer.selectedLabels.filter((label) => label !== FREE_OTHER)
              return labels.length > 0 || !!answer.freeformNote?.trim()
            })

            return (
              <article key={item.id} className="approval-card">
                <div>
                  <h3>{item.questions[0]?.header ?? '待回答问题'}</h3>
                  <p>{item.questions[0]?.question ?? 'Agent 正在等待用户选择。'}</p>
                </div>

                {item.questions.map((question) => {
                  const answer = draft[question.question]
                  const otherSelected = answer?.selectedLabels.includes(FREE_OTHER) ?? false
                  return (
                    <div key={question.question} className="question-block">
                      <div className="question-title">{question.header}</div>
                      <p>{question.question}</p>
                      <div className="option-grid">
                        {question.options.map((option) => {
                          const selected = answer?.selectedLabels.includes(option.label) ?? false
                          return (
                            <button
                              key={option.label}
                              type="button"
                              className={selected ? 'option-button selected' : 'option-button'}
                              onClick={() =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: toggleOption(
                                    prev[item.id] ?? emptyAnswers(item),
                                    question.question,
                                    option.label,
                                    !!question.multiSelect,
                                  ),
                                }))
                              }
                            >
                              <span>
                                {selected && <Check className="option-icon" aria-hidden="true" />}
                                {option.label}
                              </span>
                              {option.description && <small>{option.description}</small>}
                            </button>
                          )
                        })}
                        <button
                          type="button"
                          className={otherSelected ? 'option-button other selected' : 'option-button other'}
                          onClick={() =>
                            setDrafts((prev) => ({
                              ...prev,
                              [item.id]: toggleOption(
                                prev[item.id] ?? emptyAnswers(item),
                                question.question,
                                FREE_OTHER,
                                !!question.multiSelect,
                              ),
                            }))
                          }
                        >
                          <span>
                            {otherSelected && <Check className="option-icon" aria-hidden="true" />}
                            其他（自由填写）
                          </span>
                          <small>选项以外的答案，在下方补充说明</small>
                        </button>
                      </div>
                      {otherSelected && (
                        <textarea
                          className="freeform-input"
                          value={answer?.freeformNote ?? ''}
                          placeholder="写点说明，Agent 会基于这段文字继续"
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [item.id]: setFreeformNote(
                                prev[item.id] ?? emptyAnswers(item),
                                question.question,
                                event.target.value,
                              ),
                            }))
                          }
                        />
                      )}
                    </div>
                  )
                })}

                <button
                  type="button"
                  className="primary-action full"
                  disabled={!canSubmit || busyId !== null}
                  onClick={() => onQuestionAnswer(item.id, buildAnswers(item, draft))}
                >
                  <Send className="button-icon" aria-hidden="true" />
                  {busyId === item.id ? '提交中' : '提交回答'}
                </button>
              </article>
            )
          })
        ) : (
          <div className="empty-state">暂无待回答问题。</div>
        )}
      </section>
    </div>
  )
}

/**
 * 每个待审批卡片单独成组件：diff 只在内容变化时重算。
 * 否则审批列表每 3 秒随快照重渲染一次，LCS 会跟着重跑（大文件直接卡住 WebView）。
 */
function WriteApprovalCard({
  write,
  busyId,
  onDecide,
}: {
  write: MobilePendingWrite
  busyId: string | null
  onDecide: (id: string, action: 'approve' | 'reject') => void
}) {
  const lines = useMemo(
    () => computeLineDiff(write.oldContent ?? '', write.newContent),
    [write.oldContent, write.newContent],
  )

  return (
    <article className="approval-card">
      <div>
        <h3>{write.path}</h3>
        <p>
          {write.oldContent === null ? '新建文件' : '修改文件'} · {formatTime(write.createdAt)}
        </p>
      </div>
      <details className="content-preview">
        <summary>查看改动</summary>
        <div className="preview-label">{write.oldContent === null ? '新建内容' : '改动对比'}</div>
        <DiffView lines={lines} />
      </details>
      <div className="approval-actions">
        <button
          type="button"
          className="danger-action"
          disabled={busyId !== null}
          onClick={() => onDecide(write.id, 'reject')}
        >
          <X className="button-icon" aria-hidden="true" />
          {busyId === write.id ? '处理中' : '拒绝'}
        </button>
        <button
          type="button"
          className="primary-action small"
          disabled={busyId !== null}
          onClick={() => onDecide(write.id, 'approve')}
        >
          <Check className="button-icon" aria-hidden="true" />
          {busyId === write.id ? '处理中' : '批准'}
        </button>
      </div>
    </article>
  )
}

function emptyAnswers(item: MobilePendingQuestion): MobileAskUserAnswers {
  return Object.fromEntries(
    item.questions.map((question) => [question.question, { selectedLabels: [], freeformNote: '' }]),
  )
}

function toggleOption(
  current: MobileAskUserAnswers,
  question: string,
  label: string,
  multiSelect: boolean,
): MobileAskUserAnswers {
  const answer = current[question] ?? { selectedLabels: [] }
  const exists = answer.selectedLabels.includes(label)
  const selectedLabels = multiSelect
    ? exists
      ? answer.selectedLabels.filter((item) => item !== label)
      : [...answer.selectedLabels, label]
    : exists
      ? []
      : [label]

  return {
    ...current,
    [question]: {
      ...answer,
      selectedLabels,
    },
  }
}

function setFreeformNote(
  current: MobileAskUserAnswers,
  question: string,
  note: string,
): MobileAskUserAnswers {
  const answer = current[question] ?? { selectedLabels: [] }
  return { ...current, [question]: { ...answer, freeformNote: note } }
}

/**
 * FREE_OTHER 只是 UI 哨兵，不属于问题选项；服务端会校验 label 必须来自 options。
 * 去掉它，自由填写的内容仍由 freeformNote 带给 agent。
 */
function buildAnswers(item: MobilePendingQuestion, draft: MobileAskUserAnswers): MobileAskUserAnswers {
  const out: MobileAskUserAnswers = {}
  for (const question of item.questions) {
    const answer = draft[question.question] ?? { selectedLabels: [] }
    out[question.question] = {
      selectedLabels: answer.selectedLabels.filter((label) => label !== FREE_OTHER),
      freeformNote: answer.freeformNote,
    }
  }
  return out
}
