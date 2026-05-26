export type ToneLabel = 'neutral' | 'rude' | 'thanks' | 'urgent'

export const TONE_CONFIG: Record<ToneLabel, {
  ru: string
  emoji: string
  variant: 'success' | 'muted' | 'warning' | 'danger'
}> = {
  thanks:  { ru: 'Благодарит', emoji: '😊', variant: 'success' },
  neutral: { ru: 'Спокойно',   emoji: '😐', variant: 'muted'   },
  rude:    { ru: 'Недоволен',  emoji: '😠', variant: 'warning' },
  urgent:  { ru: 'Срочно',     emoji: '🚨', variant: 'danger'  },
}

const VALID_TONES: ToneLabel[] = ['neutral', 'rude', 'thanks', 'urgent']

export function isToneLabel(v: unknown): v is ToneLabel {
  return typeof v === 'string' && (VALID_TONES as string[]).includes(v)
}

export function shouldAlertManager(tone: ToneLabel): boolean {
  return tone === 'rude' || tone === 'urgent'
}

export function shouldBypassCooldown(tone: ToneLabel): boolean {
  return tone === 'urgent'
}
