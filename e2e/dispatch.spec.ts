import { expect, test, type Page } from '@playwright/test'

/**
 * 群聊编排 E2E：MockAdapter 在 PLAN 阶段发 plan_tasks、子任务发 report_task_result、
 * AGGREGATE 阶段给总结，所以整条 PLAN → 审批 → DAG → 聚合 链路可以确定性跑通。
 */

const ORCHESTRATOR = 'E2E Orchestrator'
const WORKER_A = 'E2E Worker A'
const WORKER_B = 'E2E Worker B'

async function createGroupChat(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '新建对话' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (const name of [ORCHESTRATOR, WORKER_A, WORKER_B]) {
    await dialog.getByRole('button').filter({ hasText: name }).first().click()
  }
  await expect(dialog.getByText(/将创建群聊/)).toBeVisible()
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect(dialog).toBeHidden()
}

test('群聊：Orchestrator 拆任务 → 待确认 → 执行计划 → 子任务完成 + 聚合总结', async ({ page }) => {
  await createGroupChat(page)

  const input = page.getByTestId('composer-input')
  await input.fill('请把「做一个落地页」拆给团队成员')
  await input.press('Enter')

  // PLAN：plan_tasks 被 AgentRunner 拦截 → 待确认卡（两个 worker 各一项）
  const reviewCard = page.getByText('计划待确认 · 2 项')
  await expect(reviewCard).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(WORKER_A).first()).toBeVisible()
  await expect(page.getByText(WORKER_B).first()).toBeVisible()

  // 审批 → DAG 执行子任务
  await page.getByRole('button', { name: '执行计划' }).click()

  // AGGREGATE：两个子任务都 complete，Orchestrator 给总结
  await expect(
    page.getByText('编排完成：子任务已按计划执行完毕，各任务状态见上方调度卡。'),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('任务拆解 · 2 项')).toBeVisible()
  await expect(page.getByText('2 / 2')).toBeVisible()
})

test('群聊：产物交接链 → 上游产物落库并交接给下游任务', async ({ page }) => {
  await createGroupChat(page)

  const input = page.getByTestId('composer-input')
  await input.fill('用产物交接的方式推进「写一份方案」')
  await input.press('Enter')

  // 计划卡显示交接契约：t1 out doc:document，t2 in t1.doc
  await expect(page.getByText('计划待确认 · 2 项')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('out doc:document')).toBeVisible()
  await expect(page.getByText('in t1.doc')).toBeVisible()

  await page.getByRole('button', { name: '执行计划' }).click()

  // 上游产物真落库 → 作为 artifact_ref 卡片出现在群里
  await expect(page.getByRole('button', { name: /点击预览/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Mock 交接产物 doc')).toBeVisible()

  // 下游任务拿到了注入的 artifactId（<required_inputs artifactId="...">）
  await expect(page.getByText(/Mock 子任务已完成，上游产物 art_/)).toBeVisible({ timeout: 30_000 })

  // 聚合收尾
  await expect(
    page.getByText('编排完成：子任务已按计划执行完毕，各任务状态见上方调度卡。'),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('2 / 2')).toBeVisible()
})
