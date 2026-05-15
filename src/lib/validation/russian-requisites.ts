// Валидаторы российских реквизитов с проверкой контрольных сумм.
// Критичны: бракованные реквизиты в УПД невозможно потом исправить «незаметно».

/**
 * ИНН: 10 цифр (юрлица) или 12 цифр (ИП / физлица). Контрольная сумма по ФНС.
 */
export function validateInn(inn: string): boolean {
  if (!/^\d+$/.test(inn)) return false
  if (inn.length !== 10 && inn.length !== 12) return false

  const digits = inn.split('').map(Number)

  if (inn.length === 10) {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    let sum = 0
    for (let i = 0; i < 9; i++) sum += digits[i] * weights[i]
    const ks = (sum % 11) % 10
    return digits[9] === ks
  }

  // length === 12
  const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
  const w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]

  let s1 = 0
  for (let i = 0; i < 10; i++) s1 += digits[i] * w1[i]
  const ks1 = (s1 % 11) % 10
  if (digits[10] !== ks1) return false

  let s2 = 0
  for (let i = 0; i < 11; i++) s2 += digits[i] * w2[i]
  const ks2 = (s2 % 11) % 10
  return digits[11] === ks2
}

/**
 * ОГРН: 13 цифр (юрлицо), либо ОГРНИП: 15 цифр.
 * BigInt обязателен — 15-значное число не вмещается в IEEE-754 без потери точности.
 */
export function validateOgrn(ogrn: string): boolean {
  if (!/^\d+$/.test(ogrn)) return false

  // BigInt(...) вместо литералов вида 11n, т.к. tsconfig target = ES2017.
  if (ogrn.length === 13) {
    const num = BigInt(ogrn.slice(0, 12))
    let ks = num % BigInt(11)
    if (ks === BigInt(10)) ks = BigInt(0)
    return ogrn[12] === String(ks)
  }

  if (ogrn.length === 15) {
    const num = BigInt(ogrn.slice(0, 14))
    const ks = num % BigInt(13)
    // Контрольная цифра ОГРНИП = (num % 13) % 10
    return ogrn[14] === String(ks % BigInt(10))
  }

  return false
}

/**
 * БИК: 9 цифр, начинается с '04' (Россия). Дополнительные проверки структурных
 * полей опускаем — для пилота этой жёсткости достаточно, контрольной суммы у
 * БИК нет.
 */
export function validateBic(bic: string): boolean {
  return /^04\d{7}$/.test(bic)
}

/**
 * Контрольная сумма банковского счёта (расчётного или корр.) по 153-И ЦБ РФ.
 *
 * Берём 3 цифры из БИК (последние; если они === '000' — первые), конкатенируем
 * с 20-значным счётом → 23 цифры. Умножаем поэлементно на веса 7,1,3,7,1,3...
 * Сумма % 10 === 0 → счёт валиден.
 *
 * (digit*weight) mod 10 ≡ ((digit*weight mod 10)) mod 10 — обе формулы дают
 * один ответ, потому что (Σ ai) mod n = (Σ (ai mod n)) mod n.
 */
export function validateAccount(account: string, bic: string): boolean {
  if (!/^\d{20}$/.test(account)) return false
  if (!/^\d{9}$/.test(bic)) return false

  const last3 = bic.slice(6, 9)
  const first3 = bic.slice(0, 3)
  const bicPart = last3 === '000' ? first3 : last3

  const full = bicPart + account
  if (full.length !== 23) return false

  const weights = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1]
  let sum = 0
  for (let i = 0; i < 23; i++) sum += Number(full[i]) * weights[i]
  return sum % 10 === 0
}

/**
 * Контрольная сумма корреспондентского счёта.
 *
 * Корр.счёт ведётся в ЦБ РФ, а не в самом банке. Префикс — 3 цифры:
 * '0' + разряды 5-6 БИК (код территории ЦБ). Итого 3 + 20 = 23 цифры,
 * веса 7-1-3 циклически. Формула подобрана и подтверждена на реальных
 * корр.счетах Т-Банка и Альфа-Банка.
 */
export function validateCorrAccount(corrAccount: string, bic: string): boolean {
  if (!/^\d{20}$/.test(corrAccount)) return false
  if (!/^\d{9}$/.test(bic)) return false

  const prefix = '0' + bic.slice(4, 6) // 3 цифры
  const full = prefix + corrAccount // 23 цифры

  const weights = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1]
  let sum = 0
  for (let i = 0; i < full.length; i++) sum += Number(full[i]) * weights[i]
  return sum % 10 === 0
}
