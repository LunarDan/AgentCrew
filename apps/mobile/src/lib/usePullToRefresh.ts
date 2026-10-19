import { useEffect, useRef } from "react"

/** Trigger onRefresh when the user pulls down past a threshold while scrolled to the top. */
export function usePullToRefresh(onRefresh: () => void, enabled: boolean) {
  // 轮询会频繁重渲染；监听器不能跟着回调重建，否则手势进行到一半就被重置
  const callbackRef = useRef(onRefresh)
  useEffect(() => {
    callbackRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    if (!enabled) return

    let startY = 0
    let pulling = false
    const threshold = 72

    function handleStart(event: TouchEvent) {
      if (window.scrollY <= 0 && event.touches.length === 1) {
        startY = event.touches[0].clientY
        pulling = true
      } else {
        pulling = false
      }
    }

    function handleMove(event: TouchEvent) {
      if (!pulling) return
      const delta = event.touches[0].clientY - startY
      if (delta > threshold) {
        pulling = false
        callbackRef.current()
      }
    }

    function handleEnd() {
      pulling = false
    }

    window.addEventListener("touchstart", handleStart, { passive: true })
    window.addEventListener("touchmove", handleMove, { passive: true })
    window.addEventListener("touchend", handleEnd, { passive: true })
    return () => {
      window.removeEventListener("touchstart", handleStart)
      window.removeEventListener("touchmove", handleMove)
      window.removeEventListener("touchend", handleEnd)
    }
  }, [enabled])
}
