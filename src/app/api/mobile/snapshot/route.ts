import type { NextRequest } from 'next/server'

import { mobileJson, mobileOptions } from '@/server/mobile-cors'
import { mobileErrorJson } from '@/server/mobile-errors'
import { requireMobileAuth } from '@/server/mobile-auth'
import { getMobileSnapshot } from '@/server/mobile-service'

export const OPTIONS = mobileOptions

export async function GET(req: NextRequest) {
  const authError = await requireMobileAuth(req)
  if (authError) return authError

  try {
    return mobileJson(req, await getMobileSnapshot())
  } catch (err) {
    return mobileErrorJson(req, err, 'snapshot')
  }
}
