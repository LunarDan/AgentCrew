export interface DeployCommandIntent {
  artifactId?: string
}

const DEPLOY_COMMAND_RE = /^(?:\/deploy|部署|发布|上线)(?:\s+(art_[0-9A-Za-z]+))?$/i

export function parseDeployCommand(content: string): DeployCommandIntent | null {
  const trimmed = content.trim()
  const match = DEPLOY_COMMAND_RE.exec(trimmed)
  if (!match) return null
  return match[1] ? { artifactId: match[1] } : {}
}
