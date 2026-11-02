import { AsyncLocalStorage } from 'node:async_hooks'

export const maxGroupContext = new AsyncLocalStorage<{
  chatId: string
  senderId: string
  senderName: string
}>()
