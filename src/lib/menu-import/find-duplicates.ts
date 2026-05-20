// Чистая функция — обнаружение возможных дублей-блюд в импорте.
// Применяется на клиенте (без БД, поверх уже сериализованных dishes).
//
// Две стратегии:
//  1) одинаковый correctedName (LLM почему-то не объединил, например двойной ввод);
//  2) AI сам пометил critical в correctionNote — там часто фраза «возможно то же блюдо
//     что 'XXX'» (см. промпт recipe-generator, правило 14). Ловим упоминание имени
//     другого блюда внутри correctionNote.

export interface DuplicateCandidate {
  id: string
  correctedName: string
  correctionLevel: string | null
}

export interface DuplicateGroup {
  key: string // стабильный ключ группы (для React-keys)
  reason: string
  dishes: DuplicateCandidate[]
}

interface InputDish {
  id: string
  correctedName: string | null
  name: string
  originalName: string | null
  correctionLevel: string | null
  correctionNote: string | null
}

const MIN_PHRASE_LEN = 6 // ниже — слишком много ложных срабатываний на коротких словах

export function findDuplicateCandidates(dishes: InputDish[]): DuplicateGroup[] {
  const norm = dishes.map((d) => ({
    id: d.id,
    displayName: d.correctedName ?? d.name,
    correctionLevel: d.correctionLevel,
    correctionNote: d.correctionNote,
  }))

  const groups: DuplicateGroup[] = []
  const seenKeys = new Set<string>()

  // (1) Группировка по одинаковому correctedName/name.
  const byName = new Map<string, DuplicateCandidate[]>()
  for (const d of norm) {
    const key = d.displayName.trim().toLowerCase()
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key)!.push({
      id: d.id,
      correctedName: d.displayName,
      correctionLevel: d.correctionLevel,
    })
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue
    const groupKey = list.map((x) => x.id).sort().join('|')
    if (seenKeys.has(groupKey)) continue
    seenKeys.add(groupKey)
    groups.push({
      key: groupKey,
      reason: `Одинаковое название: «${list[0].correctedName}»`,
      dishes: list,
    })
  }

  // (2) Сканируем correctionNote на упоминание имени другого блюда.
  // Берём AI-помеченные (level=critical чаще всего, но не ограничиваемся).
  for (const a of norm) {
    if (!a.correctionNote) continue
    const note = a.correctionNote.toLowerCase()
    for (const b of norm) {
      if (a.id === b.id) continue
      const bName = b.displayName.trim()
      if (bName.length < MIN_PHRASE_LEN) continue
      if (!note.includes(bName.toLowerCase())) continue

      const dishesInGroup: DuplicateCandidate[] = [
        { id: a.id, correctedName: a.displayName, correctionLevel: a.correctionLevel },
        { id: b.id, correctedName: b.displayName, correctionLevel: b.correctionLevel },
      ]
      const groupKey = dishesInGroup.map((x) => x.id).sort().join('|')
      if (seenKeys.has(groupKey)) continue
      seenKeys.add(groupKey)

      const snippet = a.correctionNote.length > 120
        ? a.correctionNote.slice(0, 117) + '…'
        : a.correctionNote
      groups.push({
        key: groupKey,
        reason: `AI пометил возможный дубль: ${snippet}`,
        dishes: dishesInGroup,
      })
    }
  }

  return groups
}
