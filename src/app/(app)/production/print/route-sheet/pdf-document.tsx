import path from 'node:path'
import { Document, Page, View, Text, StyleSheet, Font } from '@react-pdf/renderer'
import type { MealType, PackagingType } from '@prisma/client'
import {
  type RouteSheetRow,
  groupRouteSheetRows,
} from '@/lib/route-sheet/build-rows'

// PT Sans (OFL) — кириллица. Та же регистрация, что и в upd-pdf-document.tsx:
// public/ копируется в bundle Vercel-функции, process.cwd() = корень функции.
// Italic НЕ зарегистрирован — fontStyle:'italic' использовать нельзя.
const FONT_DIR = path.join(process.cwd(), 'public', 'fonts', 'pt-sans')
Font.register({
  family: 'PT Sans',
  fonts: [
    { src: path.join(FONT_DIR, 'PTSans-Regular.ttf') },
    { src: path.join(FONT_DIR, 'PTSans-Bold.ttf'), fontWeight: 'bold' },
  ],
})
Font.registerHyphenationCallback((word) => [word])

const MEAL_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

const PACKAGING_LABELS: Record<PackagingType, string> = {
  INDIVIDUAL: 'Порц.',
  BULK: 'Общий',
}

// Ширины колонок (сумма = 100%). Альбомная ориентация A4.
const COL = {
  no: '4%',
  client: '17%',
  address: '22%',
  contact: '12%',
  phone: '11%',
  portions: '6%',
  meal: '8%',
  packaging: '7%',
  notes: '13%',
} as const

const styles = StyleSheet.create({
  page: {
    fontFamily: 'PT Sans',
    fontSize: 8,
    color: '#000',
    paddingTop: 20,
    paddingBottom: 28,
    paddingHorizontal: 18,
  },
  header: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  groupTitle: {
    fontSize: 9,
    fontWeight: 'bold',
    backgroundColor: '#eee',
    padding: 3,
    marginTop: 6,
    marginBottom: 1,
  },
  table: {
    borderTopWidth: 0.75,
    borderLeftWidth: 0.75,
    borderRightWidth: 0.75,
    borderColor: '#000',
  },
  thRow: {
    flexDirection: 'row',
    backgroundColor: '#f3f3f3',
    borderBottomWidth: 0.75,
    borderColor: '#000',
  },
  th: {
    fontSize: 7.5,
    fontWeight: 'bold',
    padding: 3,
    borderRightWidth: 0.5,
    borderColor: '#000',
    textAlign: 'center',
  },
  thLast: {
    fontSize: 7.5,
    fontWeight: 'bold',
    padding: 3,
    textAlign: 'center',
  },
  tdRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: '#000',
  },
  td: {
    fontSize: 8,
    padding: 3,
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  tdLast: {
    fontSize: 8,
    padding: 3,
  },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  footer: {
    fontSize: 9,
    fontWeight: 'bold',
    marginTop: 8,
  },
})

export interface RouteSheetPdfData {
  /** Дата доставки в формате DD.MM.YYYY (для заголовка). */
  dateLabel: string
  rows: RouteSheetRow[]
}

function HeaderRow() {
  return (
    <View style={styles.thRow}>
      <Text style={[styles.th, { width: COL.no }]}>№</Text>
      <Text style={[styles.th, { width: COL.client }]}>Клиент</Text>
      <Text style={[styles.th, { width: COL.address }]}>Адрес</Text>
      <Text style={[styles.th, { width: COL.contact }]}>Контакт</Text>
      <Text style={[styles.th, { width: COL.phone }]}>Телефон</Text>
      <Text style={[styles.th, { width: COL.portions }]}>Порций</Text>
      <Text style={[styles.th, { width: COL.meal }]}>Тип</Text>
      <Text style={[styles.th, { width: COL.packaging }]}>Упаковка</Text>
      <Text style={[styles.thLast, { width: COL.notes }]}>Пометки</Text>
    </View>
  )
}

function Row({ row }: { row: RouteSheetRow }) {
  const noteParts: string[] = []
  if (row.tags.length > 0) noteParts.push(row.tags.join(', '))
  if (row.notes) noteParts.push(row.notes)
  const notes = noteParts.join(' · ')

  return (
    <View style={styles.tdRow} wrap={false}>
      <Text style={[styles.td, styles.center, { width: COL.no }]}>{row.index}</Text>
      <Text style={[styles.td, { width: COL.client }]}>{row.clientName}</Text>
      <Text style={[styles.td, { width: COL.address }]}>
        {row.locationName ? `${row.locationName}, ` : ''}
        {row.locationAddress}
      </Text>
      <Text style={[styles.td, { width: COL.contact }]}>{row.contactName ?? '—'}</Text>
      <Text style={[styles.td, { width: COL.phone }]}>{row.contactPhone ?? '—'}</Text>
      <Text style={[styles.td, styles.right, { width: COL.portions }]}>{row.portions}</Text>
      <Text style={[styles.td, styles.center, { width: COL.meal }]}>
        {MEAL_LABELS[row.mealType]}
      </Text>
      <Text style={[styles.td, styles.center, { width: COL.packaging }]}>
        {PACKAGING_LABELS[row.packaging]}
      </Text>
      <Text style={[styles.tdLast, { width: COL.notes }]}>{notes || '—'}</Text>
    </View>
  )
}

export function RouteSheetPdfDocument({ dateLabel, rows }: RouteSheetPdfData) {
  const groups = groupRouteSheetRows(rows)
  const totalOrders = rows.length
  const totalPortions = rows.reduce((s, r) => s + r.portions, 0)

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.header}>Маршрутный лист на {dateLabel}</Text>

        {groups.map((group) => (
          <View key={group.windowLabel} wrap={false}>
            <Text style={styles.groupTitle}>Окно доставки: {group.windowLabel}</Text>
            <View style={styles.table}>
              <HeaderRow />
              {group.rows.map((row) => (
                <Row key={row.orderId} row={row} />
              ))}
            </View>
          </View>
        ))}

        <Text style={styles.footer}>
          Итого: {totalOrders} заказов, {totalPortions} порций
        </Text>
      </Page>
    </Document>
  )
}
