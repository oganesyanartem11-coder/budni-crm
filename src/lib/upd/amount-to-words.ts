// Сумма прописью для УПД: "Двадцать тысяч рублей 00 копеек".
// Копейки выводятся двумя цифрами, не прописью. Поддержка до миллиардов.

type Gender = 'm' | 'f'

const UNITS_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const UNITS_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
]
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']

// Преобразует число 0..999 в слова. gender определяет род единиц (для тысяч — женский).
function tripletToWords(n: number, gender: Gender): string {
  if (n === 0) return ''
  const parts: string[] = []
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (h > 0) parts.push(HUNDREDS[h])
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10])
  } else {
    const t = Math.floor(rest / 10)
    const u = rest % 10
    if (t > 0) parts.push(TENS[t])
    if (u > 0) parts.push((gender === 'f' ? UNITS_F : UNITS_M)[u])
  }
  return parts.join(' ')
}

// Падежная форма по последним двум цифрам триплета. forms = [1, 2-4, 5+].
function pluralForm(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100
  if (abs >= 11 && abs <= 14) return forms[2]
  const last = abs % 10
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function amountToWords(rubles: number, kopecks: number): string {
  const r = Math.trunc(rubles)
  const k = Math.trunc(kopecks)
  const kopStr = String(Math.abs(k)).padStart(2, '0')
  const rubleForm = pluralForm(r, ['рубль', 'рубля', 'рублей'])

  if (r === 0) {
    return `Ноль ${rubleForm} ${kopStr} ${pluralForm(k, ['копейка', 'копейки', 'копеек'])}`
  }

  // Разбиваем на триплеты: единицы (муж.), тысячи (жен.), миллионы (муж.), миллиарды (муж.)
  const billions = Math.floor(r / 1_000_000_000) % 1000
  const millions = Math.floor(r / 1_000_000) % 1000
  const thousands = Math.floor(r / 1000) % 1000
  const units = r % 1000

  const parts: string[] = []

  if (billions > 0) {
    parts.push(tripletToWords(billions, 'm'))
    parts.push(pluralForm(billions, ['миллиард', 'миллиарда', 'миллиардов']))
  }
  if (millions > 0) {
    parts.push(tripletToWords(millions, 'm'))
    parts.push(pluralForm(millions, ['миллион', 'миллиона', 'миллионов']))
  }
  if (thousands > 0) {
    parts.push(tripletToWords(thousands, 'f'))
    parts.push(pluralForm(thousands, ['тысяча', 'тысячи', 'тысяч']))
  }
  if (units > 0) {
    parts.push(tripletToWords(units, 'm'))
  }

  const rublesText = parts.filter(Boolean).join(' ')
  const kopForm = pluralForm(k, ['копейка', 'копейки', 'копеек'])
  return capitalize(`${rublesText} ${rubleForm} ${kopStr} ${kopForm}`)
}
