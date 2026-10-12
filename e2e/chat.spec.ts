import { expect, test, type Page } from '@playwright/test'

const MOCK_AGENT = 'E2E Mock'

async function createSingleChat(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '新建对话' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button').filter({ hasText: MOCK_AGENT }).first().click()
  await expect(dialog.getByText(/将创建单聊/)).toBeVisible()
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect(dialog).toBeHidden()
}

const lastCompleteAgentMsg = (page: Page) =>
  page.locator('[data-role="agent"][data-status="complete"]').last()

test('单聊：发「你好」→ mock 流式回复 → 完成', async ({ page }) => {
  await createSingleChat(page)
  const input = page.getByTestId('composer-input')
  await input.fill('你好')
  await input.press('Enter')

  const msg = lastCompleteAgentMsg(page)
  await expect(msg).toBeVisible({ timeout: 30_000 })
  await expect(msg).toContainText('我是 Mock Agent')
})

test('单聊：发「写代码」→ 回复含代码块', async ({ page }) => {
  await createSingleChat(page)
  const input = page.getByTestId('composer-input')
  await input.fill('写代码')
  await input.press('Enter')

  const msg = lastCompleteAgentMsg(page)
  await expect(msg).toBeVisible({ timeout: 30_000 })
  await expect(msg).toContainText('React 计数器')
  await expect(msg.locator('pre')).toBeVisible()
})

// 回归 F1：part.start 的索引曾覆盖已被 push 的 tool_use 槽位，工具卡片在文本到达后消失，
// 且因为 parts 是整体 JSON 落库，刷新也救不回来。Mock 的 TOOL_SCRIPT 正是这个形状。
test('单聊：工具调用之后的文本不覆盖工具卡片（F1 回归）', async ({ page }) => {
  await createSingleChat(page)
  const input = page.getByTestId('composer-input')
  await input.fill('执行任务')
  await input.press('Enter')

  const msg = lastCompleteAgentMsg(page)
  await expect(msg).toBeVisible({ timeout: 30_000 })
  await expect(msg).toContainText('我先调用工具收集信息')
  await expect(msg).toContainText('已读取产物信息')
  await expect(msg.getByRole('button', { name: /读取产物/ })).toBeVisible()

  // 刷新后前端从 DB 重读 parts，不再有事件流可以兜底
  await page.reload()
  await page.getByRole('button', { name: /单聊 · 1 位 Agent/ }).first().click()
  const restored = lastCompleteAgentMsg(page)
  await expect(restored).toBeVisible({ timeout: 30_000 })
  await expect(restored.getByRole('button', { name: /读取产物/ })).toBeVisible()
  await expect(restored).toContainText('已读取产物信息')
})

test('单聊：重新生成最后一条回复', async ({ page }) => {
  await createSingleChat(page)
  const input = page.getByTestId('composer-input')
  await input.fill('你好')
  await input.press('Enter')
  await expect(lastCompleteAgentMsg(page)).toBeVisible({ timeout: 30_000 })

  const msg = lastCompleteAgentMsg(page)
  await msg.hover()
  await msg.getByTitle(/重新生成/).click()

  await expect(lastCompleteAgentMsg(page)).toContainText('我是 Mock Agent', { timeout: 30_000 })
})
