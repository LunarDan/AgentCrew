/**
 * Next.js 服务启动钩子。只在 Node runtime 执行一次，用于收口上次进程异常退出
 * 留下的 queued/running run（详见 specs/08-db-schema.md「进程重启收口」）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // 构建阶段也会加载本文件；此时不能把开发库里的真实 run 标成失败。
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const [{ sqlite }, { reconcileInterruptedRuns }] = await Promise.all([
    import('@/db/client'),
    import('@/db/bootstrap'),
  ])
  reconcileInterruptedRuns(sqlite)
}
