import { statSync } from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

/**
 * 产物链路 E2E：MockAdapter 的「产物」脚本会真调 write_artifact，
 * 因此这条用例覆盖 write_artifact → artifact.create → artifact_ref 卡片 → 预览 → 导出。
 */

const MOCK_AGENT = 'E2E Mock'
const DECK_TITLE = 'Mock PPT 演示'
const ARTIFACT_PROMPT = '生成一份 PPT 产物'

async function createChatAndProduceArtifact(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '新建对话' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button').filter({ hasText: MOCK_AGENT }).first().click()
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect(dialog).toBeHidden()

  const input = page.getByTestId('composer-input')
  await input.fill(ARTIFACT_PROMPT)
  await input.press('Enter')

  const card = page.getByRole('button', { name: /点击预览/ })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText(DECK_TITLE)
  return card
}

test('产物：agent 生成 ppt → 消息里出现产物卡片 → 打开预览', async ({ page }) => {
  const card = await createChatAndProduceArtifact(page)
  await card.click()

  await expect(page.getByTitle('关闭预览')).toBeVisible()
  // 幻灯片分页：2 页，可翻到第 2 页
  await expect(page.getByText('1 / 2')).toBeVisible()
  await page.getByTitle('下一页').click()
  await expect(page.getByText('2 / 2')).toBeVisible()
  await expect(page.getByText('这条链路覆盖了什么')).toBeVisible()
})

test('产物：从预览面板导出真 .pptx', async ({ page }) => {
  const card = await createChatAndProduceArtifact(page)
  await card.click()

  const exportLink = page.getByTitle('下载可编辑 .pptx')
  await expect(exportLink).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await exportLink.click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/\.pptx$/)
  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  expect(statSync(filePath as string).size).toBeGreaterThan(1000)
})

// openspec/changes/enhance-ppt-design-dsl 2.4：长文本不能悄悄被裁掉 ——
// 预览必须给出「本页内容超出画布」的提示，而不是让用户以为导出是完整的。
test('产物：超长幻灯片在预览里显示溢出提示', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建对话' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button').filter({ hasText: MOCK_AGENT }).first().click()
  await dialog.getByRole('button', { name: '创建' }).click()
  await expect(dialog).toBeHidden()

  const input = page.getByTestId('composer-input')
  await input.fill('生成一份内容超长的 PPT')
  await input.press('Enter')

  const card = page.getByRole('button', { name: /点击预览/ })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  await expect(page.getByText('1 / 2')).toBeVisible()
  await page.getByTitle('下一页').click()
  await expect(page.getByText('2 / 2')).toBeVisible()
  await expect(page.getByText('本页内容超出画布，导出会被截断')).toBeVisible()

  // 回到第 1 页不应残留上一页的结论
  await page.getByTitle('上一页').click()
  await expect(page.getByText('1 / 2')).toBeVisible()
  await expect(page.getByText('本页内容超出画布，导出会被截断')).toBeHidden()
})
